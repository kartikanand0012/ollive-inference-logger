#!/usr/bin/env bash
# One-shot deploy on a fresh Ubuntu 22.04/24.04 VM (4 vCPU / 8GB recommended —
# Hetzner CAX21 ~€7/mo, DO 8GB ~$48/mo, EC2 t4g.large ~$50/mo; an assessment
# window of 1-2 weeks costs a fraction of that). Installs docker + k3d +
# kubectl, clones the repo, deploys the whole stack on self-hosted k8s.
#
# On the VM:
#   export REPO=https://github.com/<org>/<repo>.git
#   export ANTHROPIC_API_KEY=sk-ant-...        # and/or OPENAI_API_KEY
#   curl -fsSL <raw-url-of-this-script> | bash   (or scp + run)
#
# Then open:  http://<vm-ip>:30080  (dashboard: /dashboard, explorer: /requests)
set -euo pipefail

REPO=${REPO:?set REPO=https://github.com/<org>/<repo>.git}
PUBLIC_HOST=${PUBLIC_HOST:-$(curl -fsS https://checkip.amazonaws.com | tr -d '\n')}

echo "── installing docker / k3d / kubectl ──"
command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sh; usermod -aG docker "$USER" || true; }
command -v k3d >/dev/null || curl -fsSL https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
command -v kubectl >/dev/null || {
  curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/$(dpkg --print-architecture)/kubectl"
  chmod +x /usr/local/bin/kubectl
}

echo "── cloning + deploying (PUBLIC_HOST=$PUBLIC_HOST) ──"
[ -d ollive-inference-logger ] || git clone "$REPO" ollive-inference-logger
cd ollive-inference-logger
PUBLIC_HOST="$PUBLIC_HOST" ./scripts/k8s-up.sh

echo "── injecting provider keys ──"
kubectl -n ollive delete secret provider-keys --ignore-not-found >/dev/null
kubectl -n ollive create secret generic provider-keys \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  --from-literal=OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  --from-literal=INGEST_KEY="${INGEST_KEY:-dev-ingest-key}" >/dev/null
kubectl -n ollive rollout restart deploy/api deploy/ingest
kubectl -n ollive rollout status deploy/api deploy/ingest --timeout=180s

echo
echo "DONE →  web       http://$PUBLIC_HOST:30080"
echo "        dashboard http://$PUBLIC_HOST:30080/dashboard"
echo "        api       http://$PUBLIC_HOST:30040/healthz"
echo "Open ports 30080 + 30040 in the provider firewall / security group."
echo "Demo data: on the VM, run 'make traffic' after 'pnpm install' — or just chat in the UI."
