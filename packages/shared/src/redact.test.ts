import { describe, expect, it } from 'vitest';
import { redactEvent, redactText } from './redact.js';
import { InferenceEventV1Schema } from './events.js';
import { newRequestId } from './ids.js';

// Table-driven: input → expected output.
const CASES: Array<{ name: string; input: string; expected: string }> = [
  {
    name: 'email',
    input: 'contact me at kartik@example.co.in please',
    expected: 'contact me at [REDACTED:email] please',
  },
  {
    name: 'indian phone with +91',
    input: 'call +91 98765 43210 now',
    expected: 'call [REDACTED:phone] now',
  },
  {
    name: 'bare 10-digit indian mobile',
    input: 'my number is 9876543210',
    expected: 'my number is [REDACTED:phone]',
  },
  {
    name: 'international phone',
    input: 'US office: +1 4155552671',
    expected: 'US office: [REDACTED:phone]',
  },
  {
    name: 'credit card (luhn-valid, spaced)',
    input: 'card 4111 1111 1111 1111 exp 12/28',
    expected: 'card [REDACTED:card] exp 12/28',
  },
  {
    name: 'luhn-invalid 16 digits stays (order id, not a card)',
    input: 'order 1234 5678 9012 3456 shipped',
    expected: 'order 1234 5678 9012 3456 shipped',
  },
  {
    name: 'aadhaar-format 12 digits',
    input: 'aadhaar: 2345 6789 0123',
    expected: 'aadhaar: [REDACTED:aadhaar]',
  },
  {
    name: 'ipv4',
    input: 'server at 192.168.1.100 down',
    expected: 'server at [REDACTED:ipv4] down',
  },
  {
    name: 'openai-style api key',
    input: 'use sk-proj-abc123DEF456ghi789 for auth',
    expected: 'use [REDACTED:api_key] for auth',
  },
  {
    name: 'aws access key',
    input: 'key AKIAIOSFODNN7EXAMPLE leaked',
    expected: 'key [REDACTED:api_key] leaked',
  },
  {
    name: 'multiple kinds in one string',
    input: 'mail a@b.io or call 9876543210',
    expected: 'mail [REDACTED:email] or call [REDACTED:phone]',
  },
  {
    name: 'clean text untouched',
    input: 'the p95 latency was 840ms across 6 partitions',
    expected: 'the p95 latency was 840ms across 6 partitions',
  },
];

describe('redactText', () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(redactText(c.input)).toBe(c.expected);
    });
  }
});

describe('redactEvent', () => {
  it('redacts previews and error message, leaves the rest intact', () => {
    const event = InferenceEventV1Schema.parse({
      schema_version: 1,
      request_id: newRequestId(),
      provider: 'openai',
      model: 'gpt-4o-mini',
      is_stream: false,
      status: 'error',
      timings: { started_at: new Date().toISOString() },
      error: { type: 'AuthError', message: 'key sk-live-abcdefgh12345678 rejected' },
      input_preview: 'email me at x@y.com',
      output_preview: 'sure, x@y.com it is',
      sdk_version: '0.1.0',
    });
    const redacted = redactEvent(event);
    expect(redacted.input_preview).toBe('email me at [REDACTED:email]');
    expect(redacted.output_preview).toBe('sure, [REDACTED:email] it is');
    expect(redacted.error?.message).toBe('key [REDACTED:api_key] rejected');
    expect(redacted.model).toBe('gpt-4o-mini');
    expect(redacted.request_id).toBe(event.request_id);
  });
});
