export { wrapAnthropic } from './wrap-anthropic.js';
export { wrapOpenAI } from './wrap-openai.js';
export {
  runWithInferenceContext,
  getInferenceContext,
  type InferenceContext,
} from './context.js';
export { BufferedTransport, getDefaultTransport, type TransportOptions } from './transport.js';
export { SDK_VERSION } from './instrument.js';

import { getDefaultTransport } from './transport.js';

/** Flush buffered events — call from the host app's graceful shutdown. */
export async function flushInferenceEvents(): Promise<void> {
  await getDefaultTransport().shutdown();
}
