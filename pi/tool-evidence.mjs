import { evidenceRecord } from './evidence.mjs';

export function normalizeToolEvidence({ tool, result, observedAt = new Date().toISOString(), confidence = 'probable', limitations = [] } = {}) {
  if (!tool) throw new Error('tool_required');
  return evidenceRecord({
    source: `tool:${tool}`,
    claim: JSON.stringify(result ?? null),
    observedAt,
    confidence,
    limitations
  });
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

export function requiresLiveEvidence(text = '') {
  return /\b(today|tonight|current|currently|latest|live|now|right now|this (?:morning|afternoon|evening|week|month|year)|weather|temperature|forecast|price|stock|market|score|standings|news|traffic|open now|available now)\b/i.test(String(text));
}
