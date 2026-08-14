// Editable pricing table (USD per million tokens) used for cost estimates in
// dashboards and the requests explorer. Estimates, not billing: unknown models
// yield null so the UI shows "—" instead of a wrong number.
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
};

export function estimateCostUsd(
  model: string,
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined,
): number | null {
  const p = MODEL_PRICING[model];
  if (!p || (promptTokens == null && completionTokens == null)) return null;
  return ((promptTokens ?? 0) * p.inputPerMTok + (completionTokens ?? 0) * p.outputPerMTok) / 1e6;
}
