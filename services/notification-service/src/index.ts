/**
 * Notification Service — sends emails/SMS on saga events.
 *
 * Listens on Kafka topic: saga-events (SAGA_COMPLETED, SAGA_FAILED)
 * No saga command/reply needed — this is a pure consumer.
 */
import Fastify from 'fastify';
import { Kafka, logLevel, Consumer, Producer } from 'kafkajs';
import { z } from 'zod';

const app = Fastify({ logger: true });

const PORT = parseInt(process.env.PORT || '3000', 10);
const EVENT_TOPIC = process.env.EVENT_TOPIC || 'saga-events';
const MAX_RETRIES = parseInt(process.env.KAFKA_HANDLER_MAX_RETRIES || '5', 10);
const RETRY_BASE_MS = parseInt(process.env.KAFKA_HANDLER_RETRY_BASE_MS || '250', 10);

let kafkaConsumer: Consumer | null = null;
let kafkaProducer: Producer | null = null;
let kafkaReady = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextOffset(offset: string): string {
  return (BigInt(offset) + 1n).toString();
}

const SagaEventSchema = z.object({
  type: z.string().min(1),
  sagaId: z.string().min(1),
  sagaName: z.string().optional(),
  results: z.any().optional(),
});

// ── Notification channels (stubbed — replace with real SDKs) ──────

async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  // Replace with: await sgMail.send({ to, from: 'noreply@example.com', subject, html: body });
  app.log.info(`[EMAIL] To: ${to} | Subject: ${subject}`);
}

async function sendSMS(to: string, message: string): Promise<void> {
  // Replace with: await twilioClient.messages.create({ to, from: process.env.TWILIO_FROM, body: message });
  app.log.info(`[SMS] To: ${to} | Message: ${message}`);
}

// ── Event handlers ────────────────────────────────────────────────

async function handleSagaCompleted(event: Record<string, unknown>): Promise<void> {
  const { sagaId, sagaName, results } = event as {
    sagaId: string;
    sagaName: string;
    results: Record<string, unknown>;
  };

  app.log.info(`Saga COMPLETED [${sagaId}] — sending confirmation`);

  // Extract customer email from step 0 result (order)
  const orderResult = (results['0'] as Record<string, unknown>) ?? {};
  const customerId = orderResult.customerId as string;

  // In a real system, look up customer email from a customer service
  const customerEmail = `customer-${customerId ?? 'unknown'}@example.com`;

  await sendEmail(
    customerEmail,
    '✅ Your order has been confirmed!',
    `<h1>Order Confirmed</h1>
     <p>Your saga <strong>${sagaId}</strong> (${sagaName}) completed successfully.</p>
     <p>Order ID: ${(orderResult.orderId as string) ?? 'N/A'}</p>
     <p>Payment ID: ${((results['1'] as Record<string, unknown>)?.paymentId as string) ?? 'N/A'}</p>`,
  );
}

async function handleSagaFailed(event: Record<string, unknown>): Promise<void> {
  const { sagaId, sagaName } = event as { sagaId: string; sagaName: string };

  app.log.info(`Saga FAILED [${sagaId}] — sending cancellation notice`);

  // In a real system, look up the customer from the saga context
  await sendEmail(
    `customer-saga-${sagaId}@example.com`,
    '❌ Your order could not be processed',
    `<h1>Order Failed</h1>
     <p>Unfortunately, your order (saga <strong>${sagaId}</strong>) could not be completed.</p>
     <p>All charges have been automatically refunded.</p>
     <p>Please try again or contact support.</p>`,
  );
}

// ── Kafka ─────────────────────────────────────────────────────────

async function startKafka(): Promise<void> {
  const kafka = new Kafka({
    clientId: 'notification-service',
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    logLevel: logLevel.WARN,
  });

  const consumer = kafka.consumer({ groupId: 'notification-service-group' });
  const producer = kafka.producer({ idempotent: true, allowAutoTopicCreation: true });

  await consumer.connect();
  await producer.connect();
  kafkaConsumer = consumer;
  kafkaProducer = producer;
  kafkaReady = true;
  await consumer.subscribe({ topic: EVENT_TOPIC, fromBeginning: false });

  await consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message }) => {
      const rawValue = message.value?.toString();
      const commit = async () => {
        await consumer.commitOffsets([{ topic, partition, offset: nextOffset(message.offset) }]);
      };
      if (!rawValue) {
        await commit();
        return;
      }

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const parsed = SagaEventSchema.parse(JSON.parse(rawValue) as unknown);
          const event = parsed as unknown as Record<string, unknown>;
          switch (parsed.type) {
            case 'SAGA_COMPLETED':
              await handleSagaCompleted(event);
              break;
            case 'SAGA_FAILED':
              await handleSagaFailed(event);
              break;
            default:
              app.log.info(`Unhandled event type: ${parsed.type}`);
          }
          await commit();
          return;
        } catch (err) {
          if (attempt < MAX_RETRIES) {
            const backoff = RETRY_BASE_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 50);
            app.log.warn({ err, attempt, backoff }, 'Failed to process event, retrying');
            await sleep(backoff);
            continue;
          }

          const dlqTopic = process.env.DLQ_TOPIC || `${topic}.dlq`;
          try {
            await producer.send({
              topic: dlqTopic,
              messages: [
                {
                  key: 'notification-service',
                  value: JSON.stringify({
                    failedAt: new Date().toISOString(),
                    sourceTopic: topic,
                    error: String(err),
                    raw: rawValue,
                  }),
                },
              ],
            });
          } catch (dlqErr) {
            app.log.error({ dlqErr }, 'Failed to publish DLQ message');
          }
          await commit();
          return;
        }
      }
    },
  });

  app.log.info('Notification service Kafka consumer started');
}

app.get('/live', async () => ({ status: 'ok', service: 'notification-service' }));

app.get('/ready', async (req, reply) => {
  const checks = { kafka: kafkaReady };
  const ok = Boolean(checks.kafka);
  if (!ok) return reply.code(503).send({ status: 'not-ready', service: 'notification-service', checks });
  return { status: 'ok', service: 'notification-service', checks };
});

app.get('/health', async (req, reply) => {
  const res = await app.inject({ method: 'GET', url: '/ready' });
  return reply.code(res.statusCode).send(res.json());
});

async function main(): Promise<void> {
  await startKafka();
  await app.listen({ port: PORT, host: '0.0.0.0' });
}

main().catch((err) => { console.error(err); process.exit(1); });

async function shutdown(signal: string): Promise<void> {
  try {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    if (kafkaConsumer) await kafkaConsumer.disconnect();
    if (kafkaProducer) await kafkaProducer.disconnect();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
