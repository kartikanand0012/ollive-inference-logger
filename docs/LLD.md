# Low-Level Design

Companion to [`ARCHITECTURE.md`](ARCHITECTURE.md) (HLD). This file pins down module boundaries, the exact interfaces, sequences, Kafka configuration, the DB deep-dive with captured plans, and the failure/retry matrix.

## 1. Module map

```
packages/
  shared/      events.ts       InferenceEventV1 (Zod, versioned) — THE wire contract
               redact.ts       pure table-driven PII redaction (+ Luhn)
               db-schema.ts    Drizzle mirror of the SQL schema (single mirror)
               kafka.ts        topic/partition/group constants
               ids.ts          UUIDv7 request ids
  sdk/         context.ts      AsyncLocalStorage<InferenceContext>
               instrument.ts   wrapMethodPath (Proxy), CallRecorder, instrumentStream
               wrap-anthropic.ts / wrap-openai.ts   structural wrappers (no provider deps)
               transport.ts    BufferedTransport (batch/flush/retry/drop policy)
  providers/   types.ts        ProviderAdapter + normalized AdapterEvent
               anthropic.ts / openai.ts             streaming adapters
apps/
  api/         routes/chat.ts  SSE chat, cancel wiring, partial persistence
               routes/conversations.ts  list / resume / cancel / meta
               routes/stats.ts dashboard aggregates (bounded SQL, 5s timeout)
               clients.ts      THE wrap point (one line per provider)
  ingest/      index.ts        auth → per-item validate → kafka produce → 202
  worker/      index.ts        eachBatch consumer: redact → batch insert → commit / DLQ
  web/         chat UI + /dashboard (Recharts)
infra/         docker-compose.yml, migrations/, migrate.sh, kafka-init/, docker/
scripts/       smoke.sh (e2e assertions), generate-traffic.ts (real cheap-model demo load)
```

## 2. Key interfaces (verbatim)

```ts
// packages/providers/src/types.ts
export interface ProviderAdapter {
  readonly provider: Provider;
  streamChat(opts: StreamChatOptions): AsyncGenerator<AdapterEvent, void, undefined>;
}
export type AdapterEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number };
export interface StreamChatOptions {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}

// packages/sdk/src/transport.ts
export interface TransportOptions {
  url: string;
  apiKey: string;
  maxBatch?: number;        // default 50 — flush threshold
  flushIntervalMs?: number; // default 2000
  maxBuffer?: number;       // default 1000 — overflow drops OLDEST
  maxRetries?: number;      // default 3 — exponential backoff + jitter
}

// packages/shared/src/events.ts  (Zod — abbreviated shape)
InferenceEventV1 = {
  schema_version: 1,
  request_id: uuid (v7 from our SDK; any version accepted),
  conversation_id?, session_id?, message_id?,
  provider: 'anthropic' | 'openai' | 'gemini',
  model: string, is_stream: boolean,
  status: 'success' | 'error' | 'cancelled',
  timings: { started_at, first_token_at?, completed_at?, latency_ms?, ttfb_ms? },
  usage?: { prompt_tokens?, completion_tokens?, total_tokens? },
  error?: { type, message },
  input_preview: ≤500 chars, output_preview: ≤500 chars,
  sdk_version: string,
}
```

## 3. Sequence flows

### (a) Streamed chat request, including the abort path

```
UI            Chat API                        Provider            SDK / Transport
 │ POST /v1/chat                                                     
 ├────────────►│ tx: lock conversation (FOR UPDATE), insert user msg,
 │             │     snapshot last-20 context, pre-generate assistantMessageId
 │◄── SSE start│
 │             │ runWithInferenceContext({conversationId, messageId, sessionId})
 │             ├── adapter.streamChat ──► wrapped messages.create({stream:true})
 │             │                          │ CallRecorder: request_id, started_at
 │◄── token ───┤◄── delta ────────────────┤ first chunk → first_token_at
 │    …        │    …                     │ deltas → output preview; usage events
 │                                        │
 │  [Stop] POST /v1/conversations/:id/cancel
 ├────────────►│ cancel map → AbortController.abort()
 │             │  (client disconnect fires the same abort via reply close)
 │             │◄── APIUserAbortError ────┤ recorder.finish('cancelled', partial)
 │             │ persist partial assistant msg (status=cancelled)                │
 │◄── done {cancelled:true}                                                     │
 │             │                                             enqueue → flush(50|2s)
 │             │                                             POST /v1/logs ──► ingest
```

Completion and provider-error paths differ only in terminal status (`complete` / `error`) and, on error with zero output, skipping the assistant row.

### (b) Event lifecycle SDK → Postgres

```
SDK transport ──POST /v1/logs (≤50 events, X-Ingest-Key)──► Ingest
  Ingest: auth → per-item Zod → producer.send(topic=inference.events,
          key=conversation_id||request_id, acks=-1, gzip) → 202 {accepted,rejected}
Kafka: partition = hash(key) % 6 → per-conversation total order
Worker (group inference-writers, eachBatch, autoResolve=false):
  for each message in partition order:
    parse+validate ──fail──► DLQ produce (must succeed) + ingest_failures row (best-effort)
    ok → redactEvent → row buffer
    every ≤100 rows: INSERT … ON CONFLICT (request_id) DO NOTHING
                     (retry 3× backoff ──exhausted──► DLQ + mirror row)
                     resolveOffset(highest seen) → commitOffsetsIfNecessary → heartbeat
```

## 4. Kafka configuration

| Item | Value | Rationale |
|---|---|---|
| Topic `inference.events` | 6 partitions, RF=1 local | partitions = max parallel workers; prod RF=3, `min.insync.replicas=2` |
| Topic `inference.dlq` | 1 partition, RF=1 | low volume; ordering irrelevant |
| Topic creation | one-shot `kafka-init` (kafkajs admin) | broker auto-create disabled — it would silently make 1-partition topics |
| Producer (ingest) | `acks: -1`, **`idempotent: true`** (`maxInFlightRequests: 1`), gzip, one send per HTTP batch | broker-side sequence numbers dedupe produce retries; batch amortizes round trips |
| Partition key | `conversation_id` (fallback `request_id`) | per-conversation order **with** parallelism; uuid keys hash-spread evenly |
| Consumer group | `inference-writers` | scale = add members up to partition count |
| Offset strategy | `eachBatch`, `eachBatchAutoResolve: false`; resolve highest-seen offset after each ≤100-row flush; `autoCommitThreshold=100` so mid-batch commits are real (no-arg `commitOffsetsIfNecessary()` is a no-op without it); `fromBeginning: true` | commit strictly after the DB write; crash → redelivery → idempotent absorb |
| Consumer fetch/concurrency | `maxWaitTimeInMs: 500` (kafkajs default 5000), `minBytes: 1`, `partitionsConsumedConcurrently: 3` | ~10× lower idle end-to-end latency; cross-partition parallelism without breaking per-partition order |
| Duplicate metric | batch insert uses `RETURNING`; conflict-skipped rows → `duplicatesTotal` in the 30s stats line | duplicates stay absorbed but redelivery volume is observable |
| DLQ recovery | `make replay-dlq`: fresh group reads `inference.dlq` from start, re-validates, re-produces replayable events to `inference.events`; headers carry source topic/partition/offset + retry count | failures are recoverable, not just parked; replay is idempotent end-to-end |
| Rebalancing | default cooperative eager; in-flight batch guarded by `isRunning()/isStale()` checks | a revoked partition stops being processed mid-batch; unresolved slice redelivers to the new owner |
| Broker | apache/kafka 3.8.1, KRaft combined mode, dual listeners (`kafka:9092` internal, `localhost:29092` host) | no ZooKeeper; host-side dev without compose rebuilds |

**Ordering guarantee, precisely:** total order per partition ⇒ per-conversation order end-to-end (same key → same partition; worker processes each partition serially). No cross-conversation ordering is guaranteed or needed — each event is a self-contained terminal fact; dashboards order by `request_started_at` (event time), not arrival.

**Idempotency, precisely:** the idempotency key is minted once at event creation (SDK, UUIDv7), travels the whole pipeline, and is enforced at the sink (`request_id UNIQUE` + `ON CONFLICT DO NOTHING`). Any hop may deliver twice — same-batch HTTP retry, producer retry, consumer redelivery — and row count is unaffected (verified in smoke step 3 and the kill-restart test).

## 5. DB deep-dive

### Query → index mapping

| Dashboard query (real SQL in `apps/api/src/routes/stats.ts`) | Served by |
|---|---|
| Model economics table `/v1/stats/models` (percentiles, TTFT p50, token split, tokens/sec, cost via `unnest` pricing join) | `idx_logs_started` (window range scan → aggregate); `idx_logs_prov_model` once a single provider/model filter is applied |
| Requests explorer `/v1/logs` (filter combos + keyset `before` cursor) | `idx_logs_started` (window+time cursor); `idx_logs_prov_model` (model filter); `idx_logs_errors` (status=error); `idx_logs_conversation` (conversation drill-down) |
| Throughput per minute (`date_trunc('minute', …)`, window) | `idx_logs_started` |
| Error rate by provider+model (needs all rows for denominators) | `idx_logs_started` |
| Recent errors table (`status='error' ORDER BY request_started_at DESC LIMIT 50`) | **`idx_logs_errors` partial index** — contains only error rows, pre-ordered; the top-50 is a pure index walk |
| Tokens per model per hour | `idx_logs_started` |
| Summary stat cards (single aggregate row) | `idx_logs_started` |
| Conversation list (`ORDER BY updated_at DESC LIMIT 100`) | seq scan — tiny domain table, honest non-index |
| Resume (`WHERE conversation_id ORDER BY seq LIMIT 500`) | `UNIQUE (conversation_id, seq)` btree |
| Per-conversation log drill-down (`/v1/logs?conversationId=`, linked from the request detail page) | `idx_logs_conversation` |
| Worker upsert conflict check | `inference_logs_request_id_key` (UNIQUE) — UUIDv7 keys are time-sortable → right-leaning, cache-friendly inserts |

Every dashboard query is window-bounded (`request_started_at >= now() - make_interval(...)`) and LIMITed, and runs under `SET LOCAL statement_timeout = '5s'` in its own transaction.

### Captured plans (optimization evidence, 5k+ row set)

p95 latency query — `EXPLAIN (ANALYZE, BUFFERS)`:

```
Limit  (actual time=0.307..0.308 rows=4)
  Buffers: shared hit=185
  -> Sort (count DESC) -> GroupAggregate (provider, model)
     -> Bitmap Heap Scan on inference_logs (actual time=0.023..0.209 rows=183)
          Recheck Cond: (request_started_at >= now() - '01:00:00')
          Filter: ((latency_ms IS NOT NULL) AND (status = 'success'))
          -> Bitmap Index Scan on idx_logs_started (actual time=0.012 rows=207)
               Index Cond: (request_started_at >= now() - '01:00:00')
```

Recent-errors query — the partial-index payoff (top-50 straight off the index, no filtering work):

```
Limit  (actual time=0.011..0.107 rows=50)
  -> Index Scan using idx_logs_errors on inference_logs (rows=50)
       Index Cond: (request_started_at >= now() - '24:00:00')
Execution Time: 0.120 ms
```

### Batch insert & pooling

- Worker: single multi-row `INSERT … ON CONFLICT (request_id) DO NOTHING`, ≤100 rows/statement — never row-by-row (measured: 5,000 events drained in seconds).
- Pools: explicit per service — api and worker `max: 10, idleTimeoutMillis: 30_000`. Total connections bounded at (replicas × 10) + psql sessions, far under Postgres's default 100; a real deploy adds pgbouncer in front before scaling replicas.
- Domain writes serialize per conversation with `SELECT … FOR UPDATE` on the conversation row (seq assignment); `UNIQUE (conversation_id, seq)` backstops.

## 6. Backpressure & flow control, end to end

```
provider stream → SDK buffer (cap 1000, drop-oldest, counted)
               → HTTP batch ≤50 events, body cap 1MB at ingest (413 → SDK drops, non-retryable)
               → Kafka: retention IS the buffer (7d default); producer acks=-1
               → worker pulls at its own pace (consumer lag = the backlog gauge, logged every 30s)
               → DB batch ≤100 rows; statement-level retries
Dashboards: window + LIMIT + statement_timeout 5s — reads can't melt the writer's DB.
```

The product path has no backpressure coupling at all: chat latency never depends on any telemetry component being up.

## 7. Error taxonomy & retry matrix

| Failure | Detected by | Retries | Then | Data outcome |
|---|---|---|---|---|
| Provider 4xx/5xx on chat | adapter throw | none (surfaced to user) | SSE `error` frame; partial msg persisted if any output | log event `status=error` with redacted message |
| User abort / disconnect | AbortSignal | n/a | partial msg persisted `cancelled` | log event `status=cancelled`, partial preview, latency-so-far |
| SDK → ingest network/5xx/429 | fetch failure/status | 3× expo+jitter (250/500/1000ms) | drop + count | bounded telemetry loss |
| SDK → ingest 4xx (≠429) | status | 0 | drop + count | bounded telemetry loss |
| Ingest → Kafka produce failure | kafkajs throw | kafkajs internal retries, then | HTTP 503 to SDK (which retries per above) | no loss until SDK gives up |
| Worker JSON/schema poison | parse/validate | 0 | DLQ + `ingest_failures` | preserved, replayable |
| Worker → DB transient | insert throw | 3× expo (250/500/1000ms) + heartbeat | DLQ + best-effort mirror row; offsets advance | preserved, replayable |
| Worker → DLQ produce failure | kafkajs throw | batch fails | Kafka redelivers slice | at-least-once dead-lettering (offset-deduplicable) |
| Worker crash | — | — | uncommitted offsets redeliver | absorbed by `ON CONFLICT` (volume visible via `duplicatesTotal`) |
| Dead-lettered events (post-mortem) | operator | manual | `make replay-dlq` re-drives replayable entries through the pipeline | recovered; sink dedupes re-runs |
| Dashboard query > 5s | `statement_timeout` | 0 | 500 to the poller (next poll retries) | reads shed load, writer unaffected |

## 8. Known limits (deliberate, documented)

- Cancel map is in-memory → multi-instance api needs a shared store/pub-sub (HLD §4).
- `ingest_failures` mirror is best-effort during DB outages (DLQ topic is canonical).
- Regex redaction has false negatives by nature; Presidio/NER is the upgrade path.
- Local Kafka has no data volume: recreating the broker container drops unconsumed in-flight events; Postgres is the durable store.
- No auth beyond `X-Ingest-Key` per the brief; real system = per-tenant keys + rate limits.
