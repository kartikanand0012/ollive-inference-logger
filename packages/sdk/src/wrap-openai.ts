// Structural wrapper: no dependency on the openai package — anything shaped
// like its client (chat.completions.create) can be instrumented.
import {
  CallRecorder,
  instrumentStream,
  isAbortError,
  previewOfInput,
  wrapMethodPath,
  type StreamExtractor,
} from './instrument.js';
import { getDefaultTransport, type BufferedTransport } from './transport.js';

interface OpenAIParams {
  model?: string;
  stream?: boolean;
  messages?: unknown;
}

const openaiExtractor: StreamExtractor<unknown> = {
  textFromChunk(chunk) {
    const ev = chunk as { choices?: Array<{ delta?: { content?: string | null } }> };
    return ev.choices?.[0]?.delta?.content ?? undefined;
  },
  usageFromChunk(chunk) {
    const ev = chunk as {
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    };
    if (!ev.usage) return undefined;
    return {
      promptTokens: ev.usage.prompt_tokens,
      completionTokens: ev.usage.completion_tokens,
    };
  },
};

function captureFinalCompletion(result: unknown, rec: CallRecorder): void {
  const completion = result as {
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  rec.addUsage({
    promptTokens: completion.usage?.prompt_tokens,
    completionTokens: completion.usage?.completion_tokens,
  });
  const text = completion.choices?.[0]?.message?.content;
  if (text) rec.addText(text);
}

/** Auto-instrument an OpenAI client: intercepts `chat.completions.create`. */
export function wrapOpenAI<T extends object>(
  client: T,
  transport: BufferedTransport = getDefaultTransport(),
): T {
  return wrapMethodPath(client, ['chat', 'completions', 'create'], (original, self) =>
    function wrappedCreate(...args: unknown[]) {
      const params = (args[0] ?? {}) as OpenAIParams;
      const signal = (args[1] as { signal?: AbortSignal } | undefined)?.signal;
      const rec = new CallRecorder(transport, {
        provider: 'openai',
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
            return instrumentStream(result as AsyncIterable<unknown>, rec, openaiExtractor, signal);
          }
          captureFinalCompletion(result, rec);
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
