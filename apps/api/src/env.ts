export const env = {
  port: Number(process.env.API_PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://ollive:ollive@localhost:5432/ollive',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
  openaiApiKey: process.env.OPENAI_API_KEY || undefined,
  /** Where the SDK ships events (used from Phase 2 on). */
  ingestUrl: process.env.INGEST_URL ?? 'http://localhost:4318',
  ingestKey: process.env.INGEST_KEY ?? 'dev-ingest-key',
  maxTokens: Number(process.env.CHAT_MAX_TOKENS ?? 1024),
  /** Context window strategy: last N messages, no summarization — deliberate tradeoff. */
  contextMessages: 20,
  /**
   * Chat messages are domain data and stay raw by default; telemetry previews
   * are always redacted in the worker. Flip to also redact domain data.
   */
  redactMessages: process.env.REDACT_MESSAGES === 'true',
  /** Block (400) chat inputs the injection heuristics flag; default: log-only. */
  guardrailsBlock: process.env.GUARDRAILS_BLOCK === 'true',
  /** Hard ceiling per generation — a wedged provider stream can't hold an SSE slot forever. */
  chatTimeoutMs: Number(process.env.CHAT_TIMEOUT_MS ?? 120_000),
  /** Comma-separated allowed origins; unset = allow all (dev). */
  corsOrigin: process.env.CORS_ORIGIN,
  /** Per-IP requests/minute on the chat API. */
  rateLimitPerMin: Number(process.env.API_RATE_LIMIT ?? 120),
};
