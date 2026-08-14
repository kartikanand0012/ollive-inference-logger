import type { Provider } from '@ollive/shared';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Normalized streaming events every adapter emits. */
export type AdapterEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number };

export interface StreamChatOptions {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  readonly provider: Provider;
  streamChat(opts: StreamChatOptions): AsyncGenerator<AdapterEvent, void, undefined>;
}
