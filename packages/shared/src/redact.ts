import type { InferenceEventV1 } from './events.js';

// Pure, table-driven PII redaction. Applied in the WORKER before storage —
// telemetry previews/errors are always redacted; chat `messages` stay raw
// domain data unless REDACT_MESSAGES=true.
// Regex-based by design; NER (e.g. Presidio) is the with-more-time upgrade.

function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

interface RedactRule {
  type: string;
  pattern: RegExp;
  /** Optional post-match check; match is kept (not redacted) when it returns false. */
  validate?: (match: string) => boolean;
}

// Order matters: broader/high-confidence patterns run first so their matches
// are tokenized before narrower ones can partially match the same digits.
const RULES: RedactRule[] = [
  { type: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // API-key-shaped strings (OpenAI/Anthropic-style sk-…, AWS access keys).
  { type: 'api_key', pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g },
  // 13–19 digits with optional space/dash separators, confirmed by Luhn.
  {
    type: 'card',
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    validate: (m) => luhnValid(m.replace(/[ -]/g, '')),
  },
  // Indian mobile: optional +91, 10 digits starting 6–9 (before aadhaar so a
  // +91-prefixed 12-digit sequence is classified as a phone).
  { type: 'phone', pattern: /(?:\+91[ -]?)?\b[6-9]\d{4}[ -]?\d{5}\b/g },
  // Generic international +CC numbers.
  { type: 'phone', pattern: /\+\d{1,3}[ -]?\d{6,14}\b/g },
  // Aadhaar-format: 12 digits, optionally grouped 4-4-4. Digit-run guards
  // keep it from firing inside longer numbers (e.g. Luhn-invalid 16-digit
  // order ids). (No Verhoeff check — accepted false-positive rate; see LLD.)
  { type: 'aadhaar', pattern: /(?<!\d[ -]?)\b\d{4}[ -]?\d{4}[ -]?\d{4}\b(?![ -]?\d)/g },
  {
    type: 'ipv4',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
];

export function redactText(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match) =>
      rule.validate && !rule.validate(match) ? match : `[REDACTED:${rule.type}]`,
    );
  }
  return out;
}

/** Redact everything user-content-bearing in an event before storage. */
export function redactEvent(event: InferenceEventV1): InferenceEventV1 {
  return {
    ...event,
    input_preview: redactText(event.input_preview),
    output_preview: redactText(event.output_preview),
    ...(event.error
      ? { error: { ...event.error, message: redactText(event.error.message) } }
      : {}),
  };
}
