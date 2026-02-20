#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${NAMESPACE:-saga-demo}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

helm upgrade --install saga "$ROOT_DIR/deploy/helm/saga-pattern" \
  --namespace "$NAMESPACE" \
  -f "$ROOT_DIR/deploy/kind/values-kind.yaml" \
  --wait

echo "✅ App deployed (Helm). Try: kubectl -n $NAMESPACE get pods"
