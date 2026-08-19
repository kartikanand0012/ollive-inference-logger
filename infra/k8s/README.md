# Self-hosted k8s — verified

**Battle-tested 2026-08-20 on k3d (k3s-in-docker):** all eight workloads rolled
out (postgres, kafka, migrate + kafka-init Jobs, api, ingest, worker, web), a
live streamed chat ran through the in-cluster api → SDK → ingest → Kafka →
worker → Postgres, and the telemetry row landed with latency/TTFT/tokens/
tenant/cost captured. `./scripts/k8s-up.sh` is the single entrypoint
(idempotent; `PUBLIC_HOST=<ip>` bakes the browser-facing api URL).

Cheap cloud deployment: `scripts/vm-deploy.sh` bootstraps a fresh Ubuntu VM
(docker + k3d + kubectl + clone + deploy + keys) — a ~€7–50/mo box, i.e.
pocket change for an assessment window. Prod-shaped AWS lives in `infra/terraform/`.

Layout mirrors compose 1:1: namespace `ollive`; Postgres and Kafka as
single-replica Deployments with PVCs (**prod = managed Postgres / MSK**);
one-shot Jobs for migrations (staged into `generated/` by the script) and
topic creation; NodePorts: web 30080, api 30040 (the browser calls the api
directly — `NEXT_PUBLIC_API_URL` is baked at web build time).

Scaling demo: `kubectl -n ollive scale deploy/worker --replicas=6`
(6 = the partition count of inference.events).

Boot note: worker/ingest may restart 2–4× on first bring-up while Kafka
elects and Postgres migrates — k8s restart policy is the supervisor; they
settle Ready within ~2 minutes.
