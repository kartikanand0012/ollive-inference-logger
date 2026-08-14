-- 0001_init.sql
-- Core principle: `messages` is domain data, `inference_logs` is telemetry.
-- Telemetry carries NO foreign key into the domain — logs survive domain
-- deletes, tolerate out-of-order arrival, and can ingest events from any
-- instrumented app, not just this chat.

CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text,
  provider    text NOT NULL,
  model       text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('system','user','assistant')),
  content         text NOT NULL,
  seq             int  NOT NULL,
  status          text NOT NULL DEFAULT 'complete' CHECK (status IN ('complete','cancelled','error')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)   -- also serves resume: WHERE conversation_id ORDER BY seq
);

CREATE TABLE inference_logs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id           uuid NOT NULL UNIQUE,   -- idempotency key (SDK-generated, UUIDv7)
  conversation_id      uuid,                   -- soft reference, no FK (telemetry ≠ domain)
  message_id           uuid,
  provider             text NOT NULL,
  model                text NOT NULL,
  is_stream            boolean NOT NULL DEFAULT false,
  status               text NOT NULL CHECK (status IN ('success','error','cancelled')),
  latency_ms           int,
  ttfb_ms              int,                    -- time to first token (streaming)
  prompt_tokens        int,
  completion_tokens    int,
  total_tokens         int,
  error_type           text,
  error_message        text,                   -- redacted
  input_preview        text,                   -- redacted, ≤500 chars
  output_preview       text,                   -- redacted, ≤500 chars
  raw                  jsonb,                  -- full redacted event (schema-evolution escape hatch)
  request_started_at   timestamptz NOT NULL,
  request_completed_at timestamptz,
  ingested_at          timestamptz NOT NULL DEFAULT now()
);

-- Query → index mapping:
--   throughput/tokens/error-rate over a time window  → idx_logs_started
--   percentiles filtered to one provider+model       → idx_logs_prov_model
--   recent-errors table (status='error', newest N)   → idx_logs_errors (partial)
--   per-conversation log drill-down                  → idx_logs_conversation
CREATE INDEX idx_logs_started      ON inference_logs (request_started_at DESC);
CREATE INDEX idx_logs_prov_model   ON inference_logs (provider, model, request_started_at DESC);
CREATE INDEX idx_logs_errors       ON inference_logs (request_started_at DESC) WHERE status = 'error';
CREATE INDEX idx_logs_conversation ON inference_logs (conversation_id);

CREATE TABLE ingest_failures (      -- dead-letter mirror table (SQL-queryable triage)
  id              bigserial PRIMARY KEY,
  kafka_topic     text,
  kafka_partition int,
  kafka_offset    bigint,
  payload         jsonb NOT NULL,
  error           text NOT NULL,
  retry_count     int NOT NULL DEFAULT 0,
  failed_at       timestamptz NOT NULL DEFAULT now()
);
