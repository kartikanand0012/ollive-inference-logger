/**
 * Mock LLM provider — a fake client shaped like the Anthropic SDK.
 *
 * Purpose: keyless, free, zero-network demos. It emits Anthropic-protocol
 * streaming events (message_start / content_block_delta / message_delta /
 * message_stop), so it plugs into the EXISTING AnthropicAdapter +
 * wrapAnthropic instrumentation — the mock exercises the identical
 * telemetry path as a real provider (events → Kafka → worker → Postgres →
 * dashboards). Nothing about the pipeline can tell it apart except the
 * provider/model labels and $0 cost.
 *
 * Behavior:
 * - Canned responses selected by keyword from the last user message, so the
 *   demo feels alive. One canned reply contains obvious fake PII to show off
 *   the worker's redaction in dashboards.
 * - Realistic timing: ~400ms time-to-first-token, then ~25ms per text chunk.
 * - Realistic token counts derived from the actual text lengths.
 * - Honors AbortSignal: aborting mid-stream throws an AbortError, which the
 *   SDK records as a 'cancelled' inference (stop-button demo works).
 */
export interface MockMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface MockCreateParams {
  model?: string;
  max_tokens?: number;
  stream?: boolean;
  system?: string;
  messages?: MockMessage[];
}

interface MockCreateOptions {
  signal?: AbortSignal;
}

// Anthropic-protocol event shapes (subset) consumed by anthropicExtractor.
type MockStreamEvent =
  | { type: 'message_start'; message: { usage: { input_tokens: number } } }
  | { type: 'content_block_start'; index: number; content_block: { type: 'text'; text: string } }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; usage: { output_tokens: number } }
  | { type: 'message_stop' };

const CANNED: Array<{ match: RegExp; reply: string }> = [
  {
    match: /hello|hi\b|hey|namaste/i,
    reply:
      'Hello! I am the mock provider — a stand-in LLM that costs $0.00 and ' +
      'needs no API key. Everything you see here (this stream, the token ' +
      'counts, the latency numbers) flows through the exact same ' +
      'instrumented pipeline as a real provider call. Try the Stop button ' +
      'mid-reply, then check the dashboard: this request will show up with ' +
      'real TTFT and token metrics.',
  },
  {
    match: /cost|price|pricing|expensive|cheap/i,
    reply:
      'Good question about cost. With the mock provider every token is ' +
      'free: estimated cost stays at $0.00 no matter how much you generate. ' +
      'Switch to a real provider in Settings and the same dashboards start ' +
      'showing per-model spend, cost per request, and token economics — ' +
      'same pipeline, real money math.',
  },
  {
    match: /pii|redact|privacy|email|phone/i,
    reply:
      'Here is a response containing fake PII so you can watch redaction ' +
      'work: contact Jane Doe at jane.doe@example.com or +1 (555) 014-2288 ' +
      'for the demo account. The worker strips PII before storage — open ' +
      'this request in the explorer and the stored preview will show ' +
      '[REDACTED] placeholders instead of the raw values.',
  },
  {
    match: /latency|ttft|fast|slow|speed/i,
    reply:
      'This mock streams with a ~400ms time-to-first-token and steady ' +
      'per-chunk pacing, so TTFT and p50/p95 latency charts look realistic. ' +
      'The numbers are honest about one thing: they measure the pipeline, ' +
      'not a real model. Token counts are derived from the actual text ' +
      'lengths at roughly 4 characters per token.',
  },
  {
    match: /kafka|pipeline|architecture|how.*work/i,
    reply:
      'Here is the journey of this very reply: the chat API streamed it to ' +
      'you over SSE while the SDK logged an inference event; the event was ' +
      'batched to the ingest API, produced to Kafka, consumed by the ' +
      'worker, PII-redacted, and batch-inserted into Postgres with ' +
      'idempotent request IDs. The dashboard you see is plain SQL over ' +
      'those rows — open /requests and drill into this one.',
  },
];

const FALLBACK =
  'Mock reply received. I match a few demo topics — try asking about ' +
  'cost, PII redaction, latency, or how the pipeline works. Or just say ' +
  'hello. Every reply is streamed, timed, token-counted, and logged ' +
  'through the full Kafka → Postgres pipeline, exactly like a real ' +
  'provider call, except the invoice says $0.00.';

function pickReply(messages: MockMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = lastUser?.content ?? '';
  for (const c of CANNED) {
    if (c.match.test(text)) return c.reply;
  }
  return FALLBACK;
}

/** Rough token estimate (~4 chars/token), matching the pipeline's honesty. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimatePromptTokens(messages: MockMessage[], system?: string): number {
  const text = (system ?? '') + '\n' + messages.map((m) => `${m.role}: ${m.content}`).join('\n');
  return estimateTokens(text);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function* streamReply(
  reply: string,
  promptTokens: number,
  signal?: AbortSignal,
): AsyncGenerator<MockStreamEvent, void, undefined> {
  yield { type: 'message_start', message: { usage: { input_tokens: promptTokens } } };
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };

  // Time-to-first-token: believable model latency before the first chunk.
  await sleep(350 + Math.random() * 250, signal);

  // Stream in word-ish chunks for a lively typewriter effect.
  const chunks = reply.match(/[^ ]+ +/g) ?? [reply];
  let emitted = '';
  for (const chunk of chunks) {
    await sleep(18 + Math.random() * 30, signal);
    emitted += chunk;
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } };
  }

  yield { type: 'content_block_stop', index: 0 };
  yield { type: 'message_delta', usage: { output_tokens: estimateTokens(emitted) } };
  yield { type: 'message_stop' };
}

// Final-message shape for non-streaming calls (mirrors the Anthropic SDK
// subset that captureFinalMessage in @ollive/sdk reads).
interface MockFinalMessage {
  content: Array<{ type: 'text'; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Drop-in stand-in for the Anthropic SDK client. Only `messages.create` is
 * implemented — the single interception point the SDK proxy instruments.
 */
export class MockAnthropicClient {
  readonly messages = {
    create: async (
      params: MockCreateParams,
      opts?: MockCreateOptions,
    ): Promise<AsyncGenerator<MockStreamEvent, void, undefined> | MockFinalMessage> => {
      const messages = params.messages ?? [];
      const reply = pickReply(messages);
      const promptTokens = estimatePromptTokens(messages, params.system);
      if (params.stream) {
        return streamReply(reply, promptTokens, opts?.signal);
      }
      // Non-streaming callers get a final-message shaped object.
      await sleep(400, opts?.signal);
      return {
        content: [{ type: 'text', text: reply }],
        usage: { input_tokens: promptTokens, output_tokens: estimateTokens(reply) },
      };
    },
  };
}

/** Model ids advertised for the mock provider (all free). */
export const MOCK_MODELS = ['mock-chat-1', 'mock-chat-1-fast'];
