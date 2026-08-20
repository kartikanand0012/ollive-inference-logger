import type { FastifyInstance } from 'fastify';
import { asc, desc, eq } from 'drizzle-orm';
import { zUuid } from '@ollive/shared';
import { PROVIDER_MODELS } from '@ollive/providers';
import { conversations, db, messages } from '../db.js';
import { cancelConversation } from '../cancels.js';
import { configuredProviders, getActiveProvider } from '../clients.js';

export function registerConversationRoutes(app: FastifyInstance): void {
  // Providers/models available to the UI picker.
  app.get('/v1/meta', async () => ({
    providers: configuredProviders(),
    models: PROVIDER_MODELS,
    active: getActiveProvider(),
  }));

  app.get('/v1/conversations', async () => {
    return db
      .select()
      .from(conversations)
      .orderBy(desc(conversations.updatedAt))
      .limit(100);
  });

  app.get('/v1/conversations/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!zUuid.safeParse(id).success) {
      return reply.code(400).send({ error: 'invalid conversation id' });
    }
    return db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.seq))
      .limit(500);
  });

  app.post('/v1/conversations/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!zUuid.safeParse(id).success) {
      return reply.code(400).send({ error: 'invalid conversation id' });
    }
    // Aborting the in-flight AbortController triggers the chat route's
    // cancelled path: partial message persisted, log row status=cancelled.
    const cancelled = await cancelConversation(id);
    if (cancelled) {
      // Reflect it on the domain row too; the next send flips it back to active.
      await db
        .update(conversations)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(conversations.id, id));
    }
    return { cancelled };
  });
}
