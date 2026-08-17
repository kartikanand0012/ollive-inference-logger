// Demo traffic: ~25–30 REAL provider requests through the full pipeline
// (chat API → SDK auto-instrumentation → ingest → Kafka → worker → Postgres)
// using cheap models with tiny prompts, plus a few invalid-model calls that
// produce genuine provider errors for the errors dashboard.
//
// Run: pnpm tsx scripts/generate-traffic.ts   (api/ingest/worker must be up;
// at least one of ANTHROPIC_API_KEY / OPENAI_API_KEY set on the api process)

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

interface Task {
  provider: 'anthropic' | 'openai';
  model: string;
  message: string;
  conversationKey?: string; // tasks sharing a key continue one conversation
  expectError?: boolean;
}

const SHORT_PROMPTS = [
  'Answer in five words or fewer: what is Kafka?',
  'Reply with exactly one word: the opposite of hot.',
  'Give one short sentence about Postgres indexes.',
  'Name two HTTP methods. Nothing else.',
  'Reply with exactly: pong',
  'One short sentence: why use a message queue?',
  'What is 17 + 25? Number only.',
  'Name one Kafka guarantee in under six words.',
  'One word: the capital of France.',
  'In under eight words, define idempotency.',
];

async function providersConfigured(): Promise<string[]> {
  const res = await fetch(`${API_URL}/healthz`);
  const body = (await res.json()) as { providers: string[] };
  return body.providers;
}

function buildTasks(providers: string[]): Task[] {
  const tasks: Task[] = [];
  const cheap: Record<string, string> = {
    anthropic: 'claude-haiku-4-5',
    openai: 'gpt-4o-mini',
  };
  const active = providers.filter((p) => p in cheap);
  if (active.length === 0) return tasks;

  // ~20 single-turn requests, round-robin across configured providers
  for (let i = 0; i < 20; i++) {
    const provider = active[i % active.length] as Task['provider'];
    tasks.push({ provider, model: cheap[provider]!, message: SHORT_PROMPTS[i % SHORT_PROMPTS.length]! });
  }
  // two short multi-turn conversations (3 turns each → resume path)
  for (const [j, provider] of active.slice(0, 2).entries()) {
    const key = `conv-${j}`;
    tasks.push(
      { provider: provider as Task['provider'], model: cheap[provider]!, message: 'Pick a random fruit. One word.', conversationKey: key },
      { provider: provider as Task['provider'], model: cheap[provider]!, message: 'What color is it? One word.', conversationKey: key },
      { provider: provider as Task['provider'], model: cheap[provider]!, message: 'Repeat the fruit name. One word.', conversationKey: key },
    );
  }
  // 4 genuine provider errors via invalid model names
  for (let i = 0; i < 4; i++) {
    const provider = active[i % active.length] as Task['provider'];
    tasks.push({
      provider,
      model: provider === 'anthropic' ? 'claude-nonexistent-model' : 'gpt-nonexistent-model',
      message: 'hello',
      expectError: true,
    });
  }
  return tasks;
}

/** POST /v1/chat, drain the SSE stream, return the conversation id. */
async function runChat(task: Task, conversationId?: string): Promise<string | undefined> {
  const res = await fetch(`${API_URL}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      message: task.message,
      provider: task.provider,
      model: task.model,
    }),
  });
  if (!res.ok || !res.body) {
    console.log(`  http ${res.status} (${task.provider}/${task.model})`);
    return conversationId;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let convId = conversationId;
  let status = 'ok';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const ev = JSON.parse(line.slice(6)) as { type: string; conversationId?: string };
        if (ev.type === 'start') convId = ev.conversationId;
        if (ev.type === 'error') status = 'provider error (expected for invalid models)';
      }
    }
  }
  console.log(`  ${task.provider}/${task.model} → ${status}`);
  return convId;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const providers = await providersConfigured();
  if (providers.length === 0) {
    console.error('No provider keys configured on the api — set ANTHROPIC_API_KEY and/or OPENAI_API_KEY.');
    process.exit(1);
  }
  const tasks = buildTasks(providers);
  console.log(`Generating ${tasks.length} requests across [${providers.join(', ')}]…`);

  const conversations = new Map<string, string>();
  let n = 0;
  for (const task of tasks) {
    n++;
    process.stdout.write(`${n}/${tasks.length}`);
    const existing = task.conversationKey ? conversations.get(task.conversationKey) : undefined;
    const convId = await runChat(task, existing);
    if (task.conversationKey && convId) conversations.set(task.conversationKey, convId);
    await sleep(800 + Math.random() * 1500); // spread over a few minutes
  }

  // Rough cost ceiling: ≤ ~250 input + ~120 output tokens per request.
  const perReq = { anthropic: (250 * 1 + 120 * 5) / 1e6, openai: (250 * 0.15 + 120 * 0.6) / 1e6 };
  const est = tasks.reduce((s, t) => s + (perReq[t.provider] ?? 0), 0);
  console.log(`\nDone. Estimated provider spend: ~$${est.toFixed(3)} (upper bound).`);
  console.log('Tip: open the UI, start a long generation ("write a 500 word story") and hit Stop to add cancellations to the dashboard.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
