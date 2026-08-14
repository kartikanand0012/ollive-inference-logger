// Cancellation registry. In-memory AbortControllers handle THIS instance's
// streams; with REDIS_URL set, cancels also fan out over Valkey/Redis pub/sub
// so any api replica can cancel a generation running on any other
// (the one change a compose→cloud move forces).
// Without REDIS_URL the bus is off and behavior is identical to before.
import { Redis } from 'ioredis';

const inflight = new Map<string, Set<AbortController>>();
const CHANNEL = 'ollive:cancel';

let pub: Redis | null = null;
let sub: Redis | null = null;

type LogFn = { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };

export async function initCancelBus(redisUrl: string | undefined, log: LogFn): Promise<void> {
  if (!redisUrl) {
    log.info({}, 'cancel bus: single-instance mode (no REDIS_URL)');
    return;
  }
  pub = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  sub = new Redis(redisUrl);
  pub.on('error', (err) => log.warn({ err: String(err) }, 'cancel bus publisher error'));
  sub.on('error', (err) => log.warn({ err: String(err) }, 'cancel bus subscriber error'));
  await sub.subscribe(CHANNEL);
  sub.on('message', (_channel, conversationId) => {
    abortLocal(conversationId); // idempotent — self-delivery double-abort is harmless
  });
  log.info({ channel: CHANNEL }, 'cancel bus: pub/sub enabled');
}

export async function closeCancelBus(): Promise<void> {
  await pub?.quit().catch(() => undefined);
  await sub?.quit().catch(() => undefined);
}

export function registerCancel(conversationId: string, ac: AbortController): void {
  let set = inflight.get(conversationId);
  if (!set) {
    set = new Set();
    inflight.set(conversationId, set);
  }
  set.add(ac);
}

export function unregisterCancel(conversationId: string, ac: AbortController): void {
  const set = inflight.get(conversationId);
  if (!set) return;
  set.delete(ac);
  if (set.size === 0) inflight.delete(conversationId);
}

function abortLocal(conversationId: string): boolean {
  const set = inflight.get(conversationId);
  if (!set || set.size === 0) return false;
  for (const ac of set) ac.abort();
  return true;
}

/**
 * Abort all in-flight generations for a conversation — locally, and (when the
 * bus is up) on every other api replica. Returns true if this instance had
 * one, or another replica acknowledged receipt.
 */
export async function cancelConversation(conversationId: string): Promise<boolean> {
  const local = abortLocal(conversationId);
  if (pub) {
    try {
      // PUBLISH returns receiver count; our own subscriber counts as 1.
      const receivers = await pub.publish(CHANNEL, conversationId);
      return local || receivers > 1;
    } catch {
      return local; // bus down → local-only, same as single-instance mode
    }
  }
  return local;
}

/** Shutdown path: abort every in-flight generation so SSE streams close. */
export function cancelAllConversations(): void {
  for (const set of inflight.values()) {
    for (const ac of set) ac.abort();
  }
}
