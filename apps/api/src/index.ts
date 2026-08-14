import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { flushInferenceEvents } from '@ollive/sdk';
import { env } from './env.js';
import { pool } from './db.js';
import { configuredProviders } from './clients.js';
import { cancelAllConversations, closeCancelBus, initCancelBus } from './cancels.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerLogRoutes } from './routes/logs.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  // Slowloris hardening: bound how long a client may take to DELIVER a
  // request (headers+body). Applies to the request side only — long-lived
  // SSE responses are unaffected.
  requestTimeout: 30_000,
});

// CORS: explicit allowlist in production (CORS_ORIGIN), permissive in dev.
await app.register(cors, {
  origin: env.corsOrigin ? env.corsOrigin.split(',').map((o) => o.trim()) : true,
});
await app.register(helmet, { contentSecurityPolicy: false }); // API responses only — no HTML
// DoS guard: per-client request budget; health probes exempt.
await app.register(rateLimit, {
  max: env.rateLimitPerMin,
  timeWindow: '1 minute',
  allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
});

// Liveness: shallow. Readiness: proves the DB is reachable (k8s readinessProbe).
app.get('/healthz', async () => ({ ok: true, providers: configuredProviders() }));
app.get('/readyz', async (_req, reply) => {
  try {
    await pool.query('SELECT 1');
    return { ready: true };
  } catch {
    return reply.code(503).send({ ready: false, reason: 'database unreachable' });
  }
});
registerChatRoutes(app);
registerConversationRoutes(app);
registerStatsRoutes(app);
registerLogRoutes(app);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  // Abort in-flight generations first — otherwise open SSE streams (kept
  // alive by heartbeats) hold app.close() past the SIGTERM grace period and
  // the telemetry flush below never runs.
  cancelAllConversations();
  await app.close();
  await flushInferenceEvents(); // drain buffered telemetry before exit
  await closeCancelBus();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await initCancelBus(process.env.REDIS_URL, app.log);
  await app.listen({ port: env.port, host: '0.0.0.0' });
  app.log.info({ providers: configuredProviders() }, 'api up');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
