#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-saga-demo}"

kind create cluster --name "$CLUSTER_NAME" --wait 60s

kubectl create namespace saga-demo 2>/dev/null || true
kubectl config set-context --current --namespace=saga-demo

echo "✅ kind cluster '$CLUSTER_NAME' is ready (namespace: saga-demo)"
