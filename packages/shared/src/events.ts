import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;

/** Previews are truncated to this length by the SDK; redaction happens in the worker. */
export const PREVIEW_MAX_LEN = 500;

// zod's built-in .uuid() has historically pinned the version nibble to 1–5,
// which rejects UUIDv7 request_ids. Version-agnostic regex instead — our SDK
// emits v7, but ingest deliberately accepts any UUID version from external
// producers (v7's time-sortability only affects index locality).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const zUuid = z.string().regex(UUID_RE, 'invalid uuid');

export const ProviderSchema = z.enum(['anthropic', 'openai', 'gemini']);
export type Provider = z.infer<typeof ProviderSchema>;

export const InferenceStatusSchema = z.enum(['success', 'error', 'cancelled']);
export type InferenceStatus = z.infer<typeof InferenceStatusSchema>;

/**
 * The versioned wire contract between @ollive/sdk and the ingest API.
 * One event per completed (or failed / cancelled) inference request.
 */
export const InferenceEventV1Schema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  request_id: zUuid, // uuid v7 — time-sortable idempotency key
  conversation_id: zUuid.optional(),
  session_id: z.string().max(200).optional(),
  message_id: zUuid.optional(),
  provider: ProviderSchema,
  model: z.string().min(1).max(200),
  is_stream: z.boolean(),
  status: InferenceStatusSchema,
  timings: z.object({
    started_at: z.string().datetime(),
    first_token_at: z.string().datetime().optional(),
    completed_at: z.string().datetime().optional(),
    latency_ms: z.number().int().nonnegative().optional(),
    ttfb_ms: z.number().int().nonnegative().optional(),
  }),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  error: z
    .object({
      type: z.string().max(200),
      message: z.string().max(2000),
    })
    .optional(),
  input_preview: z.string().max(PREVIEW_MAX_LEN),
  output_preview: z.string().max(PREVIEW_MAX_LEN),
  sdk_version: z.string().max(50),
});

export type InferenceEventV1 = z.infer<typeof InferenceEventV1Schema>;
