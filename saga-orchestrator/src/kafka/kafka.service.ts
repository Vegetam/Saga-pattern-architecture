import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Kafka, Producer, Consumer, EachMessagePayload, logLevel } from 'kafkajs';

@Injectable()
export class KafkaService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(KafkaService.name);
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly consumers: Consumer[] = [];
  private producerConnected = false;
  private readonly subscriptions = new Set<string>();

  private readonly maxHandlerRetries = parseInt(process.env.KAFKA_HANDLER_MAX_RETRIES || '5', 10);
  private readonly retryBaseMs = parseInt(process.env.KAFKA_HANDLER_RETRY_BASE_MS || '250', 10);

  constructor() {
    this.kafka = new Kafka({
      clientId: process.env.KAFKA_CLIENT_ID || 'saga-orchestrator',
      brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
      logLevel: logLevel.WARN,
      retry: {
        initialRetryTime: 100,
        retries: 8,
      },
    });

    this.producer = this.kafka.producer({
      allowAutoTopicCreation: true,
      idempotent: true, // exactly-once producer semantics
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.producer.connect();
    this.producerConnected = true;
    this.logger.log('Kafka producer connected');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.producer.disconnect();
    this.producerConnected = false;
    for (const consumer of this.consumers) {
      await consumer.disconnect();
    }
    this.logger.log('Kafka disconnected');
  }

  isReady(requiredTopics: string[] = []): boolean {
    if (!this.producerConnected) return false;
    for (const t of requiredTopics) {
      if (!this.subscriptions.has(t)) return false;
    }
    return true;
  }

  /**
   * Publish a message to a Kafka topic.
   * The sagaId (if present in payload) is used as the partition key
   * to guarantee ordering for the same saga.
   */
  async publish(topic: string, payload: Record<string, unknown>): Promise<void> {
    const key = (payload.sagaId as string) ?? undefined;

    await this.producer.send({
      topic,
      messages: [
        {
          key,
          value: JSON.stringify(payload),
          headers: {
            'content-type': 'application/json',
            'produced-at': new Date().toISOString(),
            'idempotency-key': (payload.idempotencyKey as string) ?? '',
          },
        },
      ],
    });

    this.logger.debug(`Published to [${topic}]: ${JSON.stringify(payload).slice(0, 120)}...`);
  }

  /**
   * Subscribe to a topic and invoke handler for each message.
   */
  async subscribe(
    topic: string,
    groupId: string,
    handler: (payload: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    const consumer = this.kafka.consumer({ groupId });
    this.consumers.push(consumer);

    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });

    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic: t, partition, message }: EachMessagePayload) => {
        const rawValue = message.value?.toString();
        const commit = async () => {
          const next = (BigInt(message.offset) + 1n).toString();
          await consumer.commitOffsets([{ topic: t, partition, offset: next }]);
        };

        if (!rawValue) {
          await commit();
          return;
        }

        for (let attempt = 1; attempt <= this.maxHandlerRetries; attempt++) {
          try {
            const parsed = JSON.parse(rawValue) as Record<string, unknown>;
            await handler(parsed);
            await commit();
            return;
          } catch (err) {
            if (attempt < this.maxHandlerRetries) {
              const backoff = this.retryBaseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 50);
              this.logger.warn(`Handler failed for [${t}] attempt ${attempt} — retrying in ${backoff}ms: ${String(err)}`);
              await new Promise((r) => setTimeout(r, backoff));
              continue;
            }

            const dlqTopic = process.env.DLQ_TOPIC || `${t}.dlq`;
            this.logger.error(`Handler failed for [${t}] — sending to DLQ [${dlqTopic}]`, err);
            try {
              await this.producer.send({
                topic: dlqTopic,
                messages: [
                  {
                    key: (parsedKeyFromRaw(rawValue) ?? 'saga-orchestrator') as string,
                    value: JSON.stringify({
                      failedAt: new Date().toISOString(),
                      sourceTopic: t,
                      error: String(err),
                      raw: rawValue,
                    }),
                  },
                ],
              });
            } catch (dlqErr) {
              this.logger.error(`Failed to publish to DLQ [${dlqTopic}]`, dlqErr);
            }
            await commit();
            return;
          }
        }
      },
    });

    this.subscriptions.add(topic);

    this.logger.log(`Subscribed to [${topic}] with group [${groupId}]`);
  }
}

function parsedKeyFromRaw(rawValue: string): string | undefined {
  try {
    const obj = JSON.parse(rawValue) as Record<string, unknown>;
    if (typeof obj.sagaId === 'string') return obj.sagaId;
  } catch {
    // ignore
  }
  return undefined;
}
