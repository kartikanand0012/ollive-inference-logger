-- 0002_derived_metadata.sql
-- Metadata DERIVED by the ingestion pipeline (assignment §3: "extracts useful
-- metadata") — values the SDK does not send, computed by the worker at write:
--   tokens_per_sec : generation speed (completion_tokens / generation seconds)
--   est_cost_usd   : per-event cost snapshot from the pricing table at ingest
--                    (dashboards still price at query time so pricing edits
--                    apply retroactively; this column is the frozen snapshot)
--   ingest_lag_ms  : request completion → DB write (pipeline delay, the
--                    "near real time" claim as a measurable column)
ALTER TABLE inference_logs
  ADD COLUMN IF NOT EXISTS tokens_per_sec double precision,
  ADD COLUMN IF NOT EXISTS est_cost_usd   double precision,
  ADD COLUMN IF NOT EXISTS ingest_lag_ms  int;

-- Conversation list is the one query every page load runs; give it its index.
CREATE INDEX IF NOT EXISTS idx_conversations_updated
  ON conversations (updated_at DESC);
