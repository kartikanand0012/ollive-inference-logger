import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Correlation IDs the SDK attaches to inference events automatically.
 * Entered once at the request boundary — never threaded through call sites.
 */
export interface InferenceContext {
  conversationId?: string;
  sessionId?: string;
  messageId?: string;
}

const als = new AsyncLocalStorage<InferenceContext>();

export function runWithInferenceContext<T>(ctx: InferenceContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getInferenceContext(): InferenceContext | undefined {
  return als.getStore();
}
