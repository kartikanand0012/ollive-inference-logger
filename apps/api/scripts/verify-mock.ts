// Standalone verification of the mock provider through the REAL instrumented
// path: MockAnthropicClient -> wrapAnthropic (SDK proxy) -> AnthropicAdapter.
// Run: pnpm --filter @ollive/api exec tsx scripts/verify-mock.ts  (from repo root)
import { AnthropicAdapter, MockAnthropicClient } from '@ollive/providers';
import { wrapAnthropic, BufferedTransport } from '@ollive/sdk';

// Dead-end transport: captures events instead of POSTing them.
const seen: any[] = [];
const transport = new BufferedTransport({
  url: 'http://127.0.0.1:1/ingest',
  apiKey: 'test',
  flushIntervalMs: 60_000,
});
const origEnqueue = transport.enqueue.bind(transport);
// @ts-expect-error monkey-patch for verification
transport.enqueue = (e: any) => { seen.push(e); };

const client = wrapAnthropic(new MockAnthropicClient() as any, transport, 'mock');
const adapter = new AnthropicAdapter(client as any);

async function main() {
  // 1. Normal streaming chat
  const deltas: string[] = [];
  let usage: any = null;
  for await (const ev of adapter.streamChat({
    model: 'mock-chat-1',
    messages: [{ role: 'user', content: 'hello there' }],
    maxTokens: 500,
  })) {
    if (ev.type === 'delta') deltas.push(ev.text);
    if (ev.type === 'usage') usage = { ...(usage ?? {}), ...ev };
  }
  const text = deltas.join('');
  console.log('streamed chars:', text.length, '| deltas:', deltas.length);
  console.log('usage:', JSON.stringify(usage));
  console.log('preview:', text.slice(0, 80));
  if (!text.includes('mock provider')) throw new Error('canned hello reply not returned');
  if (!usage?.promptTokens || !usage?.completionTokens) throw new Error('usage events missing');

  // 2. Telemetry event was recorded through the SDK path
  await new Promise((r) => setTimeout(r, 300));
  console.log('telemetry events captured:', seen.length);
  const evt = seen[0];
  if (!evt) throw new Error('no telemetry event captured');
  console.log('event provider/model:', evt.provider, '/', evt.model, '| status:', evt.status);
  if (evt.provider !== 'mock') throw new Error(`expected provider=mock, got ${evt.provider}`);

  // 3. Abort mid-stream -> AbortError (chat Stop button path)
  const ac = new AbortController();
  const gen = adapter.streamChat({
    model: 'mock-chat-1',
    messages: [{ role: 'user', content: 'tell me about latency' }],
    maxTokens: 500,
    signal: ac.signal,
  });
  // Consume until the first text delta arrives (message_start yields usage first),
  // then abort mid-stream and expect the AbortError to propagate.
  let sawDelta = false;
  let aborted = false;
  try {
    for await (const ev of gen) {
      if (ev.type === 'delta' && !sawDelta) { sawDelta = true; ac.abort(); }
    }
  } catch (err: any) {
    aborted = err?.name === 'AbortError';
  }
  if (!sawDelta) throw new Error('never saw a delta');
  console.log('abort -> AbortError:', aborted);
  if (!aborted) throw new Error('abort did not raise AbortError');

  // 4. PII canned reply
  const deltas2: string[] = [];
  for await (const ev of adapter.streamChat({
    model: 'mock-chat-1',
    messages: [{ role: 'user', content: 'what about PII redaction?' }],
    maxTokens: 500,
  })) {
    if (ev.type === 'delta') deltas2.push(ev.text);
  }
  const t2 = deltas2.join('');
  if (!t2.includes('jane.doe@example.com')) throw new Error('PII canned reply not returned');
  console.log('PII canned reply ok');

  console.log('\nMOCK PROVIDER VERIFICATION: ALL PASS');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
