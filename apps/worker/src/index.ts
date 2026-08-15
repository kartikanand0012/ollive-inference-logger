import { CompressionTypes, Kafka, logLevel, type EachBatchPayload, type KafkaMessage } from 'kafkajs';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import {
  CONSUMER_GROUP_WRITERS,
  InferenceEventV1Schema,
  TOPIC_DLQ,
  TOPIC_EVENTS,
  dbSchema,
  detectPromptInjection,
  estimateCostUsd,
  redactEvent,
  type InferenceEventV1,
} from '@ollive/shared';

// Consumer group `inference-writers`. Delivery contract (stated in
// ARCHITECTURE.md): at-least-once from Kafka + idempotent insert
// (ON CONFLICT (request_id) DO NOTHING) = effectively-once rows.
// Offsets are resolved/committed ONLY after the DB write succeeds, so a
// crash mid-batch redelivers and the conflict clause absorbs duplicates.

const env = {
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:29092').split(','),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://ollive:ollive@localhost:5432/ollive',
  insertChunk: 100,
  dbRetries: 3,
};

const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  // Bounded waits: a black-holed DB (paused container, half-dead TCP) must
  // fail into the retry→DLQ path within a heartbeat interval, not hang the
  // consumer past the session timeout.
  connectionTimeoutMillis: 5_000,
  options: '-c statement_timeout=15000',
});
const db = drizzle(pool, { schema: dbSchema });
const { inferenceLogs, ingestFailures } = dbSchema;

const kafka = new Kafka({ clientId: 'ollive-worker', brokers: env.brokers, logLevel: logLevel.WARN });
const consumer = kafka.consumer({
  groupId: CONSUMER_GROUP_WRITERS,
  // kafkajs default is 5s — at low volume events sat a full fetch-wait before
  // eachBatch fired. 500ms cuts idle end-to-end latency ~10×.
  maxWaitTimeInMs: 500,
  minBytes: 1,
});
const dlqProducer = kafka.producer();
const admin = kafka.admin();

let processedTotal = 0;
let duplicatesTotal = 0;
let dlqTotal = 0;
let lastBatchSize = 0;

const log = (obj: Record<string, unknown>, msg: string) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...obj }));

type LogRow = typeof inferenceLogs.$inferInsert;

function toRow(event: InferenceEventV1, message: KafkaMessage): LogRow {
  // Pipeline-derived metadata (assignment §3 "extracts useful metadata"):
  // values the SDK never sent, computed here at ingestion time.
  const completion = event.usage?.completion_tokens;
  const latency = event.timings.latency_ms;
  const tokensPerSec =
    completion != null && latency != null && latency > 0
      ? Math.round((completion / (latency / 1000)) * 10) / 10
      : null;
  const ingestLagMs = event.timings.completed_at
    ? Math.max(0, Date.now() - new Date(event.timings.completed_at).getTime())
    : null;
  return {
    tokensPerSec,
    estCostUsd: estimateCostUsd(
      event.model,
      event.usage?.prompt_tokens,
      event.usage?.completion_tokens,
    ),
    ingestLagMs,
    // Runtime-governance signal (0003): heuristic OWASP-LLM01 detection over
    // the input — injection ATTEMPTS become queryable telemetry.
    flaggedInjection: detectPromptInjection(event.input_preview).flagged,
    // Stamped by ingest at auth time; payload itself stays the SDK contract.
    tenantId: message.headers?.['tenant-id']?.toString() ?? 'default',
    requestId: event.request_id,
    conversationId: event.conversation_id ?? null,
    messageId: event.message_id ?? null,
    provider: event.provider,
    model: event.model,
    isStream: event.is_stream,
    status: event.status,
    latencyMs: event.timings.latency_ms ?? null,
    ttfbMs: event.timings.ttfb_ms ?? null,
    promptTokens: event.usage?.prompt_tokens ?? null,
    completionTokens: event.usage?.completion_tokens ?? null,
    totalTokens: event.usage?.total_tokens ?? null,
    errorType: event.error?.type ?? null,
    errorMessage: event.error?.message ?? null,
    inputPreview: event.input_preview,
    outputPreview: event.output_preview,
    raw: event, // full redacted event — schema-evolution escape hatch
    requestStartedAt: new Date(event.timings.started_at),
    requestCompletedAt: event.timings.completed_at ? new Date(event.timings.completed_at) : null,
  };
}

async function deadLetter(
  message: KafkaMessage,
  payload: EachBatchPayload,
  error: string,
  retryCount: number,
  parsedPayload?: unknown,
): Promise<void> {
  const rawValue = message.value?.toString() ?? '';
  // DLQ topic is the canonical dead-letter record (throws on failure so the
  // batch is retried rather than the message silently lost). Headers carry
  // provenance so the replay tool can trace and dedupe entries.
  const headers = {
    error: error.slice(0, 500),
    'source-topic': payload.batch.topic,
    'source-partition': String(payload.batch.partition),
    'source-offset': message.offset,
    'retry-count': String(retryCount),
  };
  const send = (value: string, extra: Record<string, string> = {}) =>
    dlqProducer.send({
      topic: TOPIC_DLQ,
      acks: -1,
      compression: CompressionTypes.GZIP,
      messages: [{ key: message.key, value, headers: { ...headers, ...extra } }],
    });
  try {
    await send(rawValue);
  } catch (err) {
    // A message near the broker's max.message.bytes can be impossible to
    // dead-letter verbatim — retrying forever would wedge the partition.
    // Preserve a truncated copy instead of livelocking (audit finding).
    if ((err as { type?: string }).type === 'MESSAGE_TOO_LARGE') {
      await send(rawValue.slice(0, 512_000), { truncated: 'true' });
    } else {
      throw err;
    }
  }
  dlqTotal++;
  // …the ingest_failures table is the SQL-queryable mirror, best-effort:
  // when the DB itself is the failure it cannot be written.
  try {
    await db.insert(ingestFailures).values({
      kafkaTopic: payload.batch.topic,
      kafkaPartition: payload.batch.partition,
      kafkaOffset: Number(message.offset),
      payload: parsedPayload ?? { raw: rawValue },
      error: error.slice(0, 2000),
      retryCount,
    });
  } catch (err) {
    log({ err: String(err) }, 'ingest_failures mirror write failed (DLQ row is canonical)');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Single multi-row idempotent insert with bounded retries.
 * Returns true on success, false when retries are exhausted. Duplicates
 * (conflict-skipped rows) are counted — absorbed silently by the sink, but
 * visible in the stats line so redelivery volume is observable.
 */
async function insertBatch(rows: LogRow[], heartbeat: () => Promise<void>): Promise<boolean> {
  for (let attempt = 0; attempt <= env.dbRetries; attempt++) {
    try {
      const inserted = await db
        .insert(inferenceLogs)
        .values(rows)
        .onConflictDoNothing({ target: inferenceLogs.requestId })
        .returning({ requestId: inferenceLogs.requestId });
      duplicatesTotal += rows.length - inserted.length;
      return true;
    } catch (err) {
      log({ attempt, rows: rows.length, err: String(err) }, 'batch insert failed');
      if (attempt < env.dbRetries) {
        await sleep(2 ** attempt * 250);
        await heartbeat().catch(() => undefined);
      }
    }
  }
  return false;
}

async function eachBatch(payload: EachBatchPayload): Promise<void> {
  const { batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, isRunning, isStale } = payload;

  let pending: Array<{ row: LogRow; event: InferenceEventV1; message: KafkaMessage }> = [];
  let lastOffset: string | null = null;

  const flush = async (): Promise<void> => {
    if (pending.length > 0) {
      const chunk = pending;
      pending = [];
      const ok = await insertBatch(chunk.map((p) => p.row), heartbeat);
      if (!ok) {
        // Retries exhausted → dead-letter each event, keep the pipeline moving.
        for (const p of chunk) {
          await deadLetter(p.message, payload, 'db insert failed after retries', env.dbRetries, p.event);
        }
      }
      processedTotal += chunk.length;
    }
    if (lastOffset !== null) {
      resolveOffset(lastOffset);
      await commitOffsetsIfNecessary();
    }
    await heartbeat();
  };

  lastBatchSize = batch.messages.length;
  for (const message of batch.messages) {
    if (!isRunning() || isStale()) break;
    let event: InferenceEventV1 | null = null;
    let parseError = '';
    try {
      const parsed = InferenceEventV1Schema.safeParse(JSON.parse(message.value?.toString() ?? ''));
      if (parsed.success) event = parsed.data;
      else parseError = `schema: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`;
    } catch (err) {
      parseError = `json: ${String(err)}`;
    }

    if (event) {
      pending.push({ row: toRow(redactEvent(event), message), event, message });
    } else {
      // Poison message → DLQ + mirror row; offset resolves with the batch.
      await deadLetter(message, payload, parseError, 0);
    }
    lastOffset = message.offset;
    if (pending.length >= env.insertChunk) await flush();
    // kafkajs throttles this internally to the heartbeat interval — without
    // it, an all-poison batch (which never flushes) can starve the session
    // past the timeout and livelock into endless redelivery (audit finding).
    await heartbeat();
  }
  await flush();
}

// Observability: processed count, last batch size, and true consumer lag
// (committed group offsets vs latest topic offsets) every 30s.
async function reportStats(): Promise<void> {
  try {
    const [groupOffsets, topicOffsets] = await Promise.all([
      admin.fetchOffsets({ groupId: CONSUMER_GROUP_WRITERS, topics: [TOPIC_EVENTS] }),
      admin.fetchTopicOffsets(TOPIC_EVENTS),
    ]);
    const committed = new Map(
      groupOffsets[0]?.partitions.map((p) => [p.partition, p.offset]) ?? [],
    );
    let lag = 0;
    for (const p of topicOffsets) {
      const c = committed.get(p.partition);
      const base = c && c !== '-1' ? Number(c) : Number(p.low);
      lag += Math.max(0, Number(p.high) - base);
    }
    log({ processedTotal, duplicatesTotal, dlqTotal, lastBatchSize, lag }, 'worker stats');
  } catch (err) {
    log({ err: String(err) }, 'stats collection failed');
  }
}

let statsTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log({ signal }, 'shutting down: finishing in-flight batch');
  if (statsTimer) clearInterval(statsTimer);
  // consumer.disconnect() waits for the in-flight eachBatch to finish; offsets
  // for completed work were already committed inside flush().
  await consumer.disconnect().catch(() => undefined);
  await dlqProducer.disconnect().catch(() => undefined);
  await admin.disconnect().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

async function main(): Promise<void> {
  await dlqProducer.connect();
  await admin.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC_EVENTS, fromBeginning: true });
  statsTimer = setInterval(() => void reportStats(), 30_000);
  log({ brokers: env.brokers, group: CONSUMER_GROUP_WRITERS }, 'worker up');
  await consumer.run({
    eachBatchAutoResolve: false,
    autoCommit: true,
    // Without a threshold, kafkajs's no-arg commitOffsetsIfNecessary() is a
    // no-op mid-batch and offsets only commit at batch end (audit finding —
    // verified against kafkajs 2.2.4 offsetManager). With it, every ≤100-row
    // flush genuinely commits, bounding redelivery after a crash to one chunk.
    autoCommitThreshold: env.insertChunk,
    // Batches from up to 3 partitions processed concurrently — per-partition
    // order is preserved (what matters per-conversation); cross-partition
    // parallelism just raises single-worker throughput.
    partitionsConsumedConcurrently: 3,
    eachBatch,
  });
}

main().catch((err) => {
  log({ err: String(err) }, 'worker fatal');
  process.exit(1);
});
