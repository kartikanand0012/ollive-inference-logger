import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AnthropicAdapter, OpenAIAdapter, type ProviderAdapter } from '@ollive/providers';
import { wrapAnthropic, wrapOpenAI } from '@ollive/sdk';
import { env } from './env.js';

// Provider clients are (re)built here — the ONLY place auto-instrumentation
// touches. Keys come from env at boot; the Settings API can override them at
// runtime (in-memory only — we deliberately do NOT persist user keys; a
// production deployment would hold them in a secrets manager / vault).
const adapters = new Map<string, ProviderAdapter>();
type Src = 'env' | 'runtime';
const keySource = new Map<string, Src>();

function build(provider: string, key: string, source: Src): void {
  if (provider === 'anthropic') {
    adapters.set('anthropic', new AnthropicAdapter(wrapAnthropic(new Anthropic({ apiKey: key }))));
  } else if (provider === 'openai') {
    adapters.set('openai', new OpenAIAdapter(wrapOpenAI(new OpenAI({ apiKey: key }))));
  } else return;
  keySource.set(provider, source);
}

if (env.anthropicApiKey) build('anthropic', env.anthropicApiKey, 'env');
if (env.openaiApiKey) build('openai', env.openaiApiKey, 'env');

// When both providers are configured, one is "active" — the default the chat
// picker selects. Users switch it in Settings (activate one at a time).
let active: string | null = null;
function ensureActive() { if (!active || !adapters.has(active)) active = [...adapters.keys()][0] ?? null; }

export function getAdapter(provider: string): ProviderAdapter | undefined {
  return adapters.get(provider);
}
export function getActiveProvider(): string | null { ensureActive(); return active; }
export function setActiveProvider(p: string): boolean {
  if (!adapters.has(p)) return false;
  active = p; return true;
}
export function configuredProviders(): string[] {
  return [...adapters.keys()];
}
/** Set a provider key at runtime; returns true if a valid provider was (re)built. */
export function setProviderKey(provider: string, key: string): boolean {
  if (provider !== 'anthropic' && provider !== 'openai') return false;
  build(provider, key, 'runtime');
  return true;
}
/** Per-provider status for the Settings UI (never returns the key itself). */
export function providerStatus(): Record<string, { configured: boolean; source: Src | null }> {
  const out: Record<string, { configured: boolean; source: Src | null }> = {};
  for (const p of ['anthropic', 'openai']) {
    out[p] = { configured: adapters.has(p), source: keySource.get(p) ?? null };
  }
  return out;
}
