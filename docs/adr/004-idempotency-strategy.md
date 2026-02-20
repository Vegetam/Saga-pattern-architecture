# ADR-004: Idempotency Key Strategy

**Status:** Accepted  
**Date:** 2024-01-15

## Context

Kafka delivers messages **at-least-once**. A service may receive the same command twice (network retry, consumer rebalance). Executing a payment twice would be catastrophic.

## Decision

Every saga step command carries an `idempotencyKey`. Services store processed keys in a `processed_saga_steps` table and skip re-execution.

## Key Format

```
saga:{sagaId}:step:{stepIndex}          # forward step
saga:{sagaId}:comp:{stepIndex}          # compensation step
```

## Service-side Implementation

```sql
-- Check before processing
SELECT result FROM processed_saga_steps WHERE idempotency_key = $1;

-- Store after processing (same transaction as business operation)
INSERT INTO processed_saga_steps (idempotency_key, result)
VALUES ($1, $2)
ON CONFLICT DO NOTHING;
```

If the key exists, return the stored result immediately without re-executing.

## Consequences

- **Positive:** Safe re-delivery — business logic runs exactly once.
- **Positive:** Idempotency table also acts as an audit trail.
- **Negative:** Small storage overhead — mitigated by TTL cleanup job (keys older than 7 days deleted).
