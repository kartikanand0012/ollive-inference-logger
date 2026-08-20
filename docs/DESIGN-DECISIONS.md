# Design Decisions & Trade-offs

Why each load-bearing choice was made, what the alternatives were, and what the
choice costs. Grouped by theme; each record is *decision → why → alternatives →
trade-off accepted*. Companion to [ARCHITECTURE.md](ARCHITECTURE.md) and
[SCHEMA.md](SCHEMA.md).

The two principles everything is measured against:

- **Instrumentation must never hurt the host app** — the SDK cannot throw into or
  block the request path.
- **Logs are evidence** — effectively-once landing, observable duplicates, always
  redacted, replayable failures.

---

## 1. Interception: auto-instrument, don't ask the developer to log

**Decision.** Wrap the provider client once, at construction, with a JS `Proxy`
that intercepts exactly one method path (`messages.create`,
`chat.completions.create`). Correlation ids ride in `AsyncLocalStorage` entered at
the route boundary. There are zero `log()` calls at call sites.

**Why.** The brief called out auto-instrumentation as the highest-signal option.
Manual logging rots — every new call site is a chance to forget a field. Wrapping
at construction means the integration surface is one line per provider and it
cannot be bypassed. Because the wrapper is *structural* (it depends on the method
shape, not the provider SDK), it instruments any client shaped like Anthropic's or
OpenAI's, and streaming responses are themselves wrapped so *consumption* —
time-to-first-token, output preview, terminal status — is what gets recorded.

**Alternatives.** Manual `log()` calls (forgettable, invasive); a Fastify
pre-handler hook to seed context (can't know a `conversationId` the route itself
creates two statements later — so context is entered explicitly *after*
get-or-create instead).

**Trade-off accepted.** One explicit `runWithInferenceContext(...)` wrapper in the
route rather than a fully invisible global hook — in exchange, no id is ever
threaded through an adapter or call site.

---

## 2. Event bus: Kafka over RabbitMQ / Redis Streams

**Decision.** Apache Kafka (KRaft mode, single broker in Compose) as the durable
buffer between the stateless ingest API and the Postgres writer.

**Why.** The requirements were: absorb bursts without backpressuring producers,
survive a writer crash with zero loss, replay after a consumer bug, preserve
per-conversation ordering, and make horizontal scaling a config change. Kafka is
the only one of the three that gives all five at once:

| | Kafka | RabbitMQ | Redis Streams |
|---|---|---|---|
| Delivery + offsets | at-least-once, **consumer-controlled commit** (commit after DB write) | per-message ack; redelivery reorders under concurrency | groups + PEL, but crash recovery is manual `XAUTOCLAIM` you schedule |
| Replay / retention | retained log — rewind and rebuild | classic/quorum queues delete on ack | retained only within `MAXLEN`/RAM |
| Ordering + parallelism | total order per partition; key = conversation → order **with** parallelism | ordering lost the moment there's >1 consumer | ordered per stream; parallelism needs hand-rolled sharding |
| Scaling model | partitions are first-class parallelism; add a consumer | — | bespoke |

Log ingestion **is** Kafka's home domain — this pipeline is a miniature
OTel-collector shape, and consumer lag is a first-class backlog metric.

**Trade-off accepted.** Kafka is the heaviest container in Compose (JVM, ~700 MB,
slow cold start) and single-broker RF=1 locally means no broker-loss tolerance.
Both are bought down in prod by a **config** change, not code: 3 brokers, RF=3,
`min.insync.replicas=2` — the producer already sends `acks:-1`.

---

## 3. Delivery: at-least-once + idempotent sink, not exactly-once

**Decision.** Don't use Kafka transactions / EOS. Instead: mint a UUIDv7
`request_id` once in the SDK, carry it end-to-end, and enforce it at the sink with
`INSERT … ON CONFLICT (request_id) DO NOTHING`. Commit offsets only after the DB
write. Make the idempotent producer explicit (`idempotent: true`) so produce
retries don't double-append.

**Why.** Exactly-once semantics in Kafka only covers Kafka→Kafka flows; the moment
you write to an external database, the sink must be idempotent *regardless*. So the
conflict clause is doing the real work either way — and it does it provably, with
far less machinery. Duplicates are absorbed **and counted** (`RETURNING` →
`duplicatesTotal` in the 30 s stats line), so redelivery volume is observable
rather than silent.

**Alternatives.** Kafka transactions/EOS (heavy machinery to guarantee what the
sink already guarantees); a transactional outbox (applies to DB-first workflows
emitting events, not an ingest pipeline whose DB write *is* the terminal step).

**Trade-off accepted.** `maxInFlightRequests: 1` serializes in-flight produce
requests (negligible at telemetry volume). A crash mid-batch redelivers the whole
unresolved slice — the conflict clause absorbs the duplicate rows.

---

## 4. SDK failure policy: telemetry drops, the request never blocks

**Decision.** In-memory buffer, flush at 50 events or 2 s; 3 retries with
exponential backoff + jitter per POST; overflow (>1000) drops **oldest**;
non-retryable 4xx drops immediately; every drop increments a `dropped` counter.
Nothing in the SDK ever throws into, or awaits on, the chat path.

**Why.** Principle 1. Telemetry that can slow or break the product is worse than no
telemetry. Bounding the buffer and dropping under sustained outage keeps the blast
radius to "some events lost, and we counted them."

**Alternatives.** Disk spooling (ops complexity unwarranted at this scale);
blocking backpressure (unacceptable — telemetry would degrade the product);
dropping *newest* (older events more likely already partially delivered context, so
dropping oldest keeps the freshest picture).

**Trade-off accepted.** Under a sustained ingest outage telemetry is lost silently —
bounded by, and visible in, the `dropped` counter. The chat product is never
impacted.

---

## 5. Worker: manual offsets, chunked upserts, DLQ with provenance

**Decision.** Consume with `eachBatch` + manual resolution. Process strictly in
partition order; buffer valid events and flush one multi-row `INSERT … ON CONFLICT
DO NOTHING` every ≤100 rows; after each flush resolve the highest offset seen and
commit; heartbeat per message. Poison → DLQ produce (must succeed) + best-effort
`ingest_failures` mirror. DB-retry exhaustion (3× backoff) dead-letters the chunk
and moves on. `make replay-dlq` re-drives replayable entries.

**Why.** Commit-after-write is the exact contract an idempotent sink wants: an
uncommitted offset after a crash just redelivers, and the conflict clause absorbs
it. Chunked inserts (never row-by-row) are what make 10k events drain in under a
second. The DLQ carries source topic/partition/offset + retry-count headers so a
dead-letter is *diagnosable and replayable*, not just parked — which is the
production failure story the brief asks about.

**Alternatives.** Per-message `resolveOffset` (offset regression when poison
interleaves with chunked flushes); a transactional outbox (overkill — the
idempotent insert already gives effectively-once).

**Trade-off accepted.** A crash mid-batch redelivers the whole unresolved slice
(duplicate rows absorbed; duplicate DLQ entries possible, deduplicable by offset).
`ingest_failures` can't be written when the DB itself is down — which is exactly
why the DLQ **topic** is the canonical record and the table is only a triage
convenience.

Hardening applied after an adversarial read of the kafkajs consumer: per-message
heartbeat (an all-poison batch used to never heartbeat → session-timeout
livelock); a real `autoCommitThreshold` so mid-batch commits aren't a silent no-op;
producer rebuild on fatal producer-id errors (so a broker recreate doesn't 503
forever); gzip'd/truncated DLQ sends so an oversized poison message can't wedge its
partition.

---

## 6. Schema: split domain from telemetry, no FK on logs

**Decision.** `conversations`/`messages` are domain data with a cascading FK;
`inference_logs` is telemetry with **no** FK into the domain — `conversation_id` /
`message_id` are opaque correlation ids. Full detail in [SCHEMA.md](SCHEMA.md).

**Why.** Three properties fall out of the missing FK: logs **survive domain
deletes** (a GDPR erase mustn't wipe cost history), logs **tolerate out-of-order
arrival** (an async-flushed event can land before its message row commits), and the
logger **accepts events from any instrumented app** (a second service's
`conversation_id`s this DB has never seen). An FK would reject all three.

**Trade-off accepted.** Log→conversation joins are best-effort (`LEFT JOIN`); a log
can reference a `conversation_id` with no matching row. For telemetry that is
correct — each event is a self-contained terminal fact.

---

## 7. Indexes: query-driven, with partial indexes for the needles

**Decision.** One index per real dashboard shape (see the query→index table in
[SCHEMA.md](SCHEMA.md)). Two are **partial**: `idx_logs_errors` (only `status =
'error'`) and `idx_logs_flagged` (only `flagged_injection`).

**Why.** The interesting rows — errors, attack attempts — are a tiny fraction of
the table. A partial index contains only them, pre-ordered, so the "recent errors"
and "flagged inputs" queries become straight index walks with no filter step
(measured 0.12 ms for the top-50 errors). All dashboard SQL is additionally
window-bounded, `LIMIT`ed, and capped by a 5 s `statement_timeout`.

**Trade-off accepted.** Every index is write amplification; kept minimal and
justified by a named query. The conversation-list query intentionally *isn't*
specially indexed beyond `updated_at` — it's a tiny domain table.

---

## 8. Migrations: hand-written SQL, Drizzle for typed queries only

**Decision.** Numbered plain-SQL DDL in `infra/migrations/` is the single source of
truth, applied by a ~20-line `psql` runner with a `schema_migrations` table
(idempotent, one transaction per file). Drizzle table definitions mirror the SQL
for typed queries; `drizzle-kit` codegen is not used.

**Why.** The brief asks reviewers to judge schema design — so the SQL should be the
thing they read, not output hidden behind an ORM's migration generator. All
migrations are additive (add-only, default-backfilled columns) so they apply to a
live table without a rewrite.

**Trade-off accepted.** The schema is declared twice (SQL + Drizzle mirror); drift
is caught by the smoke suite hitting real tables, not by a compiler.

---

## 9. PII redaction: telemetry always, domain data by flag

**Decision.** The worker redacts previews + error messages on **every** event
before storage — `inference_logs` never holds unredacted content, whichever
producer sent it. Chat `messages` stay raw by default; `REDACT_MESSAGES=true` flips
the API to redact domain content too. Redaction is a table-driven regex + Luhn pass
in `packages/shared`.

**Why.** Redaction placed at the sink means it holds regardless of which app
produced the event — you can't forget it at a call site. Domain chat stays raw
because the user owns their own history; forcing redaction there would corrupt the
product.

**Alternatives.** NER (Presidio) — higher recall, real cost/latency; it's the
documented upgrade path.

**Trade-off accepted.** Regex redaction has false negatives (novel formats) and
rare false positives (a 12-digit id matching the Aadhaar shape) — acceptable at
telemetry-preview granularity, and the point where NER earns its cost is noted.

---

## 10. Security: detect-first guardrails, and an edge/in-app split

**Decision.** Prompt-injection heuristics (OWASP LLM01) run at the chat boundary in
**log-only** mode by default (`GUARDRAILS_BLOCK=true` enforces) *and* are derived by
the worker into a queryable `flagged_injection` column. Tiered rate limits (per-IP
on chat, per-key on ingest), helmet + CORS allowlist, slowloris/request timeouts, a
hard per-generation timeout, and 1 MB body caps. Stored LLM content always renders
as auto-escaped React text (OWASP LLM05).

**Why.** For a runtime-governance product, an attack *attempt* is a deliverable, not
noise — so injection detection becomes queryable **evidence** with a dashboard stat,
rather than a silent block. Detect-first avoids punishing legitimate users on a
false positive while still capturing the signal. The rest of the surface (floods,
bots, signature exploits) is explicitly assigned to the **edge** (WAF/ALB) in the
[production plan](PRODUCTION.md); in-app limits handle the tenant-fairness and
cost-amplification cases the edge can't see.

**Alternatives.** An inline guardrail *classifier model* in the ingest hot path
(double-digit ms + GPU cost against a measured ~10.6k events/s path — async
classification over stored previews is the roadmap); blocking flagged inputs by
default (false positives punish real users).

**Trade-off accepted.** Regex heuristics have false negatives; rate-limit state is
per-instance (multi-instance → shared store, same note as the cancel map).

---

## 11. Multi-tenancy: hashed keys, cached lookups, tenant as a Kafka header

**Decision.** A `tenants` table stores **only** sha256 key hashes; keys are shown
once at mint. Ingest resolves a key with a read-only pool + 60 s cache (10 s
negative cache), fails closed on unknown keys, and degrades to the env bootstrap
key if the DB is down. The tenant id travels as a Kafka **header** — the event
payload stays the untouched SDK contract — and the partition key becomes
`tenant:conversation`.

**Why.** Tenant identity is the cheapest thing to add now and the most expensive to
retrofit after the schema hardens, so it went in first. Carrying tenant as a header
keeps the wire contract stable; caching keeps the hot path DB-free; hashing means a
DB leak doesn't leak usable keys.

**Trade-off accepted.** Ingest now holds a read-only DB dependency — but cached,
bounded, and fail-closed, so the statelessness that matters (no writes, no
per-request state) is preserved. Key revocation takes ≤60 s (the cache TTL).

---

## 12. Runtime & deployment ergonomics

**Decision.** TypeScript everywhere (Node 20, strict), run directly via `tsx` with
no backend build step; pnpm workspaces; one-command `docker compose up`; k3d/k8s
manifests + a `tofu validate`-clean Terraform AWS reference for the scale story.

**Why.** One language across SDK/API/worker/UI keeps the take-home legible; `tsx`
removes build-order ceremony and stale-dist bugs; Compose makes "it just works" on a
reviewer's machine the default.

**Trade-off accepted.** `tsx` in production images means slightly slower cold start
and no compile-time dead-code elimination — acceptable at this scale; a real deploy
would compile. Terraform is validated but unapplied until an AWS account exists.

---

## What I'd change with more time

Time-partitioning + retention job and a BRIN index once volume demands it
(mandatory within weeks at 50 req/s peak) · rollup tables → ClickHouse for the
analytics path at 100× · claim-check via S3 for >1 MB payloads + a raw-event
archive for reprocessing beyond Kafka retention · per-tenant dashboards + HMAC
request signing · NER-based redaction · async guardrail classifiers over stored
previews · OpenTelemetry GenAI-semconv (OTLP) export — the event fields already
mirror `gen_ai.*` · a Gemini adapter (the contract already carries the enum).
