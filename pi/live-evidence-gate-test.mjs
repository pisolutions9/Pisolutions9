import assert from 'node:assert/strict';
import { normalizeToolEvidence, verifyToolEvidence, verifyDomainFreshness, freshnessPolicy, requiresLiveEvidence } from './tool-evidence.mjs';

const now = Date.parse('2026-09-19T06:30:00.000Z');
const fresh = normalizeToolEvidence({ tool: 'weather', result: { tempF: 80 }, observedAt: '2026-09-19T06:29:30.000Z', confidence: 'verified' });
assert.equal(verifyToolEvidence(fresh, 'weather', { now, maxAgeMs: 60_000, requireFresh: true }).ok, true);
assert.equal(verifyDomainFreshness(fresh, 'weather', 'weather', { now }).ok, true);

const stale = normalizeToolEvidence({ tool: 'weather', result: { tempF: 79 }, observedAt: '2026-09-19T05:00:00.000Z', confidence: 'verified' });
const staleCheck = verifyToolEvidence(stale, 'weather', { now, maxAgeMs: 60_000, requireFresh: true });
assert.equal(staleCheck.ok, false);
assert.equal(staleCheck.reason, 'stale_evidence');
assert.equal(verifyDomainFreshness(stale, 'weather', 'weather', { now }).reason, 'stale_evidence');
assert.ok(freshnessPolicy('weather').maxAgeMs < freshnessPolicy('immigration').maxAgeMs);
assert.ok(freshnessPolicy('weather', { fallback: true }).maxAgeMs > freshnessPolicy('weather').maxAgeMs);

const missingTimestamp = { ...fresh, observedAt: null };
assert.equal(verifyDomainFreshness(missingTimestamp, 'weather', 'weather', { now }).reason, 'evidence_timestamp_required');
assert.equal(requiresLiveEvidence("What's the weather today?"), true);
assert.equal(requiresLiveEvidence('What is the latest USCIS STEM OPT guidance?'), true);
assert.equal(requiresLiveEvidence('Has SEVIS policy changed?'), true);
assert.equal(requiresLiveEvidence('Explain opportunity cost.'), false);
console.log('PI live evidence gate passed');
