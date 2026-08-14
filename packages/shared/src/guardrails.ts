// Heuristic prompt-injection detection (OWASP LLM01). Pattern-based by design:
// cheap enough to run inline on every event, no extra model call, explainable
// (each hit names its pattern). This is detection-grade, not prevention-grade
// — a classifier model (the README roadmap item) is the production upgrade.
// Applied in TWO places: the chat API (log + optional block via
// GUARDRAILS_BLOCK) and the worker (derives the flagged_injection column so
// injection attempts are queryable telemetry — runtime-governance style).

export interface InjectionVerdict {
  flagged: boolean;
  patterns: string[];
}

const RULES: Array<{ name: string; re: RegExp }> = [
  // "ignore all previous instructions", "disregard the above rules"
  {
    name: 'override_instructions',
    re: /\b(ignore|disregard|forget|bypass|override)\b.{0,40}\b(previous|prior|above|earlier|all|any|system)\b.{0,40}\b(instructions?|prompts?|rules?|guidelines?|constraints?)\b/is,
  },
  // attempts to extract the hidden/system prompt
  {
    name: 'system_prompt_extraction',
    re: /\b(reveal|show|print|repeat|output|display|tell me)\b.{0,50}\b(system prompt|hidden (?:prompt|instructions)|initial (?:prompt|instructions)|your (?:instructions|rules|guidelines))\b/is,
  },
  // persona hijack / jailbreak personas
  {
    name: 'role_hijack',
    re: /\b(you are now|pretend (?:to be|you are)|act as if|roleplay as)\b.{0,60}\b(unrestricted|unfiltered|no (?:rules|limits|restrictions)|jailbroken|evil|DAN)\b/is,
  },
  { name: 'jailbreak_marker', re: /\b(DAN mode|developer mode|jailbreak|do anything now)\b/i },
  // instructions to exfiltrate data to an attacker-controlled sink
  {
    name: 'exfiltration',
    re: /\b(send|post|upload|forward|transmit|exfiltrate)\b.{0,60}\b(https?:\/\/|webhook|api[ _-]?keys?|credentials|passwords?|secrets?|env(?:ironment)? var)/is,
  },
  // smuggling payloads through encodings
  {
    name: 'encoded_payload',
    re: /\b(decode|execute|run)\b.{0,30}\b(base64|hex|rot13)\b|(?:[A-Za-z0-9+/]{40,}={1,2})/s,
  },
  // markdown image/link beacons used for data exfil in LLM outputs
  { name: 'markdown_beacon', re: /!\[[^\]]*\]\(https?:\/\/[^)]*(\?|&)(q|data|payload|secret)=/i },
];

export function detectPromptInjection(text: string): InjectionVerdict {
  const patterns: string[] = [];
  // Bound work on pathological inputs; previews are ≤500 chars anyway.
  const sample = text.length > 4000 ? text.slice(0, 4000) : text;
  for (const rule of RULES) {
    if (rule.re.test(sample)) patterns.push(rule.name);
  }
  return { flagged: patterns.length > 0, patterns };
}
