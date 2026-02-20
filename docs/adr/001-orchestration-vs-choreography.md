# ADR-001: Orchestration vs Choreography

**Status:** Accepted  
**Date:** 2024-01-15  
**Deciders:** Engineering Team

## Context

We need to coordinate a multi-step distributed transaction across 4 services:
Order → Payment → Inventory → Notification.

Two main patterns exist: **Orchestration** (central controller) and **Choreography** (services react to events independently).

## Decision

We chose **Orchestration** via a dedicated Saga Orchestrator service.

## Reasoning

| Concern | Orchestration ✅ | Choreography ❌ |
|---------|-----------------|----------------|
| Visibility | Single place to see full saga state | State scattered across services |
| Debugging | One service to query/trace | Must trace across N event logs |
| Compensation | Explicit rollback logic in one place | Each service must know what to undo |
| Complexity | Grows linearly with steps | Grows exponentially with event chains |
| Testing | Orchestrator is unit-testable in isolation | Requires full integration environment |

## Consequences

- **Positive:** Centralized observability, easier compensation, explicit state machine.
- **Negative:** Orchestrator is a single point of failure — mitigated by Redis clustering and Postgres replication.
- **Negative:** Slightly more coupling than choreography — orchestrator must know all service topics.
