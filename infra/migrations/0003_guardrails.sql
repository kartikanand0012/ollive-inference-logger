-- 0003_guardrails.sql
-- Runtime-governance signal derived by the worker: heuristic prompt-injection
-- detection (OWASP LLM01) over the input preview. Partial index serves the
-- "show me flagged inputs" dashboard/explorer path without taxing the 99%+
-- unflagged rows.
ALTER TABLE inference_logs
  ADD COLUMN IF NOT EXISTS flagged_injection boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_logs_flagged
  ON inference_logs (request_started_at DESC)
  WHERE flagged_injection;
