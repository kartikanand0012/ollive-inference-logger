import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { dbSchema } from '@ollive/shared';
import { env } from './env.js';

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema: dbSchema });
export const { conversations, messages, inferenceLogs } = dbSchema;
