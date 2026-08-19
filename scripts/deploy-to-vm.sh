#!/usr/bin/env bash
# Run FROM this laptop to deploy the whole stack to a fresh Ubuntu VM.
# Copies the working tree over SSH (repo stays private — no GitHub needed on
# the box), installs docker+k3d+kubectl, deploys on k3s, injects provider keys.
#   VM_IP=1.2.3.4 ANTHROPIC_API_KEY=sk-... ./scripts/deploy-to-vm.sh
set -euo pipefail
cd "$(dirname "$0")/.."

VM_IP=${VM_IP:?set VM_IP=<vm public ip>}
SSH_USER=${SSH_USER:-root}
KEY=${KEY:-$HOME/.ssh/ollive_deploy}
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 $SSH_USER@$VM_IP"

echo "── 1/4 waiting for SSH on $VM_IP ──"
for i in $(seq 1 30); do $SSH true 2>/dev/null && break; sleep 5; done

echo "── 2/4 copying project (excluding build artifacts) ──"
rsync -az --delete -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
  --exclude node_modules --exclude .git --exclude .next --exclude dist \
  --exclude '**/.terraform' --exclude .env --exclude infra/k8s/generated \
  ./ "$SSH_USER@$VM_IP:/root/ollive/"

echo "── 3/4 installing docker/k3d/kubectl on the VM ──"
$SSH 'bash -s' <<'REMOTE'
set -e
export DEBIAN_FRONTEND=noninteractive
command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sh; }
command -v k3d >/dev/null || curl -fsSL https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
command -v kubectl >/dev/null || {
  curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/$(dpkg --print-architecture)/kubectl"
  chmod +x /usr/local/bin/kubectl
}
REMOTE

echo "── 4/4 deploying stack + injecting keys ──"
$SSH "PUBLIC_HOST=$VM_IP ANTHROPIC_API_KEY='${ANTHROPIC_API_KEY:-}' OPENAI_API_KEY='${OPENAI_API_KEY:-}' bash -s" <<'REMOTE'
set -e
cd /root/ollive
PUBLIC_HOST="$PUBLIC_HOST" ./scripts/k8s-up.sh
kubectl -n ollive delete secret provider-keys --ignore-not-found >/dev/null
kubectl -n ollive create secret generic provider-keys \
  --from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  --from-literal=OPENAI_API_KEY="$OPENAI_API_KEY" \
  --from-literal=INGEST_KEY=dev-ingest-key >/dev/null
kubectl -n ollive rollout restart deploy/api deploy/ingest >/dev/null
kubectl -n ollive rollout status deploy/api deploy/ingest --timeout=180s
REMOTE

echo
echo "LIVE →  web       http://$VM_IP:30080"
echo "        dashboard http://$VM_IP:30080/dashboard"
echo "        api       http://$VM_IP:30040/healthz"
echo "Ensure the provider firewall allows inbound TCP 30080 and 30040."
