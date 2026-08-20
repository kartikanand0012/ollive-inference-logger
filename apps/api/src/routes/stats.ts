import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MODEL_PRICING } from '@ollive/shared';
import { pool } from '../db.js';

// Dashboard aggregates. Raw SQL on purpose (this is the Postgres showcase).
// Every query is time-window-bounded + LIMITed and runs under a 5s
// statement_timeout. All endpoints accept the same optional filter set
// (provider / model / status / stream / tenant), applied server-side.

const WindowSchema = z.coerce.number().int().min(1).max(10_080); // ≤ 7 days

const PRICING_MODELS = Object.keys(MODEL_PRICING);
const PRICING_IN = PRICING_MODELS.map((m) => MODEL_PRICING[m]!.inputPerMTok);
const PRICING_OUT = PRICING_MODELS.map((m) => MODEL_PRICING[m]!.outputPerMTok);
const COST_JOIN = `LEFT JOIN unnest($2::text[], $3::float8[], $4::float8[])
                     AS pricing(model, in_rate, out_rate) ON pricing.model = l.model`;
const COST_EXPR = `(coalesce(l.prompt_tokens, 0) * pricing.in_rate
                  + coalesce(l.completion_tokens, 0) * pricing.out_rate) / 1e6`;

// Builds AND clauses starting at $next; returns extra params in order.
function buildFilters(query: Record<string, unknown>, next: number): { clause: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, val: unknown) => {
    clauses.push(`AND l.${col} = $${next++}`);
    params.push(val);
  };
  if (typeof query.provider === 'string' && query.provider) add('provider', query.provider);
  if (typeof query.model === 'string' && query.model) add('model', query.model);
  if (query.status === 'success' || query.status === 'error' || query.status === 'cancelled')
    add('status', query.status);
  if (query.stream === 'true' || query.stream === 'false') add('is_stream', query.stream === 'true');
  if (typeof query.tenant === 'string' && query.tenant) add('tenant_id', query.tenant);
  return { clause: clauses.join('\n'), params };
}

async function statsQuery<T>(text: string, params: unknown[]): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const res = await client.query(text, params);
    await client.query('COMMIT');
    return res.rows as T[];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function windowOf(query: unknown, fallback: number): number {
  const parsed = WindowSchema.safeParse((query as { window?: unknown }).window);
  return parsed.success ? parsed.data : fallback;
}

export function registerStatsRoutes(app: FastifyInstance): void {
  // Distinct filter values for the UI's dropdowns (bounded window).
  app.get('/v1/stats/facets', async (request) => {
    const window = windowOf(request.query, 10_080);
    const rows = await statsQuery<{ dim: string; val: string }>(
      `SELECT 'provider' AS dim, provider AS val FROM inference_logs
         WHERE request_started_at >= now() - make_interval(mins => $1) GROUP BY provider
       UNION ALL
       SELECT 'model', model FROM inference_logs
         WHERE request_started_at >= now() - make_interval(mins => $1) GROUP BY model
       UNION ALL
       SELECT 'tenant', tenant_id FROM inference_logs
         WHERE request_started_at >= now() - make_interval(mins => $1) GROUP BY tenant_id
       LIMIT 200`,
      [window],
    );
    const facets: Record<string, string[]> = { provider: [], model: [], tenant: [] };
    for (const r of rows) if (facets[r.dim]) facets[r.dim]!.push(r.val);
    return facets;
  });

  app.get('/v1/stats/summary', async (request) => {
    const window = windowOf(request.query, 60);
    const f = buildFilters(request.query as Record<string, unknown>, 5);
    const rows = await statsQuery<Record<string, unknown>>(
      `SELECT count(*)::int AS requests,
              count(*) FILTER (WHERE l.status = 'error')::int AS errors,
              count(*) FILTER (WHERE l.status = 'cancelled')::int AS cancelled,
              count(*) FILTER (WHERE l.status = 'success')::int AS success,
              count(*) FILTER (WHERE l.is_stream)::int AS streamed,
              count(DISTINCT l.conversation_id)::int AS conversations,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms)
                    FILTER (WHERE l.latency_ms IS NOT NULL))::int AS p95_latency_ms,
              round(avg(l.latency_ms) FILTER (WHERE l.status='success'))::int AS avg_latency_ms,
              round(percentile_cont(0.50) WITHIN GROUP (ORDER BY l.ttfb_ms)
                    FILTER (WHERE l.is_stream))::int AS ttfb_p50,
              coalesce(sum(l.total_tokens), 0)::bigint AS total_tokens,
              round(avg(l.total_tokens) FILTER (WHERE l.total_tokens IS NOT NULL))::int AS avg_tokens,
              count(*) FILTER (WHERE l.flagged_injection)::int AS flagged_injection,
              round(sum(${COST_EXPR})::numeric, 4)::float8 AS est_cost_usd
       FROM inference_logs l ${COST_JOIN}
       WHERE l.request_started_at >= now() - make_interval(mins => $1) ${f.clause}`,
      [window, PRICING_MODELS, PRICING_IN, PRICING_OUT, ...f.params],
    );
    return { window, ...rows[0] };
  });

  app.get('/v1/stats/models', async (request) => {
    const window = windowOf(request.query, 1440);
    const f = buildFilters(request.query as Record<string, unknown>, 5);
    const rows = await statsQuery(
      `SELECT l.provider, l.model,
              count(*)::int AS requests,
              count(*) FILTER (WHERE l.status = 'error')::int AS errors,
              count(*) FILTER (WHERE l.status = 'cancelled')::int AS cancelled,
              round(percentile_cont(0.50) WITHIN GROUP (ORDER BY l.latency_ms) FILTER (WHERE l.status='success'))::int AS p50,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms) FILTER (WHERE l.status='success'))::int AS p95,
              round(percentile_cont(0.99) WITHIN GROUP (ORDER BY l.latency_ms) FILTER (WHERE l.status='success'))::int AS p99,
              round(percentile_cont(0.50) WITHIN GROUP (ORDER BY l.ttfb_ms) FILTER (WHERE l.is_stream))::int AS ttfb_p50,
              coalesce(sum(l.prompt_tokens), 0)::bigint AS prompt_tokens,
              coalesce(sum(l.completion_tokens), 0)::bigint AS completion_tokens,
              round(avg(l.completion_tokens / nullif(l.latency_ms / 1000.0, 0)) FILTER (WHERE l.status='success')::numeric, 1)::float8 AS tokens_per_sec,
              round(sum(${COST_EXPR})::numeric, 4)::float8 AS est_cost_usd
       FROM inference_logs l ${COST_JOIN}
       WHERE l.request_started_at >= now() - make_interval(mins => $1) ${f.clause}
       GROUP BY l.provider, l.model ORDER BY requests DESC LIMIT 25`,
      [window, PRICING_MODELS, PRICING_IN, PRICING_OUT, ...f.params],
    );
    return { window, rows };
  });

  const timeseries = async (request: { query: unknown }) => {
    const window = windowOf(request.query, 60);
    const unit = window <= 360 ? 'minute' : 'hour';
    const f = buildFilters(request.query as Record<string, unknown>, 5);
    const rows = await statsQuery(
      `SELECT date_trunc('${unit}', l.request_started_at) AS bucket,
              count(*)::int AS requests,
              count(*) FILTER (WHERE l.status = 'error')::int AS errors,
              count(*) FILTER (WHERE l.status = 'cancelled')::int AS cancelled,
              round(percentile_cont(0.50) WITHIN GROUP (ORDER BY l.latency_ms) FILTER (WHERE l.status='success'))::int AS p50,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms) FILTER (WHERE l.status='success'))::int AS p95,
              round(sum(${COST_EXPR})::numeric, 4)::float8 AS est_cost_usd
       FROM inference_logs l ${COST_JOIN}
       WHERE l.request_started_at >= now() - make_interval(mins => $1) ${f.clause}
       GROUP BY 1 ORDER BY 1 LIMIT 1500`,
      [window, PRICING_MODELS, PRICING_IN, PRICING_OUT, ...f.params],
    );
    return { window, unit, rows };
  };
  app.get('/v1/stats/timeseries', timeseries);
  app.get('/v1/stats/throughput', timeseries);

  app.get('/v1/stats/errors', async (request) => {
    const window = windowOf(request.query, 1440);
    const f = buildFilters(request.query as Record<string, unknown>, 2);
    const [rates, recent] = await Promise.all([
      statsQuery(
        `SELECT l.provider, l.model, count(*)::int AS total,
                count(*) FILTER (WHERE l.status = 'error')::int AS errors,
                round(100.0 * count(*) FILTER (WHERE l.status='error') / count(*), 2)::float AS error_rate_pct
         FROM inference_logs l
         WHERE l.request_started_at >= now() - make_interval(mins => $1) ${f.clause}
         GROUP BY l.provider, l.model ORDER BY errors DESC, total DESC LIMIT 25`,
        [window, ...f.params],
      ),
      statsQuery(
        `SELECT l.id, l.request_started_at, l.provider, l.model, l.error_type, l.error_message
         FROM inference_logs l
         WHERE l.status = 'error' AND l.request_started_at >= now() - make_interval(mins => $1) ${f.clause}
         ORDER BY l.request_started_at DESC LIMIT 50`,
        [window, ...f.params],
      ),
    ]);
    return { window, rates, recent };
  });

  app.get('/v1/stats/tokens', async (request) => {
    const window = windowOf(request.query, 1440);
    const f = buildFilters(request.query as Record<string, unknown>, 2);
    const rows = await statsQuery(
      `SELECT date_trunc('hour', l.request_started_at) AS bucket, l.model,
              coalesce(sum(l.total_tokens), 0)::bigint AS tokens
       FROM inference_logs l
       WHERE l.request_started_at >= now() - make_interval(mins => $1) ${f.clause}
       GROUP BY 1, 2 ORDER BY 1 LIMIT 500`,
      [window, ...f.params],
    );
    return { window, rows };
  });
}
