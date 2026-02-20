#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${NAMESPACE:-saga-demo}"

echo "📦 Adding Bitnami Helm repo…"
helm repo add bitnami https://charts.bitnami.com/bitnami >/dev/null
helm repo update >/dev/null

echo "🧱 Installing Kafka (Bitnami)…"
# NOTE: Bitnami chart values evolve. If this command fails, run:
#   helm show values bitnami/kafka | less
# and adjust the --set flags.
helm upgrade --install kafka bitnami/kafka \
  --namespace "$NAMESPACE" --create-namespace \
  --set replicaCount=1 \
  --set zookeeper.replicaCount=1 \
  --set auth.clientProtocol=plaintext \
  --set auth.interBrokerProtocol=plaintext \
  --wait

echo "🧱 Installing Redis (Bitnami)…"
helm upgrade --install redis bitnami/redis \
  --namespace "$NAMESPACE" \
  --set architecture=standalone \
  --set auth.enabled=false \
  --wait

echo "🧱 Installing Postgres (one per service)…"

helm upgrade --install postgres-saga bitnami/postgresql \
  --namespace "$NAMESPACE" \
  --set auth.username=saga_user \
  --set auth.password=saga_pass \
  --set auth.database=saga_db \
  --wait

helm upgrade --install postgres-orders bitnami/postgresql \
  --namespace "$NAMESPACE" \
  --set auth.username=orders_user \
  --set auth.password=orders_pass \
  --set auth.database=orders_db \
  --wait

helm upgrade --install postgres-payments bitnami/postgresql \
  --namespace "$NAMESPACE" \
  --set auth.username=payments_user \
  --set auth.password=payments_pass \
  --set auth.database=payments_db \
  --wait

helm upgrade --install postgres-inventory bitnami/postgresql \
  --namespace "$NAMESPACE" \
  --set auth.username=inventory_user \
  --set auth.password=inventory_pass \
  --set auth.database=inventory_db \
  --wait

echo "🧵 Creating Kafka topics…"
kubectl -n "$NAMESPACE" run kafka-topics --rm -i --restart=Never \
  --image=bitnami/kafka:latest \
  --command -- bash -ec '
    set -e
    BOOTSTRAP="kafka:9092"
    topics=(
      saga-order-commands
      saga-payment-commands
      saga-inventory-commands
      saga-events
      saga-replies
      saga-compensation-replies
      saga-order-commands.dlq
      saga-payment-commands.dlq
      saga-inventory-commands.dlq
      saga-events.dlq
      saga-replies.dlq
    )
    for t in "${topics[@]}"; do
      kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --create --if-not-exists --topic "$t" --replication-factor 1 --partitions 1
    done
    echo "✅ Topics ready"
  '

echo "✅ Infra installed in namespace '$NAMESPACE'"
