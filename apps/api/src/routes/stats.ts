import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MODEL_PRICING } from '@ollive/shared';
import { pool } from '../db.js';

// Dashboard aggregates. Raw SQL on purpose (this is the Postgres showcase).
// Every query is time-window-bounded + LIMITed and runs under a 5s
// statement_timeout. Each query is served by a purpose-built index (see README).

const WindowSchema = z.coerce.number().int().min(1).max(10_080); // ≤ 7 days

// Cost estimation: the shared pricing table is joined into aggregates as an
// unnest'ed values relation. Unknown models produce NULL cost (UI shows "—").
const PRICING_MODELS = Object.keys(MODEL_PRICING);
const PRICING_IN = PRICING_MODELS.map((m) => MODEL_PRICING[m]!.inputPerMTok);
const PRICING_OUT = PRICING_MODELS.map((m) => MODEL_PRICING[m]!.outputPerMTok);
const COST_JOIN = `LEFT JOIN unnest($2::text[], $3::float8[], $4::float8[])
                     AS pricing(model, in_rate, out_rate) ON pricing.model = l.model`;
const COST_EXPR = `(coalesce(l.prompt_tokens, 0) * pricing.in_rate
                  + coalesce(l.completion_tokens, 0) * pricing.out_rate) / 1e6`;

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
  // Stat cards: one bounded aggregate over the window (idx_logs_started).
  app.get('/v1/stats/summary', async (request) => {
    const window = windowOf(request.query, 60);
    const rows = await statsQuery<Record<string, unknown>>(
      `SELECT count(*)::int                                            AS requests,
              count(*) FILTER (WHERE status = 'error')::int            AS errors,
              count(*) FILTER (WHERE status = 'cancelled')::int        AS cancelled,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
                    FILTER (WHERE latency_ms IS NOT NULL))::int        AS p95_latency_ms,
              coalesce(sum(total_tokens), 0)::bigint                   AS total_tokens,
              count(*) FILTER (WHERE flagged_injection)::int           AS flagged_injection,
              round(sum(${COST_EXPR})::numeric, 4)::float8             AS est_cost_usd
       FROM inference_logs l ${COST_JOIN}
       WHERE request_started_at >= now() - make_interval(mins => $1)`,
      [window, PRICING_MODELS, PRICING_IN, PRICING_OUT],
    );
    return { window, ...rows[0] };
  });

  // The model economics table: one row per provider+model with latency
  // percentiles, TTFB, error mix, token split, generation speed, and cost.
  // Window scan via idx_logs_started; single-model filters use idx_logs_prov_model.
  app.get('/v1/stats/models', async (request) => {
    const window = windowOf(request.query, 1440);
    const rows = await statsQuery(
      `SELECT l.provider, l.model,
              count(*)::int AS requests,
              count(*) FILTER (WHERE l.status = 'error')::int      AS errors,
              count(*) FILTER (WHERE l.status = 'cancelled')::int  AS cancelled,
              round(percentile_cont(0.50) WITHIN GROUP (ORDER BY l.latency_ms)
                    FILTER (WHERE l.status = 'success'))::int      AS p50,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms)
                    FILTER (WHERE l.status = 'success'))::int      AS p95,
              round(percentile_cont(0.99) WITHIN GROUP (ORDER BY l.latency_ms)
                    FILTER (WHERE l.status = 'success'))::int      AS p99,
              round(percentile_cont(0.50) WITHIN GROUP (ORDER BY l.ttfb_ms)
                    FILTER (WHERE l.is_stream))::int               AS ttfb_p50,
              coalesce(sum(l.prompt_tokens), 0)::bigint            AS prompt_tokens,
              coalesce(sum(l.completion_tokens), 0)::bigint        AS completion_tokens,
              round(avg(l.completion_tokens / nullif(l.latency_ms / 1000.0, 0))
                    FILTER (WHERE l.status = 'success')::numeric, 1)::float8 AS tokens_per_sec,
              round(sum(${COST_EXPR})::numeric, 4)::float8         AS est_cost_usd
       FROM inference_logs l ${COST_JOIN}
       WHERE l.request_started_at >= now() - make_interval(mins => $1)
       GROUP BY l.provider, l.model
       ORDER BY requests DESC
       LIMIT 25`,
      [window, PRICING_MODELS, PRICING_IN, PRICING_OUT],
    );
    return { window, rows };
  });

  // Time series: volume + status mix + latency percentiles + cost per bucket.
  // Minute buckets up to 6h, hourly beyond — point count stays bounded.
  const timeseries = async (request: { query: unknown }) => {
    const window = windowOf(request.query, 60);
    const unit = window <= 360 ? 'minute' : 'hour'; // whitelisted literal
    const rows = await statsQuery(
      `SELECT date_trunc('${unit}', l.request_started_at) AS bucket,
              count(*)::int AS requests,
              count(*) FILTER (WHERE l.status = 'error')::int     AS errors,
              count(*) FILTER (WHERE l.status = 'cancelled')::int AS cancelled,
              round(percentile_cont(0.50) WITHIN GROUP (ORDER BY l.latency_ms)
                    FILTER (WHERE l.status = 'success'))::int     AS p50,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms)
                    FILTER (WHERE l.status = 'success'))::int     AS p95,
              round(sum(${COST_EXPR})::numeric, 4)::float8        AS est_cost_usd
       FROM inference_logs l ${COST_JOIN}
       WHERE l.request_started_at >= now() - make_interval(mins => $1)
       GROUP BY 1
       ORDER BY 1
       LIMIT 1500`,
      [window, PRICING_MODELS, PRICING_IN, PRICING_OUT],
    );
    return { window, unit, rows };
  };
  app.get('/v1/stats/timeseries', timeseries);
  app.get('/v1/stats/throughput', timeseries); // back-compat alias

  // Error rate by provider+model + the recent-errors table. The recent list
  // is the partial-index showcase: idx_logs_errors contains only error rows,
  // already ordered by request_started_at DESC.
  app.get('/v1/stats/errors', async (request) => {
    const window = windowOf(request.query, 1440);
    const [rates, recent] = await Promise.all([
      statsQuery(
        `SELECT provider, model, count(*)::int AS total,
                count(*) FILTER (WHERE status = 'error')::int AS errors,
                round(100.0 * count(*) FILTER (WHERE status = 'error') / count(*), 2)::float AS error_rate_pct
         FROM inference_logs
         WHERE request_started_at >= now() - make_interval(mins => $1)
         GROUP BY provider, model
         ORDER BY errors DESC, total DESC
         LIMIT 25`,
        [window],
      ),
      statsQuery(
        `SELECT id, request_started_at, provider, model, error_type, error_message
         FROM inference_logs
         WHERE status = 'error'
           AND request_started_at >= now() - make_interval(mins => $1)
         ORDER BY request_started_at DESC
         LIMIT 50`,
        [window],
      ),
    ]);
    return { window, rates, recent };
  });

  // Token totals per model per hour (idx_logs_started).
  app.get('/v1/stats/tokens', async (request) => {
    const window = windowOf(request.query, 1440);
    const rows = await statsQuery(
      `SELECT date_trunc('hour', request_started_at) AS bucket, model,
              coalesce(sum(total_tokens), 0)::bigint AS tokens
       FROM inference_logs
       WHERE request_started_at >= now() - make_interval(mins => $1)
       GROUP BY 1, 2
       ORDER BY 1
       LIMIT 500`,
      [window],
    );
    return { window, rows };
  });
}
