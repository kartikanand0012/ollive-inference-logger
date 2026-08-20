import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { detectPromptInjection, redactText, zUuid } from '@ollive/shared';
import { runWithInferenceContext } from '@ollive/sdk';
import type { ChatMessage } from '@ollive/providers';
import { conversations, db, messages } from '../db.js';
import { env } from '../env.js';
import { getAdapter } from '../clients.js';
import { registerCancel, unregisterCancel } from '../cancels.js';
import { openSse } from '../sse.js';

const ChatBodySchema = z.object({
  conversationId: zUuid.optional(),
  message: z.string().min(1).max(8000),
  provider: z.enum(['anthropic', 'openai']),
  model: z.string().min(1).max(200),
  /** Browser-session id (sessionStorage uuid) — groups a user's turns in telemetry. */
  sessionId: z.string().max(100).optional(),
});

type Db = typeof db;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function nextSeq(tx: Tx, conversationId: string): Promise<number> {
  const rows = await tx
    .select({ max: sql<number>`coalesce(max(${messages.seq}), 0)` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return Number(rows[0]?.max ?? 0) + 1;
}

export function registerChatRoutes(app: FastifyInstance): void {
  app.post('/v1/chat', async (request, reply) => {
    const parsed = ChatBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    const body = parsed.data;

    // Guardrails (OWASP LLM01): heuristic injection detection on the user
    // input. Always logged (and derived into telemetry by the worker);
    // GUARDRAILS_BLOCK=true upgrades detection to prevention.
    const verdict = detectPromptInjection(body.message);
    if (verdict.flagged) {
      request.log.warn({ patterns: verdict.patterns }, 'prompt-injection heuristics flagged input');
      if (env.guardrailsBlock) {
        return reply.code(400).send({ error: 'guardrails_blocked', patterns: verdict.patterns });
      }
    }

    const adapter = getAdapter(body.provider);
    if (!adapter) {
      const keyName = body.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
      return reply
        .code(400)
        .send({ error: 'provider_not_configured', message: `Set ${keyName} and restart the api.` });
    }

    // Persist the user turn and snapshot context in one transaction. The
    // SELECT ... FOR UPDATE on the conversation row serializes concurrent
    // sends to the same conversation (UNIQUE(conversation_id, seq) backstops).
    let setup: { conversationId: string; context: ChatMessage[] };
    try {
      setup = await db.transaction(async (tx) => {
        let conversationId: string;
        if (body.conversationId) {
          conversationId = body.conversationId;
          const found = await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .for('update');
          if (found.length === 0) {
            throw Object.assign(new Error('conversation not found'), { statusCode: 404 });
          }
        } else {
          const inserted = await tx
            .insert(conversations)
            .values({ title: body.message.slice(0, 80), provider: body.provider, model: body.model })
            .returning({ id: conversations.id });
          conversationId = inserted[0]!.id;
        }

        const seq = await nextSeq(tx, conversationId);
        const content = env.redactMessages ? redactText(body.message) : body.message;
        await tx.insert(messages).values({ conversationId, role: 'user', content, seq });
        // Sending re-activates a conversation that was previously cancelled.
        await tx
          .update(conversations)
          .set({ updatedAt: new Date(), status: 'active' })
          .where(eq(conversations.id, conversationId));

        // Context strategy: last N messages, oldest-first.
        const recent = await tx
          .select({ role: messages.role, content: messages.content })
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
          .orderBy(desc(messages.seq))
          .limit(env.contextMessages);
        return { conversationId, context: recent.reverse() as ChatMessage[] };
      });
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
      request.log.error(err, 'chat setup failed');
      return reply.code(statusCode).send({ error: (err as Error).message });
    }

    const { conversationId, context } = setup;
    // Pre-generated so telemetry (message_id in inference events, Phase 2)
    // can reference the assistant message before its row exists.
    const assistantMessageId = randomUUID();

    const sse = openSse(request, reply);
    sse.send({ type: 'start', conversationId, messageId: assistantMessageId });

    const ac = new AbortController();
    registerCancel(conversationId, ac);
    // Client disconnect (tab closed, fetch aborted) aborts the generation too.
    reply.raw.on('close', () => ac.abort());
    // DoS guard: no generation may hold its SSE slot past the ceiling.
    const generationTimeout = setTimeout(() => ac.abort(), env.chatTimeoutMs);

    let output = '';
    let status: 'complete' | 'cancelled' | 'error' = 'complete';
    let errorMessage: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let firstTokenAt: number | undefined;
    const startedAt = Date.now();
    try {
      // ALS context entered at the route boundary: the SDK picks these
      // ids up inside the wrapped provider client — nothing is threaded
      // through the adapter or any call site below.
      await runWithInferenceContext(
        { conversationId, messageId: assistantMessageId, sessionId: body.sessionId },
        async () => {
          for await (const ev of adapter.streamChat({
            model: body.model,
            messages: context,
            maxTokens: env.maxTokens,
            signal: ac.signal,
          })) {
            if (ev.type === 'delta') {
              if (firstTokenAt === undefined) firstTokenAt = Date.now();
              output += ev.text;
              sse.send({ type: 'token', text: ev.text });
            } else if (ev.type === 'usage') {
              if (ev.promptTokens != null) promptTokens = ev.promptTokens;
              if (ev.completionTokens != null) completionTokens = ev.completionTokens;
            }
          }
        },
      );
    } catch (err) {
      if (ac.signal.aborted) {
        status = 'cancelled';
      } else {
        status = 'error';
        errorMessage = err instanceof Error ? err.message : String(err);
        request.log.error(err, 'provider stream failed');
      }
    }
    if (ac.signal.aborted && status === 'complete') status = 'cancelled';

    // Persist the assistant turn — including partial output on cancel/error.
    if (output.length > 0 || status === 'complete') {
      try {
        await db.transaction(async (tx) => {
          // Re-acquire the conversation lock: without it, a concurrent send's
          // setup tx can compute the same seq and one insert dies on the
          // unique constraint.
          await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .for('update');
          const seq = await nextSeq(tx, conversationId);
          await tx.insert(messages).values({
            id: assistantMessageId,
            conversationId,
            role: 'assistant',
            content: env.redactMessages ? redactText(output) : output,
            seq,
            status,
          });
          await tx
            .update(conversations)
            .set({ updatedAt: new Date() })
            .where(eq(conversations.id, conversationId));
        });
      } catch (err) {
        request.log.error(err, 'failed to persist assistant message');
      }
    }

    if (status === 'error') {
      sse.send({ type: 'error', conversationId, message: errorMessage ?? 'provider error' });
    } else {
      sse.send({
        type: 'done',
        conversationId,
        messageId: assistantMessageId,
        cancelled: status === 'cancelled',
        latencyMs: Date.now() - startedAt,
        ttfbMs: firstTokenAt ? firstTokenAt - startedAt : undefined,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens != null && completionTokens != null ? promptTokens + completionTokens : undefined,
      });
    }
    clearTimeout(generationTimeout);
    unregisterCancel(conversationId, ac);
    sse.close();
  });
}
