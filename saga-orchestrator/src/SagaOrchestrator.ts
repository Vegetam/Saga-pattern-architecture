import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { KafkaService } from './kafka/kafka.service';
import { SagaRepository } from './SagaRepository';
import { SagaEntity, SagaStatus, SagaStepStatus } from './entities/saga.entity';
import { CompensationManager } from './CompensationManager';
import { StepExecutor } from './StepExecutor';
import { SagaStateMachine } from './SagaStateMachine';
import { MetricsService } from './metrics/metrics.service';

// ── Public interfaces ─────────────────────────────────────────────

export interface SagaStep {
  name: string;
  /** Command name sent to the service */
  command: string;
  /** Kafka topic the service listens on */
  topic: string;
  /** Compensation command (reverse of command) */
  compensationCommand?: string;
  /** Kafka topic for compensation */
  compensationTopic?: string;
  /** Per-step timeout in ms (default 30s) */
  timeoutMs?: number;
  /** Max retries for Kafka publish (default 3) */
  retries?: number;
}

export interface SagaDefinition {
  name: string;
  steps: SagaStep[];
  /** Max total saga duration in ms */
  timeoutMs?: number;
}

export interface SagaContext {
  sagaId: string;
  payload: Record<string, unknown>;
  stepResults: Record<string, unknown>;
  currentStepIndex: number;
}

export interface StepReply {
  sagaId: string;
  stepIndex: number;
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
  correlationId: string;
}

// ── Saga Registry ─────────────────────────────────────────────────
// Holds registered saga definitions by name so handleStepReply can
// look them up without needing them passed in at reply time.
const sagaRegistry = new Map<string, SagaDefinition>();

@Injectable()
export class SagaOrchestrator {
  private readonly logger = new Logger(SagaOrchestrator.name);

  constructor(
    private readonly sagaRepository: SagaRepository,
    private readonly kafkaService: KafkaService,
    private readonly compensationManager: CompensationManager,
    private readonly stepExecutor: StepExecutor,
    private readonly stateMachine: SagaStateMachine,
    private readonly metrics: MetricsService,
  ) {}

  // ── Registration ─────────────────────────────────────────────────

  /**
   * Register a saga definition so it can be looked up by name
   * when replies arrive. Call this at application bootstrap.
   */
  registerDefinition(definition: SagaDefinition): void {
    sagaRegistry.set(definition.name, definition);
    this.logger.log(`Registered saga definition: "${definition.name}" (${definition.steps.length} steps)`);
  }

  // ── Start ─────────────────────────────────────────────────────────

  /**
   * Create and start a new saga instance.
   *
   * @returns The new sagaId
   */
  async startSaga(
    definition: SagaDefinition,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const sagaId = uuidv4();

    // Persist initial state
    const saga = this.sagaRepository['repo']
      ? await this.createAndSaveSaga(sagaId, definition, payload)
      : await this.createAndSaveSaga(sagaId, definition, payload);

    this.stateMachine.logTransition(sagaId, SagaStatus.STARTED, SagaStatus.RUNNING);
    this.metrics.sagaStarted.inc({ sagaName: definition.name });
    this.logger.log(`🚀 Started saga [${sagaId}] "${definition.name}"`);

    // Execute step 0
    await this.stepExecutor.execute(saga, definition.steps[0], 0, payload, definition.name);

    return sagaId;
  }

  // ── Reply handler ─────────────────────────────────────────────────

  /**
   * Handle a step reply arriving from a service via Kafka.
   * Called by the KafkaConsumer for topic "saga-replies".
   */
  async handleStepReply(reply: StepReply): Promise<void> {
    const { sagaId, stepIndex, success, result, error } = reply;

    const saga = await this.sagaRepository.findById(sagaId);
    if (!saga) {
      this.logger.warn(`Reply for unknown saga ${sagaId} — possible duplicate, ignoring`);
      return;
    }

    // Ignore replies for already-terminal sagas (idempotency)
    if (this.stateMachine.isTerminal(saga.status)) {
      this.logger.warn(
        `Saga [${sagaId}] already in terminal state ${saga.status} — ignoring reply for step ${stepIndex}`,
      );
      return;
    }

    const definition = sagaRegistry.get(saga.name);
    if (!definition) {
      throw new Error(`No registered definition found for saga "${saga.name}"`);
    }

    if (success) {
      await this.onStepSuccess(saga, definition, stepIndex, result ?? {});
    } else {
      await this.onStepFailure(saga, definition, stepIndex, error ?? 'Unknown error');
    }
  }

  // ── Queries ───────────────────────────────────────────────────────

  async getSagaStatus(sagaId: string): Promise<SagaEntity | null> {
    return this.sagaRepository.findById(sagaId);
  }

  async getSagaStats(): Promise<Record<string, number>> {
    return this.sagaRepository.getStats();
  }

  // ── Private ───────────────────────────────────────────────────────

  private async createAndSaveSaga(
    sagaId: string,
    definition: SagaDefinition,
    payload: Record<string, unknown>,
  ): Promise<SagaEntity> {
    const saga = new SagaEntity();
    saga.id = sagaId;
    saga.name = definition.name;
    saga.status = SagaStatus.STARTED;
    saga.payload = payload;
    saga.stepResults = {};
    saga.currentStepIndex = 0;
    saga.steps = definition.steps.map((step, idx) => ({
      index: idx,
      name: step.name,
      status: SagaStepStatus.PENDING,
    }));
    saga.timeoutAt = definition.timeoutMs
      ? new Date(Date.now() + definition.timeoutMs)
      : null;

    return this.sagaRepository.save(saga);
  }

  private async onStepSuccess(
    saga: SagaEntity,
    definition: SagaDefinition,
    stepIndex: number,
    result: Record<string, unknown>,
  ): Promise<void> {
    const updatedResults = {
      ...(saga.stepResults as Record<string, unknown>),
      [String(stepIndex)]: result,
    };

    const isLastStep = stepIndex === definition.steps.length - 1;

    if (isLastStep) {
      // ── All steps done — saga COMPLETED ──
      await this.sagaRepository.markCompleted(saga.id, updatedResults);
      this.stateMachine.logTransition(saga.id, saga.status, SagaStatus.COMPLETED);

      this.metrics.sagaCompleted.inc({ sagaName: definition.name });

      await this.kafkaService.publish('saga-events', {
        type: 'SAGA_COMPLETED',
        sagaId: saga.id,
        sagaName: saga.name,
        results: updatedResults,
        completedAt: new Date().toISOString(),
      });
    } else {
      // ── Move to next step ──
      await this.sagaRepository.updateStepResults(saga.id, updatedResults);

      const nextStep = definition.steps[stepIndex + 1];
      const flattenedResults = Object.values(updatedResults).reduce<Record<string, unknown>>(
        (acc, val) => {
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            return { ...acc, ...(val as Record<string, unknown>) };
          }
          return acc;
        },
        {},
      );

      const mergedPayload = {
        ...(saga.payload as Record<string, unknown>),
        ...flattenedResults,
      };

      await this.stepExecutor.execute(
        saga,
        nextStep,
        stepIndex + 1,
        mergedPayload,
        definition.name,
      );
    }
  }

  private async onStepFailure(
    saga: SagaEntity,
    definition: SagaDefinition,
    failedStepIndex: number,
    error: string,
  ): Promise<void> {
    this.logger.warn(
      `⚠️  Step "${definition.steps[failedStepIndex].name}" [${failedStepIndex}] ` +
        `FAILED for saga [${saga.id}]: ${error}`,
    );

    this.metrics.sagaFailed.inc({ sagaName: definition.name });

    // Trigger reverse compensation
    await this.compensationManager.compensate(saga, definition, failedStepIndex);
  }
}
