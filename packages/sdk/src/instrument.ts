import {
  PREVIEW_MAX_LEN,
  SCHEMA_VERSION,
  newRequestId,
  type InferenceEventV1,
  type InferenceStatus,
  type Provider,
} from '@ollive/shared';
import { getInferenceContext } from './context.js';
import type { BufferedTransport } from './transport.js';

export const SDK_VERSION = '0.1.0';

type AnyFn = (...args: never[]) => unknown;

/**
 * Proxy a method at `path` inside `root` (e.g. ['messages','create']) without
 * touching any other property. `Reflect.get` uses the original target as the
 * receiver so SDK classes with private fields keep working, and plain methods
 * are re-bound to the original object.
 */
export function wrapMethodPath<T extends object>(
  root: T,
  path: readonly string[],
  build: (original: AnyFn, self: object) => AnyFn,
): T {
  const [head, ...rest] = path as [string, ...string[]];
  return new Proxy(root, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === head) {
        if (rest.length === 0 && typeof value === 'function') {
          return build(value as AnyFn, target);
        }
        if (rest.length > 0 && value !== null && typeof value === 'object') {
          return wrapMethodPath(value as object, rest, build);
        }
      }
      return typeof value === 'function' ? (value as AnyFn).bind(target) : value;
    },
  }) as T;
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' ||
      err.name === 'APIUserAbortError' ||
      /abort/i.test(err.message))
  );
}

/** Best-effort input preview: last user message, else the messages JSON. */
export function previewOfInput(params: { messages?: unknown }): string {
  try {
    const msgs = Array.isArray(params.messages) ? params.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i] as { role?: string; content?: unknown };
      if (m?.role === 'user') {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return text.slice(0, PREVIEW_MAX_LEN);
      }
    }
    return JSON.stringify(msgs).slice(0, PREVIEW_MAX_LEN);
  } catch {
    return '';
  }
}

/** Collects timings/usage/output for one provider call and emits exactly one event. */
export class CallRecorder {
  readonly requestId = newRequestId();
  private readonly startedAt = new Date();
  private firstTokenAt: Date | undefined;
  private output = '';
  private promptTokens: number | undefined;
  private completionTokens: number | undefined;
  private emitted = false;
  // Captured at call time — the recorder may finalize on a different async
  // path (stream teardown) where the ALS store is no longer active.
  private readonly ctx = getInferenceContext();

  constructor(
    private readonly transport: BufferedTransport,
    private readonly meta: { provider: Provider; model: string; isStream: boolean; inputPreview: string },
  ) {}

  addText(text: string): void {
    // TTFB only means something for streams; non-stream text arrives at once.
    if (!this.firstTokenAt && this.meta.isStream) this.firstTokenAt = new Date();
    this.output += text;
  }

  addUsage(usage: { promptTokens?: number; completionTokens?: number }): void {
    if (usage.promptTokens != null) this.promptTokens = usage.promptTokens;
    if (usage.completionTokens != null) this.completionTokens = usage.completionTokens;
  }

  get finished(): boolean {
    return this.emitted;
  }

  finish(status: InferenceStatus, err?: unknown): void {
    if (this.emitted) return;
    this.emitted = true;
    try {
      const completedAt = new Date();
      const hasUsage = this.promptTokens != null || this.completionTokens != null;
      const event: InferenceEventV1 = {
        schema_version: SCHEMA_VERSION,
        request_id: this.requestId,
        ...(this.ctx?.conversationId ? { conversation_id: this.ctx.conversationId } : {}),
        ...(this.ctx?.sessionId ? { session_id: this.ctx.sessionId } : {}),
        ...(this.ctx?.messageId ? { message_id: this.ctx.messageId } : {}),
        provider: this.meta.provider,
        model: this.meta.model,
        is_stream: this.meta.isStream,
        status,
        timings: {
          started_at: this.startedAt.toISOString(),
          completed_at: completedAt.toISOString(),
          latency_ms: completedAt.getTime() - this.startedAt.getTime(),
          ...(this.firstTokenAt
            ? {
                first_token_at: this.firstTokenAt.toISOString(),
                ttfb_ms: this.firstTokenAt.getTime() - this.startedAt.getTime(),
              }
            : {}),
        },
        ...(hasUsage
          ? {
              usage: {
                ...(this.promptTokens != null ? { prompt_tokens: this.promptTokens } : {}),
                ...(this.completionTokens != null ? { completion_tokens: this.completionTokens } : {}),
                ...(this.promptTokens != null && this.completionTokens != null
                  ? { total_tokens: this.promptTokens + this.completionTokens }
                  : {}),
              },
            }
          : {}),
        ...(status === 'error' && err
          ? {
              error: {
                type: err instanceof Error ? err.constructor.name : 'Error',
                message: String(err instanceof Error ? err.message : err).slice(0, 2000),
              },
            }
          : {}),
        input_preview: this.meta.inputPreview,
        output_preview: this.output.slice(0, PREVIEW_MAX_LEN),
        sdk_version: SDK_VERSION,
      };
      this.transport.enqueue(event);
    } catch {
      // The SDK must never throw into the request path.
    }
  }
}

export interface StreamExtractor<TChunk> {
  textFromChunk(chunk: TChunk): string | undefined;
  usageFromChunk(
    chunk: TChunk,
  ): { promptTokens?: number; completionTokens?: number } | undefined;
}

/**
 * Wrap a provider stream so consuming it records TTFB, output preview, usage,
 * and terminal status (success / error / cancelled), while every other
 * property of the stream object passes through untouched.
 *
 * Cancellation is detected three ways, because providers differ:
 *  - the stream throws an abort error (OpenAI-style),
 *  - the stream ENDS GRACEFULLY after an abort — the Anthropic SDK swallows
 *    AbortError inside its Stream iterator, so a cancelled request looks like
 *    a short successful one; the request's AbortSignal is the tie-breaker,
 *  - early consumer teardown (break / .return()) without any signal.
 */
export function instrumentStream<T extends AsyncIterable<unknown>>(
  stream: T,
  rec: CallRecorder,
  extractor: StreamExtractor<unknown>,
  signal?: AbortSignal,
): T {
  const instrumented = (async function* () {
    try {
      for await (const chunk of stream) {
        try {
          const text = extractor.textFromChunk(chunk);
          if (text) rec.addText(text);
          const usage = extractor.usageFromChunk(chunk);
          if (usage) rec.addUsage(usage);
        } catch {
          // extraction problems must never break the consumer's stream
        }
        yield chunk;
      }
      rec.finish(signal?.aborted ? 'cancelled' : 'success');
    } catch (err) {
      rec.finish(isAbortError(err) || signal?.aborted ? 'cancelled' : 'error', err);
      throw err;
    } finally {
      // Early consumer teardown: the loop above never completed, so record
      // what we have as cancelled.
      if (!rec.finished) rec.finish('cancelled');
    }
  })();

  return new Proxy(stream, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) {
        return () => instrumented[Symbol.asyncIterator]();
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: never[]) => unknown).bind(target) : value;
    },
  }) as T;
}
