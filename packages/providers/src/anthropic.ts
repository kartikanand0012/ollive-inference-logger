import type Anthropic from '@anthropic-ai/sdk';
import type { AdapterEvent, ChatMessage, ProviderAdapter, StreamChatOptions } from './types.js';

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = 'anthropic' as const;

  // The client is constructed (and, from Phase 2 on, wrapped by @ollive/sdk)
  // by the caller — the adapter never builds its own.
  constructor(private readonly client: Anthropic) {}

  async *streamChat(opts: StreamChatOptions): AsyncGenerator<AdapterEvent, void, undefined> {
    const system = opts.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const messages = opts.messages
      .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    // Extended thinking is ON by default on newer Claude models (e.g.
    // claude-opus-5). In streaming that emits a `thinking` content block FIRST,
    // which spends `max_tokens` before any text is produced — a non-trivial
    // prompt can exhaust the budget mid-thought and stream zero visible text
    // ("no response"). A chatbot wants a direct answer, so thinking is disabled:
    // uniform behavior across models, lower latency, and — since the dashboards
    // are the product — clean completion-token accounting (no thinking tokens
    // inflating cost/latency). Accepted by all current Claude models.
    // stream:true on messages.create (not the .stream() helper) so the SDK
    // proxy has a single interception point for both modes.
    const stream = await this.client.messages.create(
      {
        model: opts.model,
        max_tokens: opts.maxTokens,
        stream: true,
        thinking: { type: 'disabled' },
        ...(system ? { system } : {}),
        messages,
      },
      { signal: opts.signal },
    );

    for await (const event of stream) {
      if (event.type === 'message_start') {
        yield { type: 'usage', promptTokens: event.message.usage.input_tokens };
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'delta', text: event.delta.text };
      } else if (event.type === 'message_delta') {
        yield { type: 'usage', completionTokens: event.usage.output_tokens };
      }
    }
  }
}
