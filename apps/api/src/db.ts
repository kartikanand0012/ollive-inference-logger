import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { dbSchema } from '@ollive/shared';
import { env } from './env.js';

// Neon serverless Pool (WebSocket transport) — pg's direct TCP+TLS to
// port 5432 fails SSL handshake from sandboxed egress.
(globalThis as { WebSocket?: unknown }).WebSocket ??= ws;

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema: dbSchema });
export const { conversations, messages, inferenceLogs } = dbSchema;
