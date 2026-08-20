import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROVIDER_MODELS } from '@ollive/providers';
import { configuredProviders, providerStatus, setProviderKey } from '../clients.js';

const KeyBody = z.object({
  provider: z.enum(['anthropic', 'openai']),
  apiKey: z.string().min(8).max(400),
});

export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get('/v1/settings', async () => ({
    providers: providerStatus(),
    models: PROVIDER_MODELS,
    configured: configuredProviders(),
  }));

  app.post('/v1/settings/keys', async (request, reply) => {
    const parsed = KeyBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    const { provider, apiKey } = parsed.data;
    // Cheap sanity check on shape so obviously-wrong keys are rejected early.
    if (provider === 'anthropic' && !apiKey.startsWith('sk-ant-'))
      return reply.code(400).send({ error: 'invalid_key', message: 'Anthropic keys start with sk-ant-' });
    if (provider === 'openai' && !apiKey.startsWith('sk-'))
      return reply.code(400).send({ error: 'invalid_key', message: 'OpenAI keys start with sk-' });
    setProviderKey(provider, apiKey.trim());
    return { ok: true, configured: configuredProviders() };
  });
}
