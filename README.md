# Ollive Inference Logger

LLM inference logging & ingestion, end to end: an **auto-instrumenting SDK** intercepts Anthropic/OpenAI calls transparently (JS `Proxy` + `AsyncLocalStorage` — zero changes at call sites), buffers events, and ships them over batched HTTP into **Kafka**; an **idempotent worker** redacts PII, derives metadata, and batch-writes to **Postgres**; **dashboards** with full drill-down read bounded aggregate SQL. A chat UI (streaming, resume, cancel) proves the backend.

Two properties anchor every design decision: **instrumentation can never hurt the host app** (the SDK never throws or blocks the request path — telemetry degrades to counted drops), and **logs are treated as evidence** (effectively-once landing via idempotent keys, observable duplicate rates, always-redacted storage, dead-letters that are replayable rather than lost).

```
Next.js UI ──SSE──► Chat API (Fastify) ──► Anthropic / OpenAI
                        │       ▲ clients wrapped by @ollive/sdk at construction
                        └── SDK ──batched HTTP──► Ingest API ──► Kafka (6 partitions)
                                                                    │ consumer group
                                                                    ▼
                              Worker: redact PII → derive metadata → batch INSERT
                                      ON CONFLICT (request_id) DO NOTHING → Postgres
                                                                    │ poison / retries exhausted
                                                                    ▼
                                                     inference.dlq + ingest_failures (replayable)
Dashboards ◄── cost · p50/p95/p99 · TTFT · req/min · errors · tokens · drill-down ◄── Postgres
```

## How to run

**Prerequisites:** Docker with Compose v2.20+, and at least one provider key (`ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY`) — there is no mock provider.

```bash
cp .env.example .env          # put your provider key(s) in here
docker compose up --build     # ONE command: postgres, kafka, topics, migrations, api, ingest, worker, valkey, web
```

Then:
- **Chat:** http://localhost:3000 — pick provider/model, stream a reply, hit **Stop** mid-generation, resume any conversation from the sidebar.
- **Dashboards:** http://localhost:3000/dashboard — cost, latency percentiles + TTFT, throughput, errors, token economics, model comparison; every element clicks through to the requests explorer (`/requests`) and per-request trace view.
- **Demo data:** `make traffic` (needs Node 20+ and pnpm) fires ~30 real cheap-model requests incl. genuine provider errors (~$0.01 total).
- **Verify everything:** `make smoke` — 9 end-to-end assertions: event→row delivery, stored-redacted previews, idempotent redelivery, auth, per-item rejection, poison→DLQ, live chat telemetry, cancel-mid-stream, analytics sanity.
- **Unit tests:** `pnpm install && pnpm test` (42 tests) · `pnpm -r typecheck`.

### Run on self-hosted Kubernetes (bonus)

```bash
./scripts/k8s-up.sh                    # k3d cluster → build → import → deploy → NodePorts
# web http://localhost:30080 · api http://localhost:30040
```

On a cloud VM (Ubuntu 22.04+, 4 vCPU/8GB): `scripts/vm-deploy.sh` installs docker+k3d+kubectl, clones this repo, deploys, and injects your keys — see the header of that script. `infra/k8s/README.md` covers layout and scaling (`kubectl -n ollive scale deploy/worker --replicas=6`).

A Terraform reference for a managed-AWS footprint (ECS Fargate, MSK, RDS Multi-AZ, ALB+WAF, OIDC CI/CD) lives in `infra/terraform/` — validated, not applied; it documents how this scales beyond a single box.

## Architecture overview

**Ingestion flow.** Provider clients are wrapped once at construction (`apps/api/src/clients.ts`); a `Proxy` intercepts exactly one method per provider (`messages.create`, `chat.completions.create`) — streaming responses are themselves instrumented so consumption records time-to-first-token, output previews, usage, and terminal status (success/error/cancelled — including aborts the provider SDK swallows). `AsyncLocalStorage` carries conversation/message/session ids with zero threading. Events buffer client-side (flush at 50 or 2 s, retries with backoff, bounded drop-oldest overflow) → the stateless ingest API authenticates per-tenant keys (sha256-hashed at rest, cached lookups), Zod-validates **each event independently** (`202 {accepted, rejected, errors[]}`), and produces one idempotent gzip batch to Kafka keyed `tenant:conversation` (per-conversation ordering with parallelism). The worker consumes with manual offset resolution: redact → derive (tokens/sec, estimated cost, ingest lag) → 100-row `INSERT … ON CONFLICT (request_id) DO NOTHING` → **commit only after the DB write**. Measured on a laptop: ~10,600 events/s accepted; 10k events queryable <1 s after the last POST; 0.13 s single-event POST→row.

**Logging strategy.** Auto-instrumentation, not manual `log()` calls — wrapping the client is the entire integration, and the SDK has no dependency on the provider SDKs (structural interception). Previews are capped at 500 chars; the full redacted event is kept as `raw jsonb` (schema-evolution escape hatch). Events carry `schema_version`; one shared Zod contract drives SDK, ingest, and worker.

**Event-based architecture & failure handling.** At-least-once delivery + idempotent sink = effectively-once rows; duplicates are absorbed *and counted* (`duplicatesTotal` in worker stats). SDK buffer overflow → bounded, counted drops (chat never blocks on telemetry). Ingest down → SDK retries then drops. Kafka down → ingest 503s (stateless, nothing buffered); fatal producer-id errors self-heal. Worker crash → uncommitted offsets redeliver; the conflict clause absorbs. DB down → bounded retries → DLQ (with source topic/partition/offset headers) + a queryable `ingest_failures` mirror; `make replay-dlq` re-drives replayable entries — safe to re-run, the sink dedupes. Poison messages dead-letter without stalling the partition (oversized ones are gzip'd/truncated rather than wedging it). Consumer lag, batch sizes, duplicates and DLQ counts log every 30 s.

**Security.** Per-tenant API keys (`scripts/create-tenant.sh` — hash-stored, shown once), tiered rate limiting (per-IP on chat, per-key on ingest), helmet + CORS allowlist, slowloris/request timeouts, hard per-generation timeout, prompt-injection heuristics (OWASP LLM01) detected at the chat boundary and derived into a queryable `flagged_injection` column with dashboard surfacing (`GUARDRAILS_BLOCK=true` upgrades detection to blocking), and stored LLM content always rendered as escaped text (LLM05).

## Schema design decisions

Five tables (`infra/migrations/`, plain SQL applied by an atomic runner):

- **`conversations` / `messages` — domain data.** FK with cascade; `UNIQUE (conversation_id, seq)` gives ordered, resumable history; message `status` records cancelled/error partials.
- **`inference_logs` — telemetry.** Deliberately **no FK to the domain**: logs survive domain deletes, tolerate out-of-order arrival, and accept events from any instrumented app. `request_id UNIQUE` (UUIDv7 — time-sortable, index-friendly) is the pipeline-wide idempotency key. Worker-derived columns: `tokens_per_sec`, `est_cost_usd`, `ingest_lag_ms`, `flagged_injection`, `tenant_id`.
- **`tenants`** — key hashes only, per-tenant rate limits. **`ingest_failures`** — dead-letter mirror for SQL triage (the DLQ topic is canonical).

Indexes are query-driven, one per dashboard shape: `idx_logs_started` (every time-window aggregate), `idx_logs_prov_model` (model filters), **partial `idx_logs_errors`** (recent-errors is a pure 0.1 ms index walk), `idx_logs_conversation` (drill-down), `idx_logs_tenant`. All dashboard SQL is window-bounded + LIMITed under a 5 s `statement_timeout`; writes are batched, never row-by-row.

## Tradeoffs made

- **Kafka over RabbitMQ/Redis Streams:** a retained, replayable log with consumer-group offsets and per-partition ordering is exactly the log-ingestion shape; the cost is the heaviest container in Compose. Single-broker KRaft locally; prod = 3 brokers/RF=3/min.insync.replicas=2 — config, not code (the producer already sends `acks:-1`).
- **Telemetry drops rather than ever blocking the product path** — bounded and counted.
- **At-least-once + idempotent sink over transactions/EOS** — exactly-once machinery doesn't cover external DB sinks anyway; the conflict clause does, provably.
- **Redact telemetry always; domain chat stays raw by default** (users own their history; `REDACT_MESSAGES=true` flips it). Regex+Luhn redaction accepts false negatives; NER is the upgrade path.
- **Last-20-message context, no summarization** — one constant to evolve; long chats lose early context.
- **SQL-first migrations, Drizzle for typed queries only** — reviewers judge real DDL; schema is declared twice (SQL + mirror), drift caught by the smoke suite.
- **tsx runtime, no build step** — legibility over cold-start; a real deploy would compile.

## What I'd improve with more time

Time-based partitioning + retention job and a BRIN index once volume demands it (back-of-envelope: mandatory within weeks at 50 req/s peak) · rollup tables → ClickHouse for the analytics path at 100× · claim-check via S3 for >1MB payloads + raw-event archive for reprocessing beyond Kafka retention · per-tenant dashboards and HMAC request signing · NER-based redaction · async guardrail classifiers over stored previews · OpenTelemetry GenAI-semconv export (the event fields already mirror `gen_ai.*`) · gemini adapter (the contract already carries the enum).
