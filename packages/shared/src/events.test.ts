import { describe, expect, it } from 'vitest';
import { InferenceEventV1Schema, PREVIEW_MAX_LEN } from './events.js';
import { newRequestId } from './ids.js';

function validEvent(): Record<string, unknown> {
  return {
    schema_version: 1,
    request_id: newRequestId(),
    conversation_id: 'c8bfb9b4-3d17-4a6e-9c1e-0e5f4a1b2c3d',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    is_stream: true,
    status: 'success',
    timings: {
      started_at: new Date().toISOString(),
      first_token_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      latency_ms: 812,
      ttfb_ms: 133,
    },
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    input_preview: 'hello',
    output_preview: 'world',
    sdk_version: '0.1.0',
  };
}

describe('InferenceEventV1Schema', () => {
  it('accepts a valid event with a v7 request_id', () => {
    const result = InferenceEventV1Schema.safeParse(validEvent());
    expect(result.success).toBe(true);
  });

  it('accepts minimal events (no usage, no optional ids)', () => {
    const ev = validEvent();
    delete ev.usage;
    delete ev.conversation_id;
    expect(InferenceEventV1Schema.safeParse(ev).success).toBe(true);
  });

  it('rejects a malformed request_id', () => {
    const ev = { ...validEvent(), request_id: 'not-a-uuid' };
    expect(InferenceEventV1Schema.safeParse(ev).success).toBe(false);
  });

  it('rejects unknown status values', () => {
    const ev = { ...validEvent(), status: 'partial' };
    expect(InferenceEventV1Schema.safeParse(ev).success).toBe(false);
  });

  it('rejects wrong schema_version', () => {
    const ev = { ...validEvent(), schema_version: 2 };
    expect(InferenceEventV1Schema.safeParse(ev).success).toBe(false);
  });

  it('rejects previews longer than the cap', () => {
    const ev = { ...validEvent(), output_preview: 'x'.repeat(PREVIEW_MAX_LEN + 1) };
    expect(InferenceEventV1Schema.safeParse(ev).success).toBe(false);
  });

  it('rejects negative token counts and latencies', () => {
    const ev = validEvent();
    (ev.usage as Record<string, number>).prompt_tokens = -1;
    expect(InferenceEventV1Schema.safeParse(ev).success).toBe(false);
  });
});
