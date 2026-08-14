#!/bin/sh
# Ordered, idempotent SQL migration runner. psql connection comes from PG* env.
# Contract: migration files must NOT contain their own BEGIN/COMMIT/ROLLBACK —
# each file is wrapped in ONE transaction together with its schema_migrations
# record (which also rules out CREATE INDEX CONCURRENTLY in migrations).
set -eu

psql -v ON_ERROR_STOP=1 -q -c "CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);"

for f in /migrations/*.sql; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  applied="$(psql -tAc "SELECT count(*) FROM schema_migrations WHERE filename = '$name'")"
  if [ "$applied" = "1" ]; then
    echo "migrate: skip $name (already applied)"
    continue
  fi
  echo "migrate: applying $name"
  # -f and -c execute in order inside a single wrapped transaction:
  # the migration and its tracking row commit atomically.
  psql -v ON_ERROR_STOP=1 --single-transaction -f "$f" \
    -c "INSERT INTO schema_migrations (filename) VALUES ('$name')"
done

echo "migrate: done"
