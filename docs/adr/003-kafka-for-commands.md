# ADR-003: Kafka for Command Channels

**Status:** Accepted  
**Date:** 2024-01-15

## Context

Saga steps are dispatched as commands to services. We need a reliable, ordered, durable channel with replay capability.

## Decision

Use **Apache Kafka** for all saga command and reply channels.

## Topic Design

| Topic | Producer | Consumer | Purpose |
|-------|----------|----------|---------|
| `saga-order-commands` | Orchestrator | Order Service | Order step commands |
| `saga-payment-commands` | Orchestrator | Payment Service | Payment step commands |
| `saga-inventory-commands` | Orchestrator | Inventory Service | Inventory commands |
| `saga-replies` | All services | Orchestrator | Step results |
| `saga-compensation-replies` | All services | Orchestrator | Compensation results |
| `saga-events` | Orchestrator | Notification, Analytics | Saga lifecycle events |
| `dead-letter` | All services | Ops team | Failed/unprocessable msgs |

## Partitioning

Messages are keyed by `sagaId` so all messages for the same saga land on the same partition — guaranteeing ordering within a saga.

## Consequences

- **Positive:** Durable, replayable, high-throughput.
- **Positive:** At-least-once delivery with consumer group offsets.
- **Negative:** Kafka operational complexity — mitigated by using Confluent Cloud or MSK in production.
