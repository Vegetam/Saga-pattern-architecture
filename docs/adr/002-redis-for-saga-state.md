# ADR-002: Redis as Saga State Store (Distributed Locks)

**Status:** Accepted  
**Date:** 2024-01-15

## Context

Saga steps must not be executed twice (idempotency). In a horizontally-scaled orchestrator, multiple pods could attempt to process the same step reply simultaneously.

## Decision

Use **Redis SET NX PX** (atomic set-if-not-exists with TTL) as distributed locks for step execution. Saga state (source of truth) remains in PostgreSQL.

## Implementation

```
LOCK KEY:  lock:saga:{sagaId}:step:{stepIndex}
TTL:       30 seconds (auto-release if pod crashes)
VALUE:     "1"
```

- `acquireLock(key, ttlMs)` → `SET lock:{key} 1 PX {ttlMs} NX` → returns OK or nil
- `releaseLock(key)` → `DEL lock:{key}`

## Consequences

- **Positive:** Prevents duplicate step execution across multiple orchestrator pods.
- **Positive:** Lock auto-expires if pod crashes mid-step (prevents deadlock).
- **Negative:** Redis is now a dependency — cluster mode required for production HA.
