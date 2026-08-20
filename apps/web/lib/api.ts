export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface Conversation {
  id: string;
  title: string | null;
  provider: string;
  model: string;
  status: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  seq: number;
  status: 'complete' | 'cancelled' | 'error';
}

export type ChatEvent =
  | { type: 'start'; conversationId: string; messageId: string }
  | { type: 'token'; text: string }
  | { type: 'done'; conversationId: string; messageId: string; cancelled: boolean }
  | { type: 'error'; conversationId?: string; message: string };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchMeta = () =>
  getJson<{ providers: string[]; models: Record<string, string[]> }>('/v1/meta');
export const fetchConversations = () => getJson<Conversation[]>('/v1/conversations');
export const fetchMessages = (conversationId: string) =>
  getJson<Message[]>(`/v1/conversations/${conversationId}/messages`);

export async function cancelConversation(conversationId: string): Promise<void> {
  await fetch(`${API_URL}/v1/conversations/${conversationId}/cancel`, { method: 'POST' });
}

// ── dashboard stats ──────────────────────────────────────────────────────────

export interface StatsSummary {
  requests: number;
  errors: number;
  cancelled: number;
  p95_latency_ms: number | null;
  total_tokens: number | string;
  ttfb_p50: number | null;
  est_cost_usd: number | null;
  flagged_injection: number;
}
export interface ModelRow {
  provider: string;
  model: string;
  requests: number;
  errors: number;
  cancelled: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  ttfb_p50: number | null;
  prompt_tokens: number | string;
  completion_tokens: number | string;
  tokens_per_sec: number | null;
  est_cost_usd: number | null;
}
export interface TimeseriesRow {
  bucket: string;
  requests: number;
  errors: number;
  cancelled: number;
  p50: number | null;
  p95: number | null;
  est_cost_usd: number | null;
}
export interface ErrorRateRow {
  provider: string;
  model: string;
  total: number;
  errors: number;
  error_rate_pct: number;
}
export interface RecentErrorRow {
  id: string;
  request_started_at: string;
  provider: string;
  model: string;
  error_type: string | null;
  error_message: string | null;
}
export interface TokensRow {
  bucket: string;
  model: string;
  tokens: number | string;
}

export interface Facets { provider: string[]; model: string[]; tenant: string[]; }

// qs = filter query string already containing window + any provider/model/etc.
export const fetchStats = {
  facets: () => getJson<Facets>('/v1/stats/facets'),
  summary: (qs: string) => getJson<StatsSummary>(`/v1/stats/summary?${qs}`),
  models: (qs: string) => getJson<{ rows: ModelRow[] }>(`/v1/stats/models?${qs}`),
  timeseries: (qs: string) => getJson<{ unit: string; rows: TimeseriesRow[] }>(`/v1/stats/timeseries?${qs}`),
  errors: (qs: string) => getJson<{ rates: ErrorRateRow[]; recent: RecentErrorRow[] }>(`/v1/stats/errors?${qs}`),
  tokens: (qs: string) => getJson<{ rows: TokensRow[] }>(`/v1/stats/tokens?${qs}`),
};

// ── requests explorer ────────────────────────────────────────────────────────

export interface LogListRow {
  id: string;
  requestStartedAt: string;
  provider: string;
  model: string;
  status: 'success' | 'error' | 'cancelled';
  isStream: boolean;
  latencyMs: number | null;
  ttfbMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  errorType: string | null;
  inputPreview: string | null;
  conversationId: string | null;
  flaggedInjection: boolean;
  estCostUsd: number | null;
}

export interface LogDetail {
  log: LogListRow & {
    requestCompletedAt: string | null;
    ingestedAt: string;
    requestId: string;
    messageId: string | null;
    errorMessage: string | null;
    outputPreview: string | null;
    raw: unknown;
  };
  estCostUsd: number | null;
  conversation: { id: string; title: string | null } | null;
}

export function fetchLogs(params: {
  window?: number;
  provider?: string;
  model?: string;
  status?: string;
  conversationId?: string;
  before?: string;
}): Promise<{ rows: LogListRow[]; nextBefore: string | null }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  return getJson(`/v1/logs?${qs.toString()}`);
}

export const fetchLogDetail = (id: string) => getJson<LogDetail>(`/v1/logs/${id}`);

// crypto.randomUUID() only exists in secure contexts (HTTPS / localhost).
// Over plain HTTP on an IP it is undefined, so build a v4 uuid from
// getRandomValues (available everywhere), with a Math.random fallback.
function uuidv4(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

/** Stable per-browser-session id — groups a user's turns in telemetry. */
export function getSessionId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  let sid = window.sessionStorage.getItem('ollive-session');
  if (!sid) {
    sid = uuidv4();
    window.sessionStorage.setItem('ollive-session', sid);
  }
  return sid;
}

/** POST /v1/chat and yield parsed SSE frames. */
export async function* streamChat(body: {
  conversationId?: string;
  message: string;
  provider: string;
  model: string;
  sessionId?: string;
}): AsyncGenerator<ChatEvent, void, undefined> {
  const res = await fetch(`${API_URL}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data: ')) {
          yield JSON.parse(line.slice(6)) as ChatEvent;
        }
      }
    }
  }
}
