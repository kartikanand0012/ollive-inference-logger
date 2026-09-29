export * from './types.js';
export { AnthropicAdapter } from './anthropic.js';
export { OpenAIAdapter } from './openai.js';
export { MockAnthropicClient, MOCK_MODELS } from './mock.js';

/**
 * Models offered in the UI picker, first entry = default per provider.
 * Cheap models default — the demo (and any reviewer's first click) should not
 * land on the most expensive tier.
 */
export const PROVIDER_MODELS: Record<'anthropic' | 'openai' | 'mock', string[]> = {
  anthropic: ['claude-haiku-4-5', 'claude-opus-5'],
  openai: ['gpt-4o-mini', 'gpt-4o'],
  // Mock provider: free, keyless, zero-network. Always available so the
  // demo works out of the box; real providers take over when keys exist.
  mock: ['mock-chat-1', 'mock-chat-1-fast'],
};
