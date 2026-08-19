#!/usr/bin/env bash
# STRETCH (see infra/k8s/README.md — written, not battle-tested):
# k3d cluster → build images → import → apply kustomize → web on :30080.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=ollive

command -v k3d >/dev/null || { echo "k3d not installed (brew install k3d)"; exit 1; }
command -v kubectl >/dev/null || { echo "kubectl not installed"; exit 1; }

# PUBLIC_HOST: where a BROWSER reaches this cluster (VM public IP or localhost).
PUBLIC_HOST=${PUBLIC_HOST:-localhost}

k3d cluster list | grep -q "^$CLUSTER " || \
  k3d cluster create "$CLUSTER" \
    --port "30080:30080@server:0" \
    --port "30040:30040@server:0"

echo "building images… (web baked with NEXT_PUBLIC_API_URL=http://$PUBLIC_HOST:30040)"
docker build -f infra/docker/app.Dockerfile --build-arg APP=api    -t ollive/api:local .
docker build -f infra/docker/app.Dockerfile --build-arg APP=ingest -t ollive/ingest:local .
docker build -f infra/docker/app.Dockerfile --build-arg APP=worker -t ollive/worker:local .
docker build -f infra/docker/web.Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL="http://$PUBLIC_HOST:30040"      -t ollive/web:local .
docker build infra/kafka-init                                      -t ollive/kafka-init:local

echo "importing images into k3d…"
k3d image import -c "$CLUSTER" \
  ollive/api:local ollive/ingest:local ollive/worker:local ollive/web:local ollive/kafka-init:local

echo "applying manifests…"
mkdir -p infra/k8s/generated
cp infra/migrate.sh infra/migrations/*.sql infra/k8s/generated/
kubectl apply -k infra/k8s

echo "waiting for rollouts…"
kubectl -n ollive rollout status deploy/postgres deploy/kafka --timeout=180s
kubectl -n ollive wait --for=condition=complete job/migrate job/kafka-init --timeout=180s || true
kubectl -n ollive rollout status deploy/api deploy/ingest deploy/worker deploy/web --timeout=180s

echo "done → web http://$PUBLIC_HOST:30080 · api http://$PUBLIC_HOST:30040/healthz"
echo "set real keys: kubectl -n ollive edit secret provider-keys (then: kubectl -n ollive rollout restart deploy/api)"
