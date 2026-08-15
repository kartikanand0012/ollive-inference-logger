// Structural wrapper: no dependency on @anthropic-ai/sdk — anything shaped
// like its client (messages.create) can be instrumented.
import {
  CallRecorder,
  instrumentStream,
  isAbortError,
  previewOfInput,
  wrapMethodPath,
  type StreamExtractor,
} from './instrument.js';
import { getDefaultTransport, type BufferedTransport } from './transport.js';

interface AnthropicParams {
  model?: string;
  stream?: boolean;
  messages?: unknown;
}

const anthropicExtractor: StreamExtractor<unknown> = {
  textFromChunk(chunk) {
    const ev = chunk as { type?: string; delta?: { type?: string; text?: string } };
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') return ev.delta.text;
    return undefined;
  },
  usageFromChunk(chunk) {
    const ev = chunk as {
      type?: string;
      message?: { usage?: { input_tokens?: number } };
      usage?: { output_tokens?: number };
    };
    if (ev.type === 'message_start') return { promptTokens: ev.message?.usage?.input_tokens };
    if (ev.type === 'message_delta') return { completionTokens: ev.usage?.output_tokens };
    return undefined;
  },
};

function captureFinalMessage(result: unknown, rec: CallRecorder): void {
  const msg = result as {
    usage?: { input_tokens?: number; output_tokens?: number };
    content?: Array<{ type?: string; text?: string }>;
  };
  rec.addUsage({
    promptTokens: msg.usage?.input_tokens,
    completionTokens: msg.usage?.output_tokens,
  });
  const text = (msg.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  if (text) rec.addText(text);
}

/**
 * Auto-instrument an Anthropic client: intercepts `messages.create` (stream
 * and non-stream) via Proxy. Call sites change in exactly one place — client
 * construction. The SDK never throws or blocks the request path.
 */
export function wrapAnthropic<T extends object>(
  client: T,
  transport: BufferedTransport = getDefaultTransport(),
): T {
  return wrapMethodPath(client, ['messages', 'create'], (original, self) =>
    function wrappedCreate(...args: unknown[]) {
      const params = (args[0] ?? {}) as AnthropicParams;
      const signal = (args[1] as { signal?: AbortSignal } | undefined)?.signal;
      const rec = new CallRecorder(transport, {
        provider: 'anthropic',
        model: String(params.model ?? 'unknown'),
        isStream: Boolean(params.stream),
        inputPreview: previewOfInput(params),
      });
      return (async () => {
        try {
          const result = (await (original as (...a: unknown[]) => unknown).apply(
            self,
            args,
          )) as unknown;
          if (params.stream) {
            return instrumentStream(
              result as AsyncIterable<unknown>,
              rec,
              anthropicExtractor,
              signal,
            );
          }
          captureFinalMessage(result, rec);
          rec.finish('success');
          return result;
        } catch (err) {
          rec.finish(isAbortError(err) ? 'cancelled' : 'error', err);
          throw err;
        }
      })();
    },
  );
}
