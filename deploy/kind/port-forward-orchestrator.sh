#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${NAMESPACE:-saga-demo}"

echo "Forwarding orchestrator to http://localhost:8080 …"
kubectl -n "$NAMESPACE" port-forward svc/saga-saga-pattern-orchestrator 8080:80 2>/dev/null || \
kubectl -n "$NAMESPACE" port-forward svc/saga-pattern-orchestrator 8080:80 2>/dev/null || \
kubectl -n "$NAMESPACE" port-forward svc/saga-orchestrator 8080:80
