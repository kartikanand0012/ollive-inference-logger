import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runWithInferenceContext } from '@ollive/sdk';
import { dbSchema } from '@ollive/shared';
import { db, pool } from '../db.js';
import { env } from '../env.js';
import { getActiveProvider, getAdapter } from '../clients.js';
import { openSse } from '../sse.js';

const { assistantMessages } = dbSchema;
const BodySchema = z.object({ threadId: z.string().min(1).max(100), question: z.string().min(1).max(2000) });

// Live snapshot the copilot reasons over — a compact, current view of the system.
async function snapshot(): Promise<string> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT count(*)::int AS requests,
             count(*) FILTER (WHERE status='error')::int AS errors,
             count(*) FILTER (WHERE status='cancelled')::int AS cancelled,
             round(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms))::int AS p50,
             round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::int AS p95,
             round(avg(ttfb_ms) FILTER (WHERE is_stream))::int AS avg_ttfb,
             coalesce(sum(total_tokens),0)::bigint AS tokens,
             round(sum(est_cost_usd)::numeric,4)::float8 AS cost,
             count(*) FILTER (WHERE flagged_injection)::int AS flagged
      FROM inference_logs WHERE request_started_at >= now() - interval '24 hours'`);
    const byModel = await client.query(`
      SELECT provider, model, count(*)::int n,
             round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::int p95,
             round(sum(est_cost_usd)::numeric,4)::float8 cost
      FROM inference_logs WHERE request_started_at >= now() - interval '24 hours'
      GROUP BY 1,2 ORDER BY n DESC LIMIT 8`);
    return JSON.stringify({ window: '24h', overall: rows[0], byModel: byModel.rows });
  } finally { client.release(); }
}

export function registerAssistantRoutes(app: FastifyInstance): void {
  app.get('/v1/assistant/:threadId', async (request) => {
    const { threadId } = request.params as { threadId: string };
    return db.select().from(assistantMessages).where(eq(assistantMessages.threadId, threadId)).orderBy(asc(assistantMessages.createdAt)).limit(200);
  });

  app.post('/v1/assistant', async (request, reply) => {
    const parsed = BodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { threadId, question } = parsed.data;

    const provider = getActiveProvider();
    const adapter = provider ? getAdapter(provider) : undefined;
    if (!adapter) return reply.code(400).send({ error: 'no_provider', message: 'Add a provider key in Settings.' });

    const prior = await db.select({ role: assistantMessages.role, content: assistantMessages.content })
      .from(assistantMessages).where(eq(assistantMessages.threadId, threadId)).orderBy(asc(assistantMessages.createdAt)).limit(20);
    await db.insert(assistantMessages).values({ threadId, role: 'user', content: question });

    const snap = await snapshot();
    const system = `You are Ollive's observability copilot embedded in an LLM inference-logging dashboard. Explain metrics plainly and help the user understand their telemetry. Be concise (2-5 sentences), concrete, and reference the actual numbers. Terms: TTFT = time to first token; p50/p95/p99 = latency percentiles; cost is an estimate from a static per-model price table; "flagged" = inputs matching prompt-injection heuristics. Here is the LIVE dashboard snapshot (JSON): ${snap}`;
    const messages = [
      { role: 'system' as const, content: system },
      ...prior.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: question },
    ];

    const sse = openSse(request, reply);
    let answer = '';
    try {
      // Dogfooding: the copilot's own call is auto-instrumented too. Tag its
      // session so these logs are distinguishable from product chat traffic.
      await runWithInferenceContext({ sessionId: 'assistant' }, async () => {
        for await (const evs of adapter.streamChat({ model: adapterModel(provider!), messages, maxTokens: 700 })) {
          if (evs.type === 'delta') { answer += evs.text; sse.send({ type: 'token', text: evs.text }); }
        }
      });
    } catch (err) {
      sse.send({ type: 'error', message: err instanceof Error ? err.message : 'failed' });
      sse.close(); return;
    }
    await db.insert(assistantMessages).values({ threadId, role: 'assistant', content: answer });
    sse.send({ type: 'done' });
    sse.close();
  });
}

function adapterModel(provider: string): string {
  return provider === 'openai' ? 'gpt-4o-mini' : 'claude-haiku-4-5';
}
