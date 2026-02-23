import { SagaStateMachine } from '../../src/SagaStateMachine';
import { SagaStatus } from '../../src/entities/saga.entity';

/**
 * Unit tests for SagaStateMachine
 * Tests all valid/invalid transitions and helper methods.
 * No NestJS DI, no DB, no Kafka — pure logic only.
 */
describe('SagaStateMachine', () => {
  let stateMachine: SagaStateMachine;

  beforeEach(() => {
    stateMachine = new SagaStateMachine();
  });

  // ── canTransition ──────────────────────────────────────────────────

  describe('canTransition()', () => {
    describe('valid transitions', () => {
      it('STARTED → RUNNING', () => {
        expect(stateMachine.canTransition(SagaStatus.STARTED, SagaStatus.RUNNING)).toBe(true);
      });

      it('STARTED → FAILED (e.g. immediate failure on first step)', () => {
        expect(stateMachine.canTransition(SagaStatus.STARTED, SagaStatus.FAILED)).toBe(true);
      });

      it('RUNNING → RUNNING (intermediate step success)', () => {
        expect(stateMachine.canTransition(SagaStatus.RUNNING, SagaStatus.RUNNING)).toBe(true);
      });

      it('RUNNING → COMPLETED (last step success)', () => {
        expect(stateMachine.canTransition(SagaStatus.RUNNING, SagaStatus.COMPLETED)).toBe(true);
      });

      it('RUNNING → COMPENSATING (step failure)', () => {
        expect(stateMachine.canTransition(SagaStatus.RUNNING, SagaStatus.COMPENSATING)).toBe(true);
      });

      it('COMPENSATING → COMPENSATING (multi-step rollback)', () => {
        expect(stateMachine.canTransition(SagaStatus.COMPENSATING, SagaStatus.COMPENSATING)).toBe(true);
      });

      it('COMPENSATING → FAILED (all compensations dispatched)', () => {
        expect(stateMachine.canTransition(SagaStatus.COMPENSATING, SagaStatus.FAILED)).toBe(true);
      });

      it('COMPENSATING → COMPENSATION_FAILED (compensation itself failed)', () => {
        expect(
          stateMachine.canTransition(SagaStatus.COMPENSATING, SagaStatus.COMPENSATION_FAILED),
        ).toBe(true);
      });
    });

    describe('invalid transitions', () => {
      it('COMPLETED is terminal — cannot transition to anything', () => {
        const allStatuses = Object.values(SagaStatus);
        allStatuses.forEach((next) => {
          expect(stateMachine.canTransition(SagaStatus.COMPLETED, next)).toBe(false);
        });
      });

      it('FAILED is terminal — cannot transition to anything', () => {
        const allStatuses = Object.values(SagaStatus);
        allStatuses.forEach((next) => {
          expect(stateMachine.canTransition(SagaStatus.FAILED, next)).toBe(false);
        });
      });

      it('COMPENSATION_FAILED is terminal — cannot transition to anything', () => {
        const allStatuses = Object.values(SagaStatus);
        allStatuses.forEach((next) => {
          expect(
            stateMachine.canTransition(SagaStatus.COMPENSATION_FAILED, next),
          ).toBe(false);
        });
      });

      it('STARTED cannot jump directly to COMPLETED', () => {
        expect(stateMachine.canTransition(SagaStatus.STARTED, SagaStatus.COMPLETED)).toBe(false);
      });

      it('STARTED cannot jump directly to COMPENSATING', () => {
        expect(
          stateMachine.canTransition(SagaStatus.STARTED, SagaStatus.COMPENSATING),
        ).toBe(false);
      });

      it('RUNNING cannot go to FAILED directly (must compensate first)', () => {
        expect(stateMachine.canTransition(SagaStatus.RUNNING, SagaStatus.FAILED)).toBe(false);
      });

      it('COMPENSATING cannot go back to RUNNING', () => {
        expect(stateMachine.canTransition(SagaStatus.COMPENSATING, SagaStatus.RUNNING)).toBe(false);
      });

      it('COMPENSATING cannot go to COMPLETED', () => {
        expect(
          stateMachine.canTransition(SagaStatus.COMPENSATING, SagaStatus.COMPLETED),
        ).toBe(false);
      });
    });
  });

  // ── assertTransition ──────────────────────────────────────────────

  describe('assertTransition()', () => {
    it('does not throw for a valid transition', () => {
      expect(() =>
        stateMachine.assertTransition(SagaStatus.RUNNING, SagaStatus.COMPLETED),
      ).not.toThrow();
    });

    it('throws with a descriptive message for an invalid transition', () => {
      expect(() =>
        stateMachine.assertTransition(SagaStatus.COMPLETED, SagaStatus.RUNNING),
      ).toThrow(/Invalid saga state transition: COMPLETED → RUNNING/);
    });

    it('error message includes allowed transitions', () => {
      expect(() =>
        stateMachine.assertTransition(SagaStatus.RUNNING, SagaStatus.STARTED),
      ).toThrow(/Allowed transitions from RUNNING/);
    });

    it('error message says "none" for terminal states', () => {
      expect(() =>
        stateMachine.assertTransition(SagaStatus.FAILED, SagaStatus.RUNNING),
      ).toThrow(/none/);
    });
  });

  // ── isTerminal ────────────────────────────────────────────────────

  describe('isTerminal()', () => {
    it('COMPLETED is terminal', () => {
      expect(stateMachine.isTerminal(SagaStatus.COMPLETED)).toBe(true);
    });

    it('FAILED is terminal', () => {
      expect(stateMachine.isTerminal(SagaStatus.FAILED)).toBe(true);
    });

    it('COMPENSATION_FAILED is terminal', () => {
      expect(stateMachine.isTerminal(SagaStatus.COMPENSATION_FAILED)).toBe(true);
    });

    it('STARTED is not terminal', () => {
      expect(stateMachine.isTerminal(SagaStatus.STARTED)).toBe(false);
    });

    it('RUNNING is not terminal', () => {
      expect(stateMachine.isTerminal(SagaStatus.RUNNING)).toBe(false);
    });

    it('COMPENSATING is not terminal', () => {
      expect(stateMachine.isTerminal(SagaStatus.COMPENSATING)).toBe(false);
    });
  });

  // ── nextStatusAfterStep ───────────────────────────────────────────

  describe('nextStatusAfterStep()', () => {
    describe('step success', () => {
      it('returns RUNNING when step succeeds and is NOT the last step', () => {
        const result = stateMachine.nextStatusAfterStep(
          SagaStatus.RUNNING,
          true,
          false,
        );
        expect(result).toBe(SagaStatus.RUNNING);
      });

      it('returns COMPLETED when step succeeds and IS the last step', () => {
        const result = stateMachine.nextStatusAfterStep(
          SagaStatus.RUNNING,
          true,
          true,
        );
        expect(result).toBe(SagaStatus.COMPLETED);
      });
    });

    describe('step failure', () => {
      it('returns COMPENSATING when step fails', () => {
        const result = stateMachine.nextStatusAfterStep(
          SagaStatus.RUNNING,
          false,
          false,
        );
        expect(result).toBe(SagaStatus.COMPENSATING);
      });

      it('returns COMPENSATING even if it was the last step that failed', () => {
        const result = stateMachine.nextStatusAfterStep(
          SagaStatus.RUNNING,
          false,
          true,
        );
        expect(result).toBe(SagaStatus.COMPENSATING);
      });

      it('throws when trying to compensate from a terminal state', () => {
        expect(() =>
          stateMachine.nextStatusAfterStep(SagaStatus.COMPLETED, false, false),
        ).toThrow(/Invalid saga state transition/);
      });
    });
  });

  // ── logTransition ─────────────────────────────────────────────────

  describe('logTransition()', () => {
    it('does not throw for any valid status combination', () => {
      const allStatuses = Object.values(SagaStatus);
      allStatuses.forEach((from) => {
        allStatuses.forEach((to) => {
          expect(() =>
            stateMachine.logTransition('test-saga-id', from, to),
          ).not.toThrow();
        });
      });
    });
  });
});
