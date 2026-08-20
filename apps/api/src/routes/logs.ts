import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, ilike, lt } from 'drizzle-orm';
import { z } from 'zod';
import { estimateCostUsd, zUuid } from '@ollive/shared';
import { conversations, db, inferenceLogs } from '../db.js';

// Requests explorer: the drill-down surface behind every dashboard chart.
// List is filterable (provider/model/status/window) with keyset pagination;
// detail returns the full redacted event + its conversation, if any.

const ListQuerySchema = z.object({
  window: z.coerce.number().int().min(1).max(10_080).default(1440),
  provider: z.string().max(50).optional(),
  model: z.string().max(200).optional(),
  status: z.enum(['success', 'error', 'cancelled']).optional(),
  stream: z.enum(['true', 'false']).optional(),
  tenant: z.string().max(100).optional(),
  flagged: z.enum(['true']).optional(),
  /** case-insensitive search over the input preview */
  q: z.string().max(200).optional(),
  /** Per-conversation drill-down (served by idx_logs_conversation). */
  conversationId: zUuid.optional(),
  /** Keyset cursor: return rows started strictly before this ISO timestamp. */
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function registerLogRoutes(app: FastifyInstance): void {
  app.get('/v1/logs', async (request, reply) => {
    const parsed = ListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', details: parsed.error.flatten() });
    }
    const q = parsed.data;

    const conds = [
      gte(inferenceLogs.requestStartedAt, new Date(Date.now() - q.window * 60_000)),
    ];
    if (q.provider) conds.push(eq(inferenceLogs.provider, q.provider));
    if (q.model) conds.push(eq(inferenceLogs.model, q.model));
    if (q.status) conds.push(eq(inferenceLogs.status, q.status));
    if (q.stream) conds.push(eq(inferenceLogs.isStream, q.stream === 'true'));
    if (q.tenant) conds.push(eq(inferenceLogs.tenantId, q.tenant));
    if (q.flagged) conds.push(eq(inferenceLogs.flaggedInjection, true));
    if (q.q) conds.push(ilike(inferenceLogs.inputPreview, `%${q.q}%`));
    if (q.conversationId) conds.push(eq(inferenceLogs.conversationId, q.conversationId));
    if (q.before) conds.push(lt(inferenceLogs.requestStartedAt, new Date(q.before)));

    const rows = await db
      .select({
        id: inferenceLogs.id,
        requestStartedAt: inferenceLogs.requestStartedAt,
        provider: inferenceLogs.provider,
        model: inferenceLogs.model,
        status: inferenceLogs.status,
        isStream: inferenceLogs.isStream,
        latencyMs: inferenceLogs.latencyMs,
        ttfbMs: inferenceLogs.ttfbMs,
        promptTokens: inferenceLogs.promptTokens,
        completionTokens: inferenceLogs.completionTokens,
        totalTokens: inferenceLogs.totalTokens,
        errorType: inferenceLogs.errorType,
        inputPreview: inferenceLogs.inputPreview,
        conversationId: inferenceLogs.conversationId,
        flaggedInjection: inferenceLogs.flaggedInjection,
      })
      .from(inferenceLogs)
      .where(and(...conds))
      .orderBy(desc(inferenceLogs.requestStartedAt))
      .limit(q.limit);

    return {
      rows: rows.map((r) => ({
        ...r,
        inputPreview: r.inputPreview ? r.inputPreview.slice(0, 120) : null,
        estCostUsd: estimateCostUsd(r.model, r.promptTokens, r.completionTokens),
      })),
      nextBefore: rows.length === q.limit ? rows[rows.length - 1]!.requestStartedAt : null,
    };
  });

  app.get('/v1/logs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!zUuid.safeParse(id).success) {
      return reply.code(400).send({ error: 'invalid log id' });
    }
    const rows = await db.select().from(inferenceLogs).where(eq(inferenceLogs.id, id)).limit(1);
    const log = rows[0];
    if (!log) return reply.code(404).send({ error: 'not found' });

    let conversation: { id: string; title: string | null } | null = null;
    if (log.conversationId) {
      const conv = await db
        .select({ id: conversations.id, title: conversations.title })
        .from(conversations)
        .where(eq(conversations.id, log.conversationId))
        .limit(1);
      conversation = conv[0] ?? null;
    }

    return {
      log,
      estCostUsd: estimateCostUsd(log.model, log.promptTokens, log.completionTokens),
      conversation,
    };
  });
}
