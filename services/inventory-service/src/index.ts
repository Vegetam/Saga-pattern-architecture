/**
 * Inventory Service — handles RESERVE_INVENTORY and RELEASE_INVENTORY saga commands.
 *
 * Listens on Kafka topic: saga-inventory-commands
 * Replies to Kafka topic: saga-replies
 */
import Fastify from 'fastify';
import { Kafka, logLevel, Consumer, Producer } from 'kafkajs';
import { Pool } from 'pg';
import { z } from 'zod';

const app = Fastify({ logger: true });
const REPLY_TOPIC = 'saga-replies';
const COMMAND_TOPIC = 'saga-inventory-commands';

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
  connectionString: process.env.DATABASE_URL || 'postgresql://inventory_user:inventory_pass@localhost:5435/inventory_db',
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
        key: 'inventory-service',
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
    CREATE TABLE IF NOT EXISTS stock (
      product_id    UUID PRIMARY KEY,
      quantity      INT NOT NULL DEFAULT 0,
      reserved      INT NOT NULL DEFAULT 0,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reservations (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      saga_id       UUID NOT NULL,
      product_id    UUID NOT NULL,
      quantity      INT NOT NULL,
      status        VARCHAR(50) NOT NULL DEFAULT 'RESERVED',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS processed_saga_steps (
      idempotency_key VARCHAR(200) PRIMARY KEY,
      result          JSONB NOT NULL,
      processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Seed some stock
    INSERT INTO stock (product_id, quantity, reserved)
    VALUES
      ('a0000000-0000-0000-0000-000000000001', 100, 0),
      ('a0000000-0000-0000-0000-000000000002', 50, 0),
      ('a0000000-0000-0000-0000-000000000003', 200, 0)
    ON CONFLICT DO NOTHING;
  `);
  dbReady = true;
}

async function reserveInventory(payload: Record<string, unknown>, idempotencyKey: string) {
  const existing = await db.query(
    'SELECT result FROM processed_saga_steps WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  if (existing.rows.length > 0) return existing.rows[0].result;

  const { sagaId, items } = payload as {
    sagaId: string;
    items: Array<{ productId: string; qty: number }>;
  };

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const reservationIds: string[] = [];

    for (const item of items) {
      // Check and lock the stock row
      const stockRow = await client.query(
        'SELECT quantity, reserved FROM stock WHERE product_id = $1 FOR UPDATE',
        [item.productId],
      );

      if (stockRow.rows.length === 0) {
        throw new Error(`Product ${item.productId} not found`);
      }

      const { quantity, reserved } = stockRow.rows[0] as { quantity: number; reserved: number };
      const available = quantity - reserved;

      if (available < item.qty) {
        throw new Error(
          `Insufficient stock for product ${item.productId}: available=${available}, requested=${item.qty}`,
        );
      }

      // Reserve the stock
      await client.query(
        'UPDATE stock SET reserved = reserved + $1, updated_at = NOW() WHERE product_id = $2',
        [item.qty, item.productId],
      );

      // Create reservation record
      const resRow = await client.query(
        `INSERT INTO reservations (saga_id, product_id, quantity, status)
         VALUES ($1, $2, $3, 'RESERVED') RETURNING id`,
        [sagaId, item.productId, item.qty],
      );
      reservationIds.push((resRow.rows[0] as { id: string }).id);
    }

    await client.query('COMMIT');

    const stepResult = { reservationIds, status: 'RESERVED' };
    await db.query(
      'INSERT INTO processed_saga_steps (idempotency_key, result) VALUES ($1, $2)',
      [idempotencyKey, JSON.stringify(stepResult)],
    );
    return stepResult;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function releaseInventory(payload: Record<string, unknown>, idempotencyKey: string) {
  const existing = await db.query(
    'SELECT result FROM processed_saga_steps WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  if (existing.rows.length > 0) return existing.rows[0].result;

  const { reservationIds } = payload as { reservationIds: string[] };

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    for (const reservationId of reservationIds) {
      const resRow = await client.query(
        `SELECT product_id, quantity FROM reservations WHERE id = $1 AND status = 'RESERVED'`,
        [reservationId],
      );
      if (resRow.rows.length === 0) continue;

      const { product_id, quantity } = resRow.rows[0] as { product_id: string; quantity: number };

      await client.query(
        'UPDATE stock SET reserved = reserved - $1, updated_at = NOW() WHERE product_id = $2',
        [quantity, product_id],
      );
      await client.query(
        `UPDATE reservations SET status = 'RELEASED' WHERE id = $1`,
        [reservationId],
      );
    }

    await client.query('COMMIT');

    const stepResult = { reservationIds, status: 'RELEASED' };
    await db.query(
      'INSERT INTO processed_saga_steps (idempotency_key, result) VALUES ($1, $2)',
      [idempotencyKey, JSON.stringify(stepResult)],
    );
    return stepResult;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Kafka ─────────────────────────────────────────────────────────

async function startKafka(): Promise<void> {
  const kafka = new Kafka({
    clientId: 'inventory-service',
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    logLevel: logLevel.WARN,
  });

  const consumer = kafka.consumer({ groupId: 'inventory-service-group' });
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

          if (msg.command === 'RESERVE_INVENTORY') {
            result = await reserveInventory(msg.payload, msg.idempotencyKey);
            success = true;
          } else if (msg.command === 'RELEASE_INVENTORY') {
            result = await releaseInventory(msg.payload, msg.idempotencyKey);
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
}

app.get('/live', async () => ({ status: 'ok', service: 'inventory-service' }));

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
  if (!ok) return reply.code(503).send({ status: 'not-ready', service: 'inventory-service', checks });
  return { status: 'ok', service: 'inventory-service', checks };
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
