import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KafkaService } from './kafka/kafka.service';
import { RedisService } from './redis/redis.service';
import { SagaEntity, SagaStatus } from './entities/saga.entity';
import { SagaStep } from './SagaOrchestrator';

const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const RETRY_BACKOFF_MS = 1_000;
const LOCK_TTL_MS = 30_000;

@Injectable()
export class StepExecutor {
  private readonly logger = new Logger(StepExecutor.name);

  constructor(
    @InjectRepository(SagaEntity)
    private readonly sagaRepository: Repository<SagaEntity>,
    private readonly kafkaService: KafkaService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Execute a single saga step:
   *  1. Acquire distributed lock (idempotency — prevents duplicate dispatch)
   *  2. Update saga state to RUNNING
   *  3. Publish command to the service's Kafka topic
   *  4. Register a timeout watcher
   */
  async execute(
    saga: SagaEntity,
    step: SagaStep,
    stepIndex: number,
    mergedPayload: Record<string, unknown>,
    sagaName: string,
  ): Promise<void> {
    const idempotencyKey = `saga:${saga.id}:step:${stepIndex}`;
    const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

    // ── Distributed lock — prevent re-execution of the same step ──
    const lockAcquired = await this.redisService.acquireLock(idempotencyKey, LOCK_TTL_MS);
    if (!lockAcquired) {
      this.logger.warn(
        `Step "${step.name}" [${stepIndex}] already in-flight for saga ${saga.id} — skipping duplicate dispatch`,
      );
      return;
    }

    try {
      // ── Update saga current step in DB ──
      await this.sagaRepository.update(
        { id: saga.id },
        {
          currentStepIndex: stepIndex,
          status: SagaStatus.RUNNING,
        },
      );

      // ── Publish command with retry logic ──
      await this.publishWithRetry(
        step,
        stepIndex,
        saga.id,
        sagaName,
        idempotencyKey,
        mergedPayload,
        step.retries ?? DEFAULT_RETRIES,
      );

      // ── Register step timeout in Redis ──
      await this.redisService.setWithTtl(
        `saga:${saga.id}:step:${stepIndex}:timeout`,
        JSON.stringify({ sagaId: saga.id, stepIndex, stepName: step.name }),
        Math.ceil(timeoutMs / 1000),
      );

      this.logger.log(
        `Dispatched step "${step.name}" [${stepIndex}] for saga ${saga.id} (timeout: ${timeoutMs}ms)`,
      );
    } catch (error) {
      // Release lock so a retry can acquire it
      await this.redisService.releaseLock(idempotencyKey);
      this.logger.error(
        `Failed to dispatch step "${step.name}" for saga ${saga.id}`,
        error,
      );
      throw error;
    }
  }

  // ── Private helpers ───────────────────────────────────────────────

  private async publishWithRetry(
    step: SagaStep,
    stepIndex: number,
    sagaId: string,
    sagaName: string,
    idempotencyKey: string,
    payload: Record<string, unknown>,
    retriesLeft: number,
  ): Promise<void> {
    try {
      await this.kafkaService.publish(step.topic, {
        sagaId,
        sagaName,
        stepIndex,
        stepName: step.name,
        command: step.command,
        idempotencyKey,
        payload: { ...payload, sagaId },
        replyTopic: 'saga-replies',
        correlationId: idempotencyKey,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      if (retriesLeft > 0) {
        const backoff = RETRY_BACKOFF_MS * (DEFAULT_RETRIES - retriesLeft + 1);
        this.logger.warn(
          `Kafka publish failed for step "${step.name}" — retrying in ${backoff}ms (${retriesLeft} retries left)`,
        );
        await this.sleep(backoff);
        return this.publishWithRetry(
          step, stepIndex, sagaId, sagaName, idempotencyKey, payload, retriesLeft - 1,
        );
      }
      throw err;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
