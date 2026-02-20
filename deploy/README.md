# Kubernetes-ready deployment (Helm + Kustomize + kind)

This repo is a **production-oriented example** of a Saga orchestrator + 4 microservices.

It includes:

- **Helm chart**: `deploy/helm/saga-pattern`
- **Kustomize manifests**: `deploy/kustomize`
- **kind + Bitnami infra scripts** (Kafka + Redis + 1 Postgres per service): `deploy/kind`

## Quickstart (kind + Bitnami + Helm)

Prereqs: `docker`, `kubectl`, `helm`, `kind`.

```bash
cd deploy/kind

./create-cluster.sh
./install-bitnami-infra.sh

./build-images.sh
./deploy-app-helm.sh

./port-forward-orchestrator.sh
```

Then hit:

- `GET http://localhost:8080/live`
- `GET http://localhost:8080/ready`

## Kustomize

Kustomize deploys **only the app** (it assumes Kafka/Redis/Postgres already exist).

```bash
kubectl create namespace saga-demo
kubectl -n saga-demo apply -k deploy/kustomize/overlays/kind
```

## Notes / tradeoffs

- The Bitnami charts’ values change over time. If `install-bitnami-infra.sh` fails, run:
  `helm show values bitnami/kafka` (or the chart that failed) and adjust the `--set` flags.
- For real production you should replace in-chart secrets with **ExternalSecrets/SealedSecrets** and enforce TLS/auth for Kafka/Postgres/Redis.
- Orchestrator DB bootstrapping is **idempotent** (creates the `sagas` table if missing), so you can keep TypeORM `synchronize=false` in production.
