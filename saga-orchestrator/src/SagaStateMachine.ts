import { Injectable, Logger } from '@nestjs/common';
import { SagaStatus } from './entities/saga.entity';

/**
 * Valid state transitions for a Saga.
 *
 * State diagram:
 *
 *   STARTED
 *     │
 *     ▼
 *   RUNNING ──────────────────────────────► COMPLETED
 *     │
 *     ▼ (step failure)
 *   COMPENSATING ──────────────────────────► FAILED
 *     │
 *     ▼ (compensation step fails)
 *   COMPENSATION_FAILED  (terminal — needs manual intervention)
 */
const VALID_TRANSITIONS: Record<SagaStatus, SagaStatus[]> = {
  [SagaStatus.STARTED]: [SagaStatus.RUNNING, SagaStatus.FAILED],
  [SagaStatus.RUNNING]: [SagaStatus.RUNNING, SagaStatus.COMPLETED, SagaStatus.COMPENSATING],
  [SagaStatus.COMPENSATING]: [SagaStatus.COMPENSATING, SagaStatus.FAILED, SagaStatus.COMPENSATION_FAILED],
  [SagaStatus.COMPLETED]: [],           // terminal
  [SagaStatus.FAILED]: [],             // terminal
  [SagaStatus.COMPENSATION_FAILED]: [], // terminal
};

@Injectable()
export class SagaStateMachine {
  private readonly logger = new Logger(SagaStateMachine.name);

  /**
   * Check whether a transition from `current` → `next` is valid.
   */
  canTransition(current: SagaStatus, next: SagaStatus): boolean {
    return VALID_TRANSITIONS[current]?.includes(next) ?? false;
  }

  /**
   * Assert that a transition is valid, throw if not.
   */
  assertTransition(current: SagaStatus, next: SagaStatus): void {
    if (!this.canTransition(current, next)) {
      throw new Error(
        `Invalid saga state transition: ${current} → ${next}. ` +
          `Allowed transitions from ${current}: [${VALID_TRANSITIONS[current]?.join(', ') || 'none'}]`,
      );
    }
  }

  /**
   * Check whether the saga is in a terminal (final) state.
   */
  isTerminal(status: SagaStatus): boolean {
    return VALID_TRANSITIONS[status]?.length === 0;
  }

  /**
   * Determine the next status after a step result.
   */
  nextStatusAfterStep(
    current: SagaStatus,
    stepSuccess: boolean,
    isLastStep: boolean,
  ): SagaStatus {
    if (!stepSuccess) {
      this.assertTransition(current, SagaStatus.COMPENSATING);
      return SagaStatus.COMPENSATING;
    }

    if (isLastStep) {
      this.assertTransition(current, SagaStatus.COMPLETED);
      return SagaStatus.COMPLETED;
    }

    this.assertTransition(current, SagaStatus.RUNNING);
    return SagaStatus.RUNNING;
  }

  /**
   * Log a state transition for audit purposes.
   */
  logTransition(sagaId: string, from: SagaStatus, to: SagaStatus): void {
    const emoji =
      to === SagaStatus.COMPLETED
        ? '✅'
        : to === SagaStatus.FAILED
          ? '❌'
          : to === SagaStatus.COMPENSATING
            ? '⚠️'
            : to === SagaStatus.COMPENSATION_FAILED
              ? '🚨'
              : '🔄';

    this.logger.log(`${emoji} Saga [${sagaId}] transition: ${from} → ${to}`);
  }
}
