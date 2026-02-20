/**
 * Payment Service — handles PROCESS_PAYMENT and REFUND_PAYMENT saga commands.
 *
 * Listens on Kafka topic: saga-payment-commands
 * Replies to Kafka topic: saga-replies
 */
import Fastify from 'fastify';
import { Kafka, logLevel, Consumer, Producer } from 'kafkajs';
import { Pool } from 'pg';
import { z } from 'zod';

const app = Fastify({ logger: true });
const REPLY_TOPIC = 'saga-replies';
const COMMAND_TOPIC = 'saga-payment-commands';

const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_RETRIES = parseInt(process.env.KAFKA_HANDLER_MAX_RETRIES || '5', 10);
const RETRY_BASE_MS = parseInt(process.env.KAFKA_HANDLER_RETRY_BASE_MS || '250', 10);

const SagaCommandSchema = z.object({
  sagaId: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  command: z.string().min(1),
  idempotencyKey: z.string().min(1),
  payload: z.record(z.any()),
  correlationId: z.string().optional().default(''),
  replyTopic: z.string().optional().default(REPLY_TOPIC),
});

const db = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://payments_user:payments_pass@localhost:5433/payments_db',
});

let kafkaConsumer: Consumer | null = null;
let kafkaProducer: Producer | null = null;
let kafkaReady = false;
let dbReady = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextOffset(offset: string): string {
  return (BigInt(offset) + 1n).toString();
}

async function sendToDlq(topic: string, rawValue: string, error: unknown): Promise<void> {
  if (!kafkaProducer) return;
  const dlqTopic = process.env.DLQ_TOPIC || `${topic}.dlq`;
  await kafkaProducer.send({
    topic: dlqTopic,
    messages: [
      {
        key: 'payment-service',
        value: JSON.stringify({
          failedAt: new Date().toISOString(),
          sourceTopic: topic,
          error: String(error),
          raw: rawValue,
        }),
      },
    ],
  });
}

async function initDb(): Promise<void> {
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS payments (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id        UUID NOT NULL,
      saga_id         UUID NOT NULL,
      status          VARCHAR(50) NOT NULL DEFAULT 'PENDING',
      amount          NUMERIC(12,2) NOT NULL,
      currency        VARCHAR(3) NOT NULL DEFAULT 'USD',
      payment_method  VARCHAR(100),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS processed_saga_steps (
      idempotency_key VARCHAR(200) PRIMARY KEY,
      result          JSONB NOT NULL,
      processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  dbReady = true;
}

// ── Domain logic ──────────────────────────────────────────────────

async function processPayment(payload: Record<string, unknown>, idempotencyKey: string) {
  const existing = await db.query(
    'SELECT result FROM processed_saga_steps WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  if (existing.rows.length > 0) return existing.rows[0].result;

  const { orderId, sagaId, amount, currency = 'USD', paymentMethod } = payload as {
    orderId: string;
    sagaId: string;
    amount: number;
    currency: string;
    paymentMethod: string;
  };

  // Simulate payment processing (replace with Stripe/Adyen SDK call)
  const chargeSucceeds = Math.random() > 0.05; // 95% success rate
  if (!chargeSucceeds) throw new Error('Payment declined by processor');

  const result = await db.query(
    `INSERT INTO payments (order_id, saga_id, status, amount, currency, payment_method)
     VALUES ($1, $2, 'PROCESSED', $3, $4, $5)
     RETURNING id, status, amount`,
    [orderId, sagaId, amount, currency, paymentMethod],
  );

  const row = result.rows[0] as { id: string; status: string; amount: string };
  const stepResult = { paymentId: row.id, status: row.status, amount: parseFloat(row.amount) };

  await db.query(
    'INSERT INTO processed_saga_steps (idempotency_key, result) VALUES ($1, $2)',
    [idempotencyKey, JSON.stringify(stepResult)],
  );
  return stepResult;
}

async function refundPayment(payload: Record<string, unknown>, idempotencyKey: string) {
  const existing = await db.query(
    'SELECT result FROM processed_saga_steps WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  if (existing.rows.length > 0) return existing.rows[0].result;

  const { paymentId } = payload as { paymentId: string };

  await db.query(
    `UPDATE payments SET status = 'REFUNDED', updated_at = NOW() WHERE id = $1`,
    [paymentId],
  );

  const stepResult = { paymentId, status: 'REFUNDED', refundedAt: new Date().toISOString() };
  await db.query(
    'INSERT INTO processed_saga_steps (idempotency_key, result) VALUES ($1, $2)',
    [idempotencyKey, JSON.stringify(stepResult)],
  );
  return stepResult;
}

// ── Kafka ─────────────────────────────────────────────────────────

async function startKafka(): Promise<void> {
  const kafka = new Kafka({
    clientId: 'payment-service',
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    logLevel: logLevel.WARN,
  });

  const consumer = kafka.consumer({ groupId: 'payment-service-group' });
  const producer = kafka.producer({ idempotent: true, allowAutoTopicCreation: true });

  await consumer.connect();
  await producer.connect();
  kafkaConsumer = consumer;
  kafkaProducer = producer;
  kafkaReady = true;

  await consumer.subscribe({ topic: COMMAND_TOPIC, fromBeginning: false });

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
          const parsedJson = JSON.parse(rawValue) as unknown;
          const msg = SagaCommandSchema.parse(parsedJson);

          let success = false;
          let result: Record<string, unknown> = {};
          let error = '';

          if (msg.command === 'PROCESS_PAYMENT') {
            result = await processPayment(msg.payload, msg.idempotencyKey);
            success = true;
          } else if (msg.command === 'REFUND_PAYMENT') {
            result = await refundPayment(msg.payload, msg.idempotencyKey);
            success = true;
          } else {
            error = `Unknown command: ${msg.command}`;
          }

          await producer.send({
            topic: msg.replyTopic || REPLY_TOPIC,
            messages: [
              {
                key: msg.sagaId,
                value: JSON.stringify({
                  sagaId: msg.sagaId,
                  stepIndex: msg.stepIndex,
                  success,
                  result,
                  error,
                  correlationId: msg.correlationId,
                }),
              },
            ],
          });

          await commit();
          return;
        } catch (err) {
          if (attempt < MAX_RETRIES) {
            const backoff = RETRY_BASE_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 50);
            app.log.warn({ err, attempt, backoff }, 'Failed to process message, retrying');
            await sleep(backoff);
            continue;
          }

          app.log.error({ err }, 'Failed to process message, sending to DLQ');
          await sendToDlq(topic, rawValue, err);
          await commit();
          return;
        }
      }
    },
  });

  app.log.info('Payment service Kafka consumer started');
}

app.get('/live', async () => ({ status: 'ok', service: 'payment-service' }));

app.get('/ready', async (req, reply) => {
  const checks: Record<string, unknown> = { kafka: kafkaReady, db: false };
  try {
    await db.query('SELECT 1');
    checks.db = true;
    dbReady = true;
  } catch {
    checks.db = false;
    dbReady = false;
  }
  const ok = Boolean(checks.kafka) && Boolean(checks.db);
  if (!ok) return reply.code(503).send({ status: 'not-ready', service: 'payment-service', checks });
  return { status: 'ok', service: 'payment-service', checks };
});

app.get('/health', async (req, reply) => {
  const res = await app.inject({ method: 'GET', url: '/ready' });
  return reply.code(res.statusCode).send(res.json());
});

async function main(): Promise<void> {
  await initDb();
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
    await db.end();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
