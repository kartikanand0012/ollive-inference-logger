import type OpenAI from 'openai';
import type { AdapterEvent, ProviderAdapter, StreamChatOptions } from './types.js';

export class OpenAIAdapter implements ProviderAdapter {
  readonly provider = 'openai' as const;

  constructor(private readonly client: OpenAI) {}

  async *streamChat(opts: StreamChatOptions): AsyncGenerator<AdapterEvent, void, undefined> {
    const stream = await this.client.chat.completions.create(
      {
        model: opts.model,
        max_completion_tokens: opts.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        messages: opts.messages,
      },
      { signal: opts.signal },
    );

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield { type: 'delta', text: delta };
      if (chunk.usage) {
        yield {
          type: 'usage',
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
        };
      }
    }
  }
}
