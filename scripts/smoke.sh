#!/usr/bin/env bash
# End-to-end smoke test for the ingestion pipeline:
#   event → ingest (validate) → Kafka → worker (redact + batch insert) → Postgres
# Covers: happy path, idempotent re-delivery, auth, per-item rejection,
# poison message → DLQ + ingest_failures. Needs the stack up (make infra) and
# ingest + worker running. With ANTHROPIC_API_KEY set it also exercises the
# real chat → auto-instrumentation path.
set -euo pipefail

INGEST_URL=${INGEST_URL:-http://localhost:4318}
API_URL=${API_URL:-http://localhost:4000}
INGEST_KEY=${INGEST_KEY:-dev-ingest-key}
SQL() { docker compose exec -T postgres psql -U "${POSTGRES_USER:-ollive}" -d "${POSTGRES_DB:-ollive}" -tAc "$1"; }

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1" >&2; exit 1; }

wait_for_count() { # query, expected, label
  for _ in $(seq 1 30); do
    [ "$(SQL "$1")" = "$2" ] && return 0
    sleep 1
  done
  fail "$3 (timed out: $(SQL "$1") != $2)"
}

rid=$(uuidgen | tr 'A-Z' 'a-z')
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
event=$(cat <<JSON
{"schema_version":1,"request_id":"$rid","provider":"anthropic","model":"claude-haiku-4-5",
 "is_stream":true,"status":"success",
 "timings":{"started_at":"$now","completed_at":"$now","latency_ms":812,"ttfb_ms":133},
 "usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30},
 "input_preview":"smoke: mail me at smoke@example.com","output_preview":"ok","sdk_version":"smoke"}
JSON
)

echo "1. happy path: event lands in inference_logs"
resp=$(curl -sf -X POST "$INGEST_URL/v1/logs" -H "content-type: application/json" -H "x-ingest-key: $INGEST_KEY" -d "[$event]")
echo "$resp" | grep -q '"accepted":1' || fail "ingest did not accept the event: $resp"
wait_for_count "SELECT count(*) FROM inference_logs WHERE request_id='$rid'" 1 "row did not appear"
pass "row present"

echo "2. worker redacted the preview before storage"
preview=$(SQL "SELECT input_preview FROM inference_logs WHERE request_id='$rid'")
echo "$preview" | grep -q 'REDACTED:email' || fail "preview not redacted: $preview"
pass "email redacted"

echo "3. idempotency: same batch re-sent → still exactly one row"
curl -sf -X POST "$INGEST_URL/v1/logs" -H "content-type: application/json" -H "x-ingest-key: $INGEST_KEY" -d "[$event]" >/dev/null
sleep 4
[ "$(SQL "SELECT count(*) FROM inference_logs WHERE request_id='$rid'")" = "1" ] || fail "duplicate row created"
pass "ON CONFLICT DO NOTHING absorbed the duplicate"

echo "4. auth: missing key rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INGEST_URL/v1/logs" -H "content-type: application/json" -d "[$event]")
[ "$code" = "401" ] || fail "expected 401, got $code"
pass "401 without X-Ingest-Key"

echo "5. per-item validation: invalid event rejected, batch still 202"
resp=$(curl -sf -X POST "$INGEST_URL/v1/logs" -H "content-type: application/json" -H "x-ingest-key: $INGEST_KEY" -d '[{"schema_version":1,"bogus":true}]')
echo "$resp" | grep -q '"accepted":0,"rejected":1' || fail "unexpected: $resp"
pass "202 {accepted:0, rejected:1}"

echo "6. poison message → DLQ + ingest_failures"
before=$(SQL "SELECT count(*) FROM ingest_failures")
echo 'this is not json {' | docker compose exec -T kafka /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic inference.events >/dev/null 2>&1
wait_for_count "SELECT count(*) FROM ingest_failures" "$((before + 1))" "ingest_failures row missing"
dlq=$(docker compose exec -T kafka /opt/kafka/bin/kafka-get-offsets.sh --bootstrap-server localhost:9092 --topic inference.dlq 2>/dev/null | awk -F: '{s+=$3} END {print s}')
[ "${dlq:-0}" -ge 1 ] || fail "DLQ topic empty"
pass "poison dead-lettered (DLQ offset sum: $dlq)"

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "7. live chat → auto-instrumented log row"
  before=$(SQL "SELECT count(*) FROM inference_logs WHERE provider='anthropic' AND conversation_id IS NOT NULL")
  curl -sfN -X POST "$API_URL/v1/chat" -H 'content-type: application/json' \
    -d '{"message":"Reply with exactly: pong","provider":"anthropic","model":"claude-haiku-4-5"}' >/dev/null
  wait_for_count "SELECT count(*) FROM inference_logs WHERE provider='anthropic' AND conversation_id IS NOT NULL" "$((before + 1))" "chat log row missing"
  pass "chat produced a linked inference_logs row"

  echo "8. cancel mid-stream → partial message + cancelled telemetry"
  sse="/tmp/smoke-cancel-sse.$$"
  curl -sN -X POST "$API_URL/v1/chat" -H 'content-type: application/json' \
    -d '{"message":"Write a 400 word story about a lighthouse keeper. Do not stop early.","provider":"anthropic","model":"claude-haiku-4-5"}' >"$sse" 2>/dev/null &
  curl_pid=$!
  conv=""
  for _ in $(seq 1 40); do
    # `|| true`: under pipefail, grep's no-match-yet exit would kill the script
    conv=$(grep -o '"conversationId":"[0-9a-f-]*"' "$sse" 2>/dev/null | head -1 | cut -d'"' -f4 || true)
    [ -n "$conv" ] && break
    sleep 0.5
  done
  [ -n "$conv" ] || fail "no start frame from chat SSE"
  sleep 1
  curl -sf -X POST "$API_URL/v1/conversations/$conv/cancel" >/dev/null
  wait "$curl_pid" 2>/dev/null || true
  rm -f "$sse"
  wait_for_count "SELECT count(*) FROM messages WHERE conversation_id='$conv' AND role='assistant' AND status='cancelled'" 1 "cancelled partial message missing"
  wait_for_count "SELECT count(*) FROM inference_logs WHERE conversation_id='$conv' AND status='cancelled'" 1 "cancelled log row missing"
  [ "$(SQL "SELECT status FROM conversations WHERE id='$conv'")" = "cancelled" ] || fail "conversation status not cancelled"
  pass "partial persisted, log row + conversation status = cancelled"
else
  echo "7. (skipped) live chat check — set ANTHROPIC_API_KEY to enable"
  echo "8. (skipped) cancel-path check — set ANTHROPIC_API_KEY to enable"
fi

echo "9. analytics endpoints return sane aggregates"
s=$(curl -sf "$API_URL/v1/stats/summary?window=10080")
req=$(echo "$s" | python3 -c "import json,sys; print(json.load(sys.stdin).get('requests', 0))")
[ "$req" -ge 1 ] || fail "summary shows zero requests: $s"
curl -sf "$API_URL/v1/stats/models?window=10080" | grep -q '"rows":' || fail "models endpoint failed"
curl -sf "$API_URL/v1/stats/timeseries?window=1440" | grep -q '"unit":' || fail "timeseries endpoint failed"
curl -sf "$API_URL/v1/logs?window=10080&limit=1" | grep -q '"rows":' || fail "requests explorer failed"
pass "summary/models/timeseries/logs healthy (requests=$req)"

echo "SMOKE PASS"
