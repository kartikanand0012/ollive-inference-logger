-- 0004_tenants.sql
-- Per-tenant identity (done first because
-- retrofitting tenant_id after the schema hardens is the most expensive
-- migration on the list). Keys are NEVER stored: only sha256 hashes.
CREATE TABLE tenants (
  id                 text PRIMARY KEY,        -- slug, e.g. 'default', 'acme'
  name               text NOT NULL,
  key_hash           text NOT NULL UNIQUE,    -- sha256 hex of the api key
  rate_limit_per_min int  NOT NULL DEFAULT 600,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Telemetry gains its tenant dimension; existing rows belong to 'default'
-- (the env-key bootstrap tenant).
ALTER TABLE inference_logs
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';

-- Tenant-scoped window scans (the shape every per-tenant dashboard query takes).
CREATE INDEX IF NOT EXISTS idx_logs_tenant
  ON inference_logs (tenant_id, request_started_at DESC);
