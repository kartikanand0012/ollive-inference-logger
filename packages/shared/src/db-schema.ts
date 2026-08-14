// Drizzle mirror of infra/migrations/*.sql for typed queries.
// The hand-written SQL is the source of truth — this file mirrors it
// and MUST be updated in lockstep with new migrations.
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title'),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  status: text('status', { enum: ['active', 'cancelled', 'archived'] })
    .notNull()
    .default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull(),
  role: text('role', { enum: ['system', 'user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  seq: integer('seq').notNull(),
  status: text('status', { enum: ['complete', 'cancelled', 'error'] })
    .notNull()
    .default('complete'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const inferenceLogs = pgTable('inference_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull().unique(),
  conversationId: uuid('conversation_id'),
  messageId: uuid('message_id'),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  isStream: boolean('is_stream').notNull().default(false),
  status: text('status', { enum: ['success', 'error', 'cancelled'] }).notNull(),
  latencyMs: integer('latency_ms'),
  ttfbMs: integer('ttfb_ms'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  totalTokens: integer('total_tokens'),
  errorType: text('error_type'),
  errorMessage: text('error_message'),
  inputPreview: text('input_preview'),
  outputPreview: text('output_preview'),
  raw: jsonb('raw'),
  // Derived by the worker at write time (migrations 0002/0003).
  tokensPerSec: doublePrecision('tokens_per_sec'),
  estCostUsd: doublePrecision('est_cost_usd'),
  ingestLagMs: integer('ingest_lag_ms'),
  flaggedInjection: boolean('flagged_injection').notNull().default(false),
  tenantId: text('tenant_id').notNull().default('default'),
  requestStartedAt: timestamp('request_started_at', { withTimezone: true }).notNull(),
  requestCompletedAt: timestamp('request_completed_at', { withTimezone: true }),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  rateLimitPerMin: integer('rate_limit_per_min').notNull().default(600),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ingestFailures = pgTable('ingest_failures', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  kafkaTopic: text('kafka_topic'),
  kafkaPartition: integer('kafka_partition'),
  kafkaOffset: bigint('kafka_offset', { mode: 'number' }),
  payload: jsonb('payload').notNull(),
  error: text('error').notNull(),
  retryCount: integer('retry_count').notNull().default(0),
  failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
});
