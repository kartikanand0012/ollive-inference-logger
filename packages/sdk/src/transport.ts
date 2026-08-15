import type { InferenceEventV1 } from '@ollive/shared';

export interface TransportOptions {
  url: string;
  apiKey: string;
  /** Flush when this many events are buffered (default 50). */
  maxBatch?: number;
  /** …or when this much time has passed since the first buffered event (default 2000ms). */
  flushIntervalMs?: number;
  /** Hard buffer cap — overflow drops OLDEST events (default 1000). */
  maxBuffer?: number;
  /** Retries per POST with exponential backoff + jitter (default 3). */
  maxRetries?: number;
}

/**
 * Fire-and-forget buffered event shipper. Invariant: NOTHING in here may ever
 * throw into or block the request path — failures degrade to dropped
 * telemetry, counted in `dropped`.
 */
export class BufferedTransport {
  private buffer: InferenceEventV1[] = [];
  private timer: NodeJS.Timeout | null = null;
  private droppedCount = 0;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly maxBatch: number;
  private readonly flushIntervalMs: number;
  private readonly maxBuffer: number;
  private readonly maxRetries: number;

  constructor(opts: TransportOptions) {
    this.url = opts.url.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.maxBatch = opts.maxBatch ?? 50;
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000;
    this.maxBuffer = opts.maxBuffer ?? 1000;
    this.maxRetries = opts.maxRetries ?? 3;

    // Best-effort flush when the event loop drains; apps with explicit
    // graceful shutdown should also call `shutdown()`.
    process.once('beforeExit', () => void this.flush());
  }

  get dropped(): number {
    return this.droppedCount;
  }

  enqueue(event: InferenceEventV1): void {
    try {
      if (this.buffer.length >= this.maxBuffer) {
        this.buffer.shift();
        this.droppedCount++;
      }
      this.buffer.push(event);
      if (this.buffer.length >= this.maxBatch) {
        void this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => void this.flush(), this.flushIntervalMs);
        this.timer.unref();
      }
    } catch {
      this.droppedCount++;
    }
  }

  /** Drain the buffer. Safe to call concurrently; never rejects. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    for (let i = 0; i < batch.length; i += this.maxBatch) {
      await this.post(batch.slice(i, i + this.maxBatch));
    }
  }

  async shutdown(): Promise<void> {
    await this.flush();
  }

  private async post(events: InferenceEventV1[]): Promise<void> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(`${this.url}/v1/logs`, {
          method: 'POST',
          // keepalive lets browser environments flush on page hide; Node's
          // undici accepts and ignores it.
          keepalive: true,
          headers: { 'content-type': 'application/json', 'x-ingest-key': this.apiKey },
          body: JSON.stringify(events),
        });
        if (res.ok) return;
        // Non-retryable client error (bad key, oversized body): drop now.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.droppedCount += events.length;
          return;
        }
      } catch {
        // network error → retry
      }
      if (attempt < this.maxRetries) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 250 + Math.random() * 100));
      }
    }
    this.droppedCount += events.length;
  }
}

let defaultTransport: BufferedTransport | null = null;

function numEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Process-wide transport configured from INGEST_URL / INGEST_KEY. Delivery
 * knobs are env-tunable without a code change: lower SDK_FLUSH_MS for
 * fresher dashboards, raise SDK_MAX_BUFFER / SDK_MAX_RETRIES to trade memory
 * and send-latency for fewer drops under ingest outages.
 */
export function getDefaultTransport(): BufferedTransport {
  if (!defaultTransport) {
    defaultTransport = new BufferedTransport({
      url: process.env.INGEST_URL ?? 'http://localhost:4318',
      apiKey: process.env.INGEST_KEY ?? 'dev-ingest-key',
      maxBatch: numEnv('SDK_MAX_BATCH', 50),
      flushIntervalMs: numEnv('SDK_FLUSH_MS', 2000),
      maxBuffer: numEnv('SDK_MAX_BUFFER', 1000),
      maxRetries: numEnv('SDK_MAX_RETRIES', 3),
    });
  }
  return defaultTransport;
}
