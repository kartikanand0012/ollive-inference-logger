import { afterEach, describe, expect, it, vi } from 'vitest';
import { InferenceEventV1Schema, type InferenceEventV1 } from '@ollive/shared';
import { BufferedTransport } from './transport.js';
import { wrapAnthropic } from './wrap-anthropic.js';
import { wrapOpenAI } from './wrap-openai.js';
import { runWithInferenceContext } from './context.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── BufferedTransport ────────────────────────────────────────────────────────

function fetchStub(status = 202) {
  const calls: unknown[][] = [];
  const stub = vi.fn(async (_url: unknown, init: { body: string }) => {
    calls.push(JSON.parse(init.body) as unknown[]);
    return new Response('{}', { status });
  });
  vi.stubGlobal('fetch', stub);
  return { stub, calls };
}

function fakeEvent(i: number): InferenceEventV1 {
  return {
    schema_version: 1,
    request_id: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    is_stream: false,
    status: 'success',
    timings: { started_at: new Date().toISOString() },
    input_preview: `in-${i}`,
    output_preview: '',
    sdk_version: '0.1.0',
  };
}

describe('BufferedTransport', () => {
  it('flushes when the batch size is reached', async () => {
    const { calls } = fetchStub();
    const t = new BufferedTransport({ url: 'http://x', apiKey: 'k', maxBatch: 5, flushIntervalMs: 60_000 });
    for (let i = 0; i < 5; i++) t.enqueue(fakeEvent(i));
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect((calls[0] as unknown[]).length).toBe(5);
  });

  it('flushes on the interval timer for partial batches', async () => {
    const { calls } = fetchStub();
    const t = new BufferedTransport({ url: 'http://x', apiKey: 'k', maxBatch: 50, flushIntervalMs: 30 });
    t.enqueue(fakeEvent(1));
    await vi.waitFor(() => expect(calls.length).toBe(1), { timeout: 1000 });
    expect((calls[0] as unknown[]).length).toBe(1);
  });

  it('drops OLDEST events on overflow and counts them', async () => {
    fetchStub();
    const t = new BufferedTransport({ url: 'http://x', apiKey: 'k', maxBatch: 100, flushIntervalMs: 60_000, maxBuffer: 5 });
    for (let i = 0; i < 8; i++) t.enqueue(fakeEvent(i));
    expect(t.dropped).toBe(3);
  });

  it('retries transient failures with backoff and then delivers', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempts++;
        if (attempts < 3) throw new Error('ECONNREFUSED');
        return new Response('{}', { status: 202 });
      }),
    );
    const t = new BufferedTransport({ url: 'http://x', apiKey: 'k', maxBatch: 1, flushIntervalMs: 60_000 });
    t.enqueue(fakeEvent(1));
    await vi.waitFor(() => expect(attempts).toBe(3), { timeout: 5000 });
    expect(t.dropped).toBe(0);
  });

  it('drops immediately on non-retryable 4xx', async () => {
    const { stub } = fetchStub(401);
    const t = new BufferedTransport({ url: 'http://x', apiKey: 'bad', maxBatch: 1, flushIntervalMs: 60_000 });
    t.enqueue(fakeEvent(1));
    await vi.waitFor(() => expect(t.dropped).toBe(1), { timeout: 2000 });
    expect(stub).toHaveBeenCalledTimes(1);
  });
});

// ── Auto-instrumentation wrappers ────────────────────────────────────────────

function captureTransport() {
  const events: InferenceEventV1[] = [];
  const t = new BufferedTransport({ url: 'http://x', apiKey: 'k', maxBatch: 10_000, flushIntervalMs: 3_600_000 });
  vi.spyOn(t, 'enqueue').mockImplementation((e) => {
    // every emitted event must satisfy the wire contract
    events.push(InferenceEventV1Schema.parse(e));
  });
  return { t, events };
}

const anthropicStreamChunks = [
  { type: 'message_start', message: { usage: { input_tokens: 7 } } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
  { type: 'message_delta', usage: { output_tokens: 2 } },
];

function fakeAnthropic(opts: { fail?: boolean } = {}) {
  return {
    other: 42,
    messages: {
      async create(params: { stream?: boolean; model?: string; messages?: unknown }) {
        if (opts.fail) {
          const err = new Error('invalid model');
          err.name = 'NotFoundError';
          throw err;
        }
        if (params.stream) {
          return (async function* () {
            for (const c of anthropicStreamChunks) yield c;
          })();
        }
        return {
          usage: { input_tokens: 3, output_tokens: 5 },
          content: [{ type: 'text', text: 'hi there' }],
        };
      },
    },
  };
}

describe('wrapAnthropic', () => {
  it('records a non-streaming call without touching the result', async () => {
    const { t, events } = captureTransport();
    const client = wrapAnthropic(fakeAnthropic(), t);
    const res = (await client.messages.create({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'say hi' }],
    })) as { content: Array<{ text: string }> };

    expect(res.content[0]!.text).toBe('hi there');
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.status).toBe('success');
    expect(ev.is_stream).toBe(false);
    expect(ev.usage).toEqual({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
    expect(ev.input_preview).toBe('say hi');
    expect(ev.output_preview).toBe('hi there');
    expect(ev.timings.ttfb_ms).toBeUndefined();
  });

  it('records a streamed call: ttfb, accumulated preview, usage from chunks', async () => {
    const { t, events } = captureTransport();
    const client = wrapAnthropic(fakeAnthropic(), t);
    const stream = (await client.messages.create({
      model: 'claude-haiku-4-5',
      stream: true,
      messages: [{ role: 'user', content: 'hello?' }],
    })) as AsyncIterable<unknown>;

    let n = 0;
    for await (const _chunk of stream) n++;
    expect(n).toBe(anthropicStreamChunks.length);

    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.status).toBe('success');
    expect(ev.is_stream).toBe(true);
    expect(ev.output_preview).toBe('hello');
    expect(ev.timings.ttfb_ms).toBeGreaterThanOrEqual(0);
    expect(ev.usage).toEqual({ prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
  });

  it('records cancelled with partial output on early stream teardown', async () => {
    const { t, events } = captureTransport();
    const client = wrapAnthropic(fakeAnthropic(), t);
    const stream = (await client.messages.create({
      model: 'claude-haiku-4-5',
      stream: true,
      messages: [{ role: 'user', content: 'hello?' }],
    })) as AsyncIterable<unknown>;

    let seen = 0;
    for await (const _chunk of stream) {
      if (++seen === 2) break; // consumer aborts mid-stream
    }

    expect(events.length).toBe(1);
    expect(events[0]!.status).toBe('cancelled');
    expect(events[0]!.output_preview).toBe('hel');
  });

  it('records cancelled when the SDK swallows an abort and ends the stream gracefully', async () => {
    // The Anthropic SDK catches AbortError inside its Stream iterator and
    // terminates iteration cleanly — from the consumer's side a cancelled
    // request looks exactly like a short successful one. The request's
    // AbortSignal must be the tie-breaker (regression: live cancel produced
    // status=success telemetry).
    const { t, events } = captureTransport();
    const ac = new AbortController();
    const client = wrapAnthropic(
      {
        messages: {
          async create(
            _params: { stream?: boolean; model?: string; messages?: unknown },
            _opts?: { signal?: AbortSignal },
          ) {
            return (async function* () {
              yield anthropicStreamChunks[0];
              yield anthropicStreamChunks[1];
              ac.abort(); // abort mid-stream…
              // …and end gracefully, exactly like the real SDK does.
            })();
          },
        },
      },
      t,
    );
    const stream = (await client.messages.create(
      { model: 'claude-haiku-4-5', stream: true, messages: [{ role: 'user', content: 'x' }] },
      { signal: ac.signal },
    )) as AsyncIterable<unknown>;
    for await (const _chunk of stream) {
      // consume to graceful end
    }
    expect(events.length).toBe(1);
    expect(events[0]!.status).toBe('cancelled');
    expect(events[0]!.output_preview).toBe('hel');
  });

  it('records provider errors and rethrows them untouched', async () => {
    const { t, events } = captureTransport();
    const client = wrapAnthropic(fakeAnthropic({ fail: true }), t);
    await expect(
      client.messages.create({ model: 'nope', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow('invalid model');
    expect(events.length).toBe(1);
    expect(events[0]!.status).toBe('error');
    expect(events[0]!.error?.type).toBe('Error');
  });

  it('attaches AsyncLocalStorage context without threading ids through call sites', async () => {
    const { t, events } = captureTransport();
    const client = wrapAnthropic(fakeAnthropic(), t);
    const ctx = {
      conversationId: '11111111-2222-4333-8444-555555555555',
      messageId: '99999999-8888-4777-8666-555555555555',
    };
    await runWithInferenceContext(ctx, () =>
      client.messages.create({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    );
    expect(events[0]!.conversation_id).toBe(ctx.conversationId);
    expect(events[0]!.message_id).toBe(ctx.messageId);
  });

  it('leaves every other client property untouched', () => {
    const { t } = captureTransport();
    const client = wrapAnthropic(fakeAnthropic(), t);
    expect(client.other).toBe(42);
  });
});

describe('wrapOpenAI', () => {
  it('records streamed calls incl. usage from the final chunk', async () => {
    const { t, events } = captureTransport();
    const client = wrapOpenAI(
      {
        chat: {
          completions: {
            async create(_params: { stream?: boolean; model?: string; messages?: unknown }) {
              return (async function* () {
                yield { choices: [{ delta: { content: 'ok' } }] };
                yield { choices: [], usage: { prompt_tokens: 4, completion_tokens: 1 } };
              })();
            },
          },
        },
      },
      t,
    );
    const stream = (await client.chat.completions.create({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    })) as AsyncIterable<unknown>;
    for await (const _c of stream) {
      // consume
    }
    expect(events.length).toBe(1);
    expect(events[0]!.provider).toBe('openai');
    expect(events[0]!.output_preview).toBe('ok');
    expect(events[0]!.usage?.total_tokens).toBe(5);
  });
});
