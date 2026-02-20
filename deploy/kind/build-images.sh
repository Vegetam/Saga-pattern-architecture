#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-saga-demo}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "🔧 Building Docker images…"

docker build -t saga-orchestrator:latest "$ROOT_DIR/saga-orchestrator"
docker build -t order-service:latest "$ROOT_DIR/services/order-service"
docker build -t payment-service:latest "$ROOT_DIR/services/payment-service"
docker build -t inventory-service:latest "$ROOT_DIR/services/inventory-service"
docker build -t notification-service:latest "$ROOT_DIR/services/notification-service"

echo "📦 Loading images into kind…"
kind load docker-image --name "$CLUSTER_NAME" saga-orchestrator:latest
kind load docker-image --name "$CLUSTER_NAME" order-service:latest
kind load docker-image --name "$CLUSTER_NAME" payment-service:latest
kind load docker-image --name "$CLUSTER_NAME" inventory-service:latest
kind load docker-image --name "$CLUSTER_NAME" notification-service:latest

echo "✅ Images loaded into kind cluster '$CLUSTER_NAME'"
