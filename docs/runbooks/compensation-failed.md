# Runbook: Saga Incidents

## COMPENSATION_FAILED — Manual Intervention Required

A saga is in `COMPENSATION_FAILED` when a compensation step itself threw an error after all retries.

### Investigation Steps

```bash
# 1. Find the stuck saga
psql $DATABASE_URL -c "SELECT id, name, status, current_step_index, payload FROM sagas WHERE status = 'COMPENSATION_FAILED';"

# 2. Check what step failed
psql $DATABASE_URL -c "SELECT step_results FROM sagas WHERE id = '<saga_id>';"

# 3. Check Kafka dead letter queue
kafka-console-consumer --bootstrap-server localhost:9092 --topic dead-letter --from-beginning

# 4. Check Redis locks (may be stuck)
redis-cli KEYS "lock:saga:*"
redis-cli DEL "lock:saga:<saga_id>:comp:<step_index>"
```

### Resolution

1. Identify which compensation command failed and why (check service logs).
2. Manually execute the compensation (e.g., manually issue a refund via Stripe dashboard).
3. Once manually resolved, update the saga status:

```sql
UPDATE sagas SET status = 'FAILED', completed_at = NOW() WHERE id = '<saga_id>';
```

4. Notify the customer if needed.

---

## Saga Timeout

A saga exceeded its `timeoutAt`. The timeout watcher will mark it `COMPENSATING`.

```bash
# Find timed out sagas
psql $DATABASE_URL -c "SELECT id, name, timeout_at, current_step_index FROM sagas WHERE timeout_at < NOW() AND status NOT IN ('COMPLETED','FAILED','COMPENSATION_FAILED');"
```
