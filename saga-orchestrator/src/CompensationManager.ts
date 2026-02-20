import { Injectable, Logger } from '@nestjs/common';
import { KafkaService } from './kafka/kafka.service';
import { SagaRepository } from './SagaRepository';
import { SagaEntity, SagaStatus } from './entities/saga.entity';
import { SagaDefinition } from './SagaOrchestrator';
import { SagaStateMachine } from './SagaStateMachine';

@Injectable()
export class CompensationManager {
  private readonly logger = new Logger(CompensationManager.name);

  constructor(
    private readonly sagaRepository: SagaRepository,
    private readonly kafkaService: KafkaService,
    private readonly stateMachine: SagaStateMachine,
  ) {}

  /**
   * Execute compensation steps in **reverse order** for all steps that
   * completed before the failed step.
   *
   * Example: steps [0,1,2] and step 2 fails → compensate [1, 0]
   *
   * Each compensation command is published to the service's compensationTopic.
   * If any compensation itself fails, the saga is marked COMPENSATION_FAILED
   * and on-call is alerted — manual intervention required.
   */
  async compensate(
    saga: SagaEntity,
    definition: SagaDefinition,
    failedStepIndex: number,
  ): Promise<void> {
    this.logger.warn(
      `⚠️  Starting compensation for saga [${saga.id}] (${definition.name}) — ` +
        `rolling back steps ${failedStepIndex - 1} down to 0`,
    );

    // Validate state transition
    this.stateMachine.assertTransition(saga.status, SagaStatus.COMPENSATING);
    await this.sagaRepository.markCompensating(saga.id);
    this.stateMachine.logTransition(saga.id, saga.status, SagaStatus.COMPENSATING);

    // Walk backwards through steps that were already completed
    for (let i = failedStepIndex - 1; i >= 0; i--) {
      const step = definition.steps[i];

      if (!step.compensationCommand || !step.compensationTopic) {
        this.logger.log(
          `Step "${step.name}" [${i}] has no compensation defined — skipping`,
        );
        continue;
      }

      // Merge original payload with what the step produced (needed for e.g. refund by payment_id)
      const stepResult =
        (saga.stepResults as Record<string, unknown>)[String(i)] || {};

      const idempotencyKey = `saga:${saga.id}:comp:${i}`;

      try {
        await this.kafkaService.publish(step.compensationTopic, {
          sagaId: saga.id,
          sagaName: definition.name,
          stepIndex: i,
          stepName: step.name,
          command: step.compensationCommand,
          idempotencyKey,
          payload: {
            ...(saga.payload as Record<string, unknown>),
            ...stepResult,
          },
          replyTopic: 'saga-compensation-replies',
          timestamp: new Date().toISOString(),
        });

        this.logger.log(
          `↩️  Dispatched compensation "${step.compensationCommand}" for step "${step.name}" [${i}] — saga ${saga.id}`,
        );
      } catch (error) {
        // ─── CRITICAL: compensation itself failed ───────────────────
        this.logger.error(
          `🚨 CRITICAL: Compensation failed for step "${step.name}" [${i}] on saga ${saga.id}. ` +
            `Manual intervention required!`,
          error,
        );

        await this.sagaRepository.markCompensationFailed(saga.id);
        this.stateMachine.logTransition(
          saga.id,
          SagaStatus.COMPENSATING,
          SagaStatus.COMPENSATION_FAILED,
        );

        await this.alertOnCall(saga.id, step.name, error);
        return; // stop further compensation — state is now COMPENSATION_FAILED
      }
    }

    // All compensations dispatched — mark saga as FAILED (not COMPENSATION_FAILED)
    await this.sagaRepository.markFailed(saga.id);
    this.stateMachine.logTransition(saga.id, SagaStatus.COMPENSATING, SagaStatus.FAILED);

    // Publish SAGA_FAILED event so downstream consumers can react
    await this.kafkaService.publish('saga-events', {
      type: 'SAGA_FAILED',
      sagaId: saga.id,
      sagaName: definition.name,
      failedAt: new Date().toISOString(),
    });

    this.logger.log(
      `❌ Saga [${saga.id}] fully compensated — status: FAILED`,
    );
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async alertOnCall(
    sagaId: string,
    stepName: string,
    error: unknown,
  ): Promise<void> {
    // TODO: replace with real PagerDuty / OpsGenie client
    this.logger.error(
      `[ALERT] PagerDuty trigger: saga ${sagaId} stuck at compensation step "${stepName}". ` +
        `Error: ${String(error)}`,
    );
  }
}
