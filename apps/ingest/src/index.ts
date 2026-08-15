import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { CompressionTypes, Kafka, logLevel } from 'kafkajs';
import pg from 'pg';
import { InferenceEventV1Schema, TOPIC_EVENTS, type InferenceEventV1 } from '@ollive/shared';

// Ingest is deliberately stateless: validate → produce → 202. No DB writes —
// Kafka retention is the buffer, the worker owns persistence. That separation
// is the event-architecture story (producers fast, consumers absorb bursts).

const env = {
  port: Number(process.env.INGEST_PORT ?? 4318),
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:29092').split(','),
  ingestKey: process.env.INGEST_KEY ?? 'dev-ingest-key',
  /** Requests/minute per ingest key (one request carries up to 50 events). */
  rateLimitPerMin: Number(process.env.INGEST_RATE_LIMIT ?? 600),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://ollive:ollive@localhost:5432/ollive',
};

// ── Tenant auth ──────────────────────────────────────────────────────────────
// Keys resolve to tenants via sha256 lookup against the tenants table —
// READ-ONLY with a 60s in-memory cache, so ingest stays write-free and the
// hot path almost never touches the DB. The env INGEST_KEY remains a
// bootstrap alias for the 'default' tenant (compose/dev keeps working).
// Unknown keys fail closed; a DB outage degrades to bootstrap-key-only.
const authPool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3_000,
});

interface Tenant {
  id: string;
  rateLimitPerMin: number;
}
const tenantCache = new Map<string, { tenant: Tenant | null; expires: number }>();
const TENANT_CACHE_MS = 60_000;
const NEGATIVE_CACHE_MS = 10_000;

async function resolveTenant(key: string | undefined): Promise<Tenant | null> {
  if (!key) return null;
  if (key === env.ingestKey) return { id: 'default', rateLimitPerMin: env.rateLimitPerMin };
  const hash = createHash('sha256').update(key).digest('hex');
  const cached = tenantCache.get(hash);
  if (cached && cached.expires > Date.now()) return cached.tenant;
  try {
    const res = await authPool.query(
      'SELECT id, rate_limit_per_min FROM tenants WHERE key_hash = $1 AND active',
      [hash],
    );
    const tenant: Tenant | null = res.rows[0]
      ? { id: res.rows[0].id as string, rateLimitPerMin: Number(res.rows[0].rate_limit_per_min) }
      : null;
    tenantCache.set(hash, {
      tenant,
      expires: Date.now() + (tenant ? TENANT_CACHE_MS : NEGATIVE_CACHE_MS),
    });
    return tenant;
  } catch (err) {
    app.log.error(err, 'tenant lookup failed (db unreachable) — failing closed for non-bootstrap keys');
    return null;
  }
}

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  bodyLimit: 1024 * 1024, // 1MB cap — backpressure boundary for the SDK
  requestTimeout: 15_000, // slowloris hardening: drip-fed bodies get cut off
});

await app.register(helmet, { contentSecurityPolicy: false });
// DoS guard, keyed per tenant key (falls back to IP for keyless probes) —
// real system: per-tenant plans. 600 req/min × 50 events ≈ 500 eps
// sustained per key before shedding; raise via INGEST_RATE_LIMIT.
await app.register(rateLimit, {
  max: env.rateLimitPerMin,
  timeWindow: '1 minute',
  keyGenerator: (req) => (req.headers['x-ingest-key'] as string | undefined) ?? req.ip,
  allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
});

const kafka = new Kafka({
  clientId: 'ollive-ingest',
  brokers: env.brokers,
  logLevel: logLevel.WARN,
});
// Idempotent producer: a broker ack lost in transit no longer duplicates the
// batch on retry — sequence numbers dedupe broker-side. Costs
// maxInFlightRequests=1 (ordering guarantee); fine at telemetry volume, and
// the DB conflict clause remains the last line of defense.
//
// Self-healing: kafkajs treats sequence/PID errors (e.g. after the broker's
// storage is recreated) as fatal and never re-inits the producer id —
// the instance would 503 forever. On those errors we rebuild the producer
// (fresh PID) instead (audit finding).
const makeProducer = () => kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
let producer = makeProducer();
let kafkaReady = false;
const attachReadiness = (p: ReturnType<typeof makeProducer>) => {
  p.on(p.events.CONNECT, () => {
    kafkaReady = true;
  });
  p.on(p.events.DISCONNECT, () => {
    kafkaReady = false;
  });
};
attachReadiness(producer);

const FATAL_PRODUCER_ERRORS = new Set([
  'OUT_OF_ORDER_SEQUENCE_NUMBER',
  'UNKNOWN_PRODUCER_ID',
  'INVALID_PRODUCER_EPOCH',
]);
let rebuilding = false;
async function rebuildProducer(): Promise<void> {
  if (rebuilding) return;
  rebuilding = true;
  app.log.warn('rebuilding kafka producer after fatal idempotence error');
  try {
    await producer.disconnect().catch(() => undefined);
    producer = makeProducer();
    attachReadiness(producer);
    await producer.connect();
  } catch (err) {
    app.log.error(err, 'producer rebuild failed');
    kafkaReady = false;
  } finally {
    rebuilding = false;
  }
}

app.get('/healthz', async () => ({ ok: true }));

// Readiness: only true while the Kafka producer connection is alive.
app.get('/readyz', async (_req, reply) =>
  kafkaReady ? { ready: true } : reply.code(503).send({ ready: false, reason: 'kafka disconnected' }),
);

app.post('/v1/logs', async (request, reply) => {
  const tenant = await resolveTenant(request.headers['x-ingest-key'] as string | undefined);
  if (!tenant) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const body = request.body;
  if (!Array.isArray(body)) {
    return reply.code(400).send({ error: 'expected a JSON array of events' });
  }

  // Validate each item independently: accept valid, reject invalid. Rejected
  // items are identified by index with their first schema issue (capped) so
  // producers can debug partially-bad batches.
  const accepted: InferenceEventV1[] = [];
  const rejections: Array<{ index: number; issue: string }> = [];
  for (const [index, item] of body.entries()) {
    const parsed = InferenceEventV1Schema.safeParse(item);
    if (parsed.success) {
      accepted.push(parsed.data);
    } else if (rejections.length < 10) {
      const first = parsed.error.issues[0];
      rejections.push({
        index,
        issue: first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid',
      });
    } else {
      rejections.push({ index, issue: '(truncated)' });
    }
  }
  const rejected = body.length - accepted.length;

  if (accepted.length > 0) {
    try {
      // One send per HTTP batch. Key = conversation_id (fallback request_id):
      // per-conversation ordering, even spread across 6 partitions.
      // acks:-1 is prod-correct by default (all ISRs; equals acks:1 at RF=1).
      await producer.send({
        topic: TOPIC_EVENTS,
        acks: -1,
        compression: CompressionTypes.GZIP,
        messages: accepted.map((e) => ({
          // Tenant prefixes the key: per-conversation ordering is preserved
          // within a tenant, and tenants spread across partitions.
          key: `${tenant.id}:${e.conversation_id ?? e.request_id}`,
          value: JSON.stringify(e),
          // Tenant identity travels as a header — the payload stays the
          // SDK's untouched signed-off contract.
          headers: { 'tenant-id': tenant.id },
        })),
      });
    } catch (err) {
      request.log.error(err, 'kafka produce failed');
      if (FATAL_PRODUCER_ERRORS.has((err as { type?: string }).type ?? '')) {
        void rebuildProducer(); // fire-and-forget; this request still 503s
      }
      // 503 → the SDK's transport retries with backoff, then drops.
      return reply.code(503).send({ error: 'kafka_unavailable' });
    }
  }

  return reply.code(202).send({
    accepted: accepted.length,
    rejected,
    ...(rejected > 0 ? { errors: rejections.slice(0, 10) } : {}),
  });
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await producer.disconnect();
  await authPool.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await producer.connect();
  await app.listen({ port: env.port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
