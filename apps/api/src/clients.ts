import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AnthropicAdapter, OpenAIAdapter, type ProviderAdapter } from '@ollive/providers';
import { wrapAnthropic, wrapOpenAI } from '@ollive/sdk';
import { env } from './env.js';

// THE single place where provider clients are constructed — and therefore the
// ONLY place auto-instrumentation touches. wrapAnthropic/wrapOpenAI proxy the
// completion method; every call site below this line is unchanged.
const adapters = new Map<string, ProviderAdapter>();

if (env.anthropicApiKey) {
  adapters.set(
    'anthropic',
    new AnthropicAdapter(wrapAnthropic(new Anthropic({ apiKey: env.anthropicApiKey }))),
  );
}
if (env.openaiApiKey) {
  adapters.set('openai', new OpenAIAdapter(wrapOpenAI(new OpenAI({ apiKey: env.openaiApiKey }))));
}

export function getAdapter(provider: string): ProviderAdapter | undefined {
  return adapters.get(provider);
}

export function configuredProviders(): string[] {
  return [...adapters.keys()];
}
