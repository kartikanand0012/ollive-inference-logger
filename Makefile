.PHONY: up down ps logs psql topics infra typecheck smoke traffic

# One command: full stack.
up:
	docker compose up --build -d

down:
	docker compose down

# Nuke volumes too (fresh DB).
clean:
	docker compose down -v

# Infra only (postgres + kafka + topic creation + migrations) — used during dev.
infra:
	docker compose up -d --build postgres kafka kafka-init migrate

ps:
	docker compose ps -a

logs:
	docker compose logs -f --tail=100

psql:
	docker compose exec postgres sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'

topics:
	docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --describe

typecheck:
	pnpm -r typecheck

smoke:
	./scripts/smoke.sh

# Re-drive replayable DLQ entries through the pipeline (safe to re-run:
# the worker's ON CONFLICT insert absorbs already-landed rows).
replay-dlq:
	pnpm --filter @ollive/worker replay-dlq

# Cheap-model demo traffic (needs Node 20+ and pnpm on the host).
traffic:
	pnpm install --silent
	pnpm tsx scripts/generate-traffic.ts
