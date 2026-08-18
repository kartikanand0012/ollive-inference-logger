#!/usr/bin/env bash
# Mint a tenant + API key. The key is printed ONCE and never stored —
# only its sha256 hash goes to the database.
#   ./scripts/create-tenant.sh <slug> "<display name>" [rate_limit_per_min]
set -euo pipefail
slug=${1:?usage: create-tenant.sh <slug> "<name>" [rate_limit_per_min]}
name=${2:?usage: create-tenant.sh <slug> "<name>" [rate_limit_per_min]}
limit=${3:-600}
key="olv_live_$(openssl rand -hex 24)"
hash=$(printf '%s' "$key" | openssl dgst -sha256 -r | cut -d' ' -f1)
docker compose exec -T postgres psql -U "${POSTGRES_USER:-ollive}" -d "${POSTGRES_DB:-ollive}" -v ON_ERROR_STOP=1 -c \
  "INSERT INTO tenants (id, name, key_hash, rate_limit_per_min) VALUES ('$slug', '$name', '$hash', $limit);"
echo "tenant '$slug' created."
echo "API key (shown once, store it now): $key"
