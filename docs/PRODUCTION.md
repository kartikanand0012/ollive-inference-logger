# Production Plan — from `docker compose up` to cloud

How this system goes to production: what the architecture already gets right against the platforms in this space, the ranked gap list, the security posture, a costed AWS reference deployment, and a phased rollout. Grounded in how Langfuse v3, Helicone, PostHog, Segment, and the OpenTelemetry Collector actually run their ingestion pipelines (sources at the bottom of each section's research trail in the design notes).

## 1. Where we already match production systems

Langfuse v3, Helicone, and PostHog all converged on the same skeleton — **thin stateless ingest gateway → durable log (Kafka/Redis) → consumer group with an idempotent batch sink + DLQ + replay** — which is exactly this repo's shape:

| Production pattern | Who uses it | Us |
|---|---|---|
| At-least-once + idempotent sink (commit-after-write) | Helicone (documented), Langfuse workers | ✅ `ON CONFLICT (request_id)`, offsets commit after DB write, duplicate-rate metric |
| Write-ahead buffering | Langfuse (S3-first), Helicone (Kafka 30 partitions) | ✅ Kafka **is** the buffer (idempotent gzip producer); ⚠ replay window = topic retention (see gap 3) |
| DLQ with provenance + operational replay | Uber's canonical pattern | ✅ headers carry source topic/partition/offset/retry-count; `make replay-dlq` |
| Client-side shedding (never block the host app) | every observability SDK | ✅ drop-oldest buffer, bounded retries, counted drops |
| Server-side load shedding | OTel Collector `memory_limiter`, PostHog overflow topic | ✅ per-key rate limits + 1MB cap + request timeouts (this round); ⚠ hot-key overflow topic is a later step |
| Contract versioning | Confluent schema registry | ✅ lightweight form: `schema_version` field + single shared Zod package + add-only-optional-fields rule; full registry is a scale trigger |
| Domain/telemetry storage split | Langfuse & Helicone (Postgres + ClickHouse + S3) | ✅ split tables/no-FK now; ClickHouse tier is the documented 100× step |
| Outbox pattern | — | Correctly **not** used: Kafka-first ingestion has no dual-write to reconcile |

## 2. Ranked production gaps (the honest list)

1. **Per-tenant identity — ✅ IMPLEMENTED (migration 0004).** `olv_live_…` keys minted by `scripts/create-tenant.sh`, **only sha256 hashes stored** (`tenants` table with per-tenant rate-limit column); ingest resolves keys via a read-only cached lookup (60s TTL, negative-cache 10s, fail-closed for unknown keys, env-key bootstrap alias for the `default` tenant); tenant id travels as a Kafka header (payload stays the SDK contract), partition key becomes `tenant:conversation` (per-conversation ordering preserved within a tenant), and lands in `inference_logs.tenant_id` with a tenant-scoped index. Verified live: minted key → 202 → row with `tenant_id='acme'`; bogus key → 401. Remaining: per-tenant limit values feeding the limiter, tenant-scoped dashboards.
2. **Claim-check for large payloads (SHOULD → MUST if full bodies become a product requirement).** LLM telemetry is exactly the workload that exceeds a 1MB cap (long contexts, tool transcripts). Pattern (Helicone, Langfuse, Azure "Claim Check"): bodies over a threshold go to S3/MinIO, only the reference travels through Kafka.
3. **Raw-event archive (SHOULD).** Today a worker bug (bad redaction rule) is unrecoverable beyond Kafka retention because only post-redaction rows are stored. Tee accepted batches to S3 at the gateway → full-history reprocessing.
4. **Retention automation (SHOULD).** pg_partman time-partitions on `inference_logs` + partition-drop retention job (the capacity math in HLD §6 makes this mandatory in weeks at target load), explicit `retention.ms` on topics.
5. **Hot-key overflow (NICE).** PostHog-style: a conversation key exceeding N events/min diverts to an overflow topic with relaxed ordering, so one chatty agent can't hot-spot a partition.

## 3. Security posture

**Implemented in this repo (verified live):** per-key/per-IP tiered rate limiting (`@fastify/rate-limit` ≥ 11.2.0 — earlier versions had a bypass CVE; measured: 118×200 → 12×429 at the budget), helmet security headers, CORS allowlist via `CORS_ORIGIN`, slowloris request timeouts, 1MB body caps, per-generation hard timeout (`CHAT_TIMEOUT_MS`), Zod on every input + parameterized SQL, **prompt-injection heuristics (OWASP LLM01)** — detected on chat input (log-only by default, `GUARDRAILS_BLOCK=true` to enforce) *and* derived into the `flagged_injection` telemetry column, because for a governance product, *evidence of attack attempts is the deliverable* (EU AI Act / NIST AI RMF framing), **improper-output-handling defense (OWASP LLM05)** — all stored LLM content renders as auto-escaped React text, zero `dangerouslySetInnerHTML`, no markdown execution, always-on PII redaction before storage (LLM02), deep `/readyz` probes, and SDK/API failure isolation.

**Cloud musts (edge + infra, in the deployment below):** per-tenant keys (gap 1) + optional HMAC request signing (Stripe-style `t=<ts>,v1=hmac(body)` with a replay window); AWS WAF managed rule groups + rate-based rules in front of the ALB (volumetric floods die at the edge — in-app limits handle tenant fairness the edge can't see); Kafka SASL/SCRAM + TLS + per-service ACLs; Postgres TLS + `scram-sha-256` + least-privilege roles (worker: INSERT-only on telemetry; api: no DDL); encryption at rest (EBS/RDS default KMS); secrets in SSM Parameter Store (Secrets Manager only for rotating DB creds); audit logging of auth events and access-to-logs (the log system itself must have logs). Explicitly deferred: an inline guardrail classifier model in the hot path (double-digit ms + GPU cost against a 10.6k events/s path; async classification over stored previews is the roadmap).

## 4. Target AWS architecture (~$550–650/month minimal HA, us-east-1)

```
Route53 → CloudFront (later) → ALB (ACM TLS, WAF: managed rules + rate-based)
   ├── /            → ECS Fargate: web (Next.js standalone)
   ├── /v1/chat,…   → ECS Fargate: api ×2  ──► ElastiCache Valkey (cancel pub/sub)
   └── /v1/logs     → ECS Fargate: ingest ×2
                          │ SASL_SSL
                          ▼
                 MSK Provisioned — 3× kafka.t3.small, RF=3, min.insync.replicas=2
                          │
                 ECS Fargate: worker ×1→6 (autoscale on consumer lag, not CPU)
                          │ TLS + scram-sha-256
                          ▼
                 RDS PostgreSQL 16 db.t4g.medium Multi-AZ (100GB gp3)
S3: raw-event archive + claim-check bodies        ECR: images (immutable tags)
CloudWatch: logs (IA class for worker) + alarms   SSM Parameter Store / Secrets Manager
```

Service choices with reasoning (2025–26 pricing):
- **ECS on Fargate** for all five services (~$150/mo, small ARM tasks). Not App Runner — it entered maintenance mode and closes to new customers 2026-04-30; not EKS — $73/mo control plane + K8s ops burden a small team shouldn't carry. ECS Express Mode gives App-Runner ergonomics at no extra charge. (Our kustomize manifests remain the portability story.)
- **MSK Provisioned 3× kafka.t3.small** (~$130/mo incl. EBS) — the only ~$100-floor **in-VPC** managed Kafka; MSK Serverless floors at ~$550/mo before traffic. Redpanda/Confluent free tiers live outside the VPC.
- **RDS PostgreSQL 16 db.t4g.medium Multi-AZ** (~$120/mo with 100GB) over Aurora Serverless v2 — steady telemetry write load is the wrong shape for ACU billing.
- **ALB + ACM (free certs) + WAF** (~$40/mo), **ElastiCache Valkey** (~$10/mo) for the cancel map, **CloudWatch** (~$40/mo), NAT ×1 (~$40/mo), ECR/Route53/misc (~$20/mo).
- **VPC:** 2 AZs (subnet plan for 3 — MSK brokers need distinct AZs), ALB+NAT public, everything else private; security groups chain ALB→apps→MSK/RDS.

**Alarms that matter for THIS pipeline, in order:** consumer lag (MSK `PER_TOPIC_PER_PARTITION` metrics), DLQ depth delta + age-of-oldest, SDK `dropped` counter (emit as a custom metric), ingest 5xx/429 rates, chat p95, RDS storage/connections.

## 5. App changes the cloud move forces (small, already isolated)

1. **Cancel map → Redis pub/sub — ✅ IMPLEMENTED.** With `REDIS_URL` set (compose now ships a Valkey service), cancels publish on `ollive:cancel` and every api replica subscribes; without it, single-instance behavior is unchanged. Verified: smoke's cancel-mid-stream step passes through the bus (`cancel bus: pub/sub enabled` in the api log).
2. **Per-tenant keys — ✅ IMPLEMENTED** (gap 1; `INGEST_KEY` remains the bootstrap alias for `default`).
3. **Topic settings:** RF=3, `min.insync.replicas=2` at creation — producer already sends `acks:-1`; zero code change.
4. **Config:** `CORS_ORIGIN` set to the dashboard origin; `NEXT_PUBLIC_API_URL` baked at image build; SDK knobs via task env. All already env-driven.

## 6. CI/CD — ✅ workflows written (`.github/workflows/ci.yml`, `deploy.yml`)

GitHub Actions → **OIDC** to per-environment IAM roles (trust policy pinned to repo+environment claims — no long-lived AWS keys), pipeline: typecheck + unit tests + smoke against compose → build/push ECR (immutable tags = git SHA) → `terraform plan/apply` (community `terraform-aws-modules/*`; S3-native state locking) → ECS rolling deploy → post-deploy smoke against staging.

**IaC status:** `infra/terraform/` implements §4 (VPC/SGs, RDS Multi-AZ, MSK 3-broker TLS+SCRAM with RF=3 defaults, Valkey, ECS Fargate ARM ×5 services, ALB path routing, WAF managed+rate rules, ECR immutable, GitHub-OIDC deploy role) — **`tofu validate`-clean; not yet applied** (needs an AWS account: state bucket, ACM/domain, MSK SCRAM secret wiring — marked inline).

## 7. Phased rollout (~2–3 weeks part-time)

| Phase | What | Gate |
|---|---|---|
| 0 Foundation | Terraform state, VPC/subnets/SGs, ECR, GitHub OIDC roles | `terraform apply` clean; push an image |
| 1 Data layer | RDS Multi-AZ + migrations; MSK 3-broker + topics RF=3 + DLQ | `psql \dt` via bastion; produce/consume round-trip |
| 2 Services | worker → ingest → api → web on Fargate; Valkey cancel pub/sub | `/readyz` green on all; smoke suite against staging |
| 3 Edge | ALB + ACM + WAF (managed + rate rules); DNS | TLS handshake; WAF blocks a synthetic flood |
| 4 Observability | CloudWatch alarms (lag/DLQ/drops/p95); worker autoscaling on lag | kill a worker task → alarm fires → autoscale recovers |
| 5 Cutover | per-tenant keys, raw-archive tee to S3, runbook, load test at 10× target | game-day: broker restart, DB failover, DLQ replay drill |

GCP equivalents, one line: Cloud Run ↔ Fargate, Managed Kafka/Confluent ↔ MSK, Cloud SQL ↔ RDS, Memorystore ↔ ElastiCache, Cloud Armor ↔ WAF, Artifact Registry ↔ ECR, Workload Identity Federation ↔ OIDC.
