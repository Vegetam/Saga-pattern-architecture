#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${NAMESPACE:-saga-demo}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

kubectl create namespace "$NAMESPACE" 2>/dev/null || true
kubectl -n "$NAMESPACE" apply -k "$ROOT_DIR/deploy/kustomize/overlays/kind"

echo "✅ App deployed (Kustomize). Try: kubectl -n $NAMESPACE get pods"
