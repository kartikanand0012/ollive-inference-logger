import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { flushInferenceEvents } from '@ollive/sdk';
import { env } from './env.js';
import { pool } from './db.js';
import { configuredProviders } from './clients.js';
import { cancelAllConversations, closeCancelBus, initCancelBus } from './cancels.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerLogRoutes } from './routes/logs.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerAssistantRoutes } from './routes/assistant.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  // Slowloris hardening: bound how long a client may take to DELIVER a
  // request (headers+body). Applies to the request side only — long-lived
  // SSE responses are unaffected.
  requestTimeout: 30_000,
});

// CORS: explicit allowlist in production (CORS_ORIGIN), permissive in dev.
await app.register(cors, {
  origin: env.corsOrigin ? env.corsOrigin.split(',').map((o) => o.trim()) : true,
});
await app.register(helmet, { contentSecurityPolicy: false }); // API responses only — no HTML
// DoS guard: per-client request budget; health probes exempt.
await app.register(rateLimit, {
  max: env.rateLimitPerMin,
  timeWindow: '1 minute',
  allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
});

// TEMPORARY: one-shot migration endpoint. Remove after first successful run.
const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text,
  provider    text NOT NULL,
  model       text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('system','user','assistant')),
  content         text NOT NULL,
  seq             int  NOT NULL,
  status          text NOT NULL DEFAULT 'complete' CHECK (status IN ('complete','cancelled','error')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);
CREATE TABLE IF NOT EXISTS inference_logs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id           uuid NOT NULL UNIQUE,
  conversation_id      uuid,
  message_id           uuid,
  provider             text NOT NULL,
  model                text NOT NULL,
  is_stream            boolean NOT NULL DEFAULT false,
  status               text NOT NULL CHECK (status IN ('success','error','cancelled')),
  latency_ms           int,
  ttfb_ms              int,
  prompt_tokens        int,
  completion_tokens    int,
  total_tokens         int,
  error_type           text,
  error_message        text,
  input_preview        text,
  output_preview       text,
  raw                  jsonb,
  request_started_at   timestamptz NOT NULL,
  request_completed_at timestamptz,
  ingested_at          timestamptz NOT NULL DEFAULT now(),
  tokens_per_sec       double precision,
  est_cost_usd         double precision,
  ingest_lag_ms        int,
  flagged_injection    boolean NOT NULL DEFAULT false,
  tenant_id            text NOT NULL DEFAULT 'default'
);
CREATE INDEX IF NOT EXISTS idx_logs_started ON inference_logs (request_started_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_prov_model ON inference_logs (provider, model, request_started_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_errors ON inference_logs (request_started_at DESC) WHERE status = 'error';
CREATE INDEX IF NOT EXISTS idx_logs_conversation ON inference_logs (conversation_id);
CREATE INDEX IF NOT EXISTS idx_logs_flagged ON inference_logs (request_started_at DESC) WHERE flagged_injection;
CREATE TABLE IF NOT EXISTS ingest_failures (
  id              bigserial PRIMARY KEY,
  kafka_topic     text,
  kafka_partition int,
  kafka_offset    bigint,
  payload         jsonb NOT NULL,
  error           text NOT NULL,
  retry_count     int NOT NULL DEFAULT 0,
  failed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tenants (
  id                   text PRIMARY KEY,
  key_hash             text NOT NULL UNIQUE,
  rate_limit_per_min   int NOT NULL DEFAULT 600,
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS assistant_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations (updated_at DESC);
INSERT INTO tenants (id, key_hash, rate_limit_per_min, active)
VALUES ('default', 'bootstrap', 600, true)
ON CONFLICT (id) DO NOTHING;
`;
app.post('/admin/migrate', async (req, reply) => {
  if (req.headers['x-migrate-token'] !== process.env.MIGRATE_TOKEN) {
    return reply.code(403).send({ error: 'forbidden' });
  }
  try {
    await pool.query(MIGRATION_SQL);
    const { rows } = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    );
    return { ok: true, tables: rows.map((r) => r.tablename) };
  } catch (e) {
    return reply.code(500).send({ ok: false, error: String(e).slice(0, 500) });
  }
});

// Liveness: shallow. Readiness: proves the DB is reachable (k8s readinessProbe).
app.get('/healthz', async () => ({ ok: true, providers: configuredProviders() }));
app.get('/readyz', async (_req, reply) => {
  try {
    await pool.query('SELECT 1');
    return { ready: true };
  } catch {
    return reply.code(503).send({ ready: false, reason: 'database unreachable' });
  }
});
registerChatRoutes(app);
registerConversationRoutes(app);
registerStatsRoutes(app);
registerLogRoutes(app);
registerSettingsRoutes(app);
registerAssistantRoutes(app);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  // Abort in-flight generations first — otherwise open SSE streams (kept
  // alive by heartbeats) hold app.close() past the SIGTERM grace period and
  // the telemetry flush below never runs.
  cancelAllConversations();
  await app.close();
  await flushInferenceEvents(); // drain buffered telemetry before exit
  await closeCancelBus();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await initCancelBus(process.env.REDIS_URL, app.log);
  await app.listen({ port: env.port, host: '0.0.0.0' });
  app.log.info({ providers: configuredProviders() }, 'api up');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
