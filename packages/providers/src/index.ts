export * from './types.js';
export { AnthropicAdapter } from './anthropic.js';
export { OpenAIAdapter } from './openai.js';

/**
 * Models offered in the UI picker, first entry = default per provider.
 * Cheap models default — the demo (and any reviewer's first click) should not
 * land on the most expensive tier.
 */
export const PROVIDER_MODELS: Record<'anthropic' | 'openai', string[]> = {
  anthropic: ['claude-haiku-4-5', 'claude-opus-5'],
  openai: ['gpt-4o-mini', 'gpt-4o'],
};
