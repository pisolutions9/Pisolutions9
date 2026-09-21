import { evidenceRecord } from './evidence.mjs';

export const FRESHNESS_POLICY = Object.freeze({
  weather: { maxAgeMs: 5 * 60_000, fallbackMaxAgeMs: 15 * 60_000 },
  markets: { maxAgeMs: 2 * 60_000, fallbackMaxAgeMs: 10 * 60_000 },
  sports: { maxAgeMs: 2 * 60_000, fallbackMaxAgeMs: 10 * 60_000 },
  outages: { maxAgeMs: 5 * 60_000, fallbackMaxAgeMs: 15 * 60_000 },
  transport: { maxAgeMs: 5 * 60_000, fallbackMaxAgeMs: 15 * 60_000 },
  news: { maxAgeMs: 15 * 60_000, fallbackMaxAgeMs: 60 * 60_000 },
  geopolitics: { maxAgeMs: 30 * 60_000, fallbackMaxAgeMs: 2 * 60 * 60_000 },
  immigration: { maxAgeMs: 6 * 60 * 60_000, fallbackMaxAgeMs: 24 * 60 * 60_000 },
  tariffs: { maxAgeMs: 6 * 60 * 60_000, fallbackMaxAgeMs: 24 * 60 * 60_000 },
  energy: { maxAgeMs: 30 * 60_000, fallbackMaxAgeMs: 2 * 60 * 60_000 },
  space: { maxAgeMs: 30 * 60_000, fallbackMaxAgeMs: 2 * 60 * 60_000 },
  default: { maxAgeMs: 60 * 60_000, fallbackMaxAgeMs: 6 * 60 * 60_000 }
});

export function freshnessPolicy(domain = 'default', { fallback = false } = {}) {
  const policy = FRESHNESS_POLICY[domain] || FRESHNESS_POLICY.default;
  return { domain: FRESHNESS_POLICY[domain] ? domain : 'default', maxAgeMs: fallback ? policy.fallbackMaxAgeMs : policy.maxAgeMs, fallback };
}

export function normalizeToolEvidence({ tool, result, observedAt = new Date().toISOString(), confidence = 'probable', limitations = [] } = {}) {
  if (!tool) throw new Error('tool_required');
  return evidenceRecord({ source: `tool:${tool}`, claim: JSON.stringify(result ?? null), observedAt, confidence, limitations });
}

export function verifyToolEvidence(record, expectedTool, { now = Date.now(), maxAgeMs = null, requireFresh = false } = {}) {
  const validConfidence = ['verified','probable','speculative','unknown'].includes(record?.confidence);
  const validSource = record?.source === `tool:${expectedTool}`;
  const observedMs = Date.parse(record?.observedAt || '');
  const hasTimestamp = Number.isFinite(observedMs);
  const ageMs = hasTimestamp ? Math.max(0, now - observedMs) : null;
  const fresh = !requireFresh || (hasTimestamp && Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && ageMs <= maxAgeMs);
  const ok = validConfidence && validSource && (!requireFresh || fresh);
  let reason = null;
  if (!validSource) reason = 'evidence_source_mismatch';
  else if (!validConfidence) reason = 'invalid_confidence';
  else if (requireFresh && !hasTimestamp) reason = 'evidence_timestamp_required';
  else if (requireFresh && !Number.isFinite(maxAgeMs)) reason = 'freshness_window_required';
  else if (requireFresh && !fresh) reason = 'stale_evidence';
  return { ok, reason, observedAt: record?.observedAt || null, ageMs, fresh };
}

export function verifyDomainFreshness(record, expectedTool, domain, options = {}) {
  const policy = freshnessPolicy(domain, { fallback: Boolean(options.fallback) });
  return { ...verifyToolEvidence(record, expectedTool, { now: options.now ?? Date.now(), maxAgeMs: policy.maxAgeMs, requireFresh: true }), policy };
}

export function requiresLiveEvidence(text = '') {
  return /\b(today|tonight|current|currently|latest|live|now|right now|this (?:morning|afternoon|evening|week|month|year)|weather|temperature|forecast|price|stock|market|score|standings|news|traffic|open now|available now|uscis|sevis|f-1|j-1|h-1b|opt|stem opt|cpt|visa stamping|travel ban|tariff|outage|flight status)\b/i.test(String(text));
}
