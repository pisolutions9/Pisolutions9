import assert from 'node:assert/strict';
import { normalizeToolEvidence, verifyToolEvidence, requiresLiveEvidence } from './tool-evidence.mjs';

const now = Date.parse('2026-09-19T06:30:00.000Z');
const fresh = normalizeToolEvidence({ tool: 'weather', result: { tempF: 80 }, observedAt: '2026-09-19T06:29:30.000Z', confidence: 'verified' });
assert.equal(verifyToolEvidence(fresh, 'weather', { now, maxAgeMs: 60_000, requireFresh: true }).ok, true);

const stale = normalizeToolEvidence({ tool: 'weather', result: { tempF: 79 }, observedAt: '2026-09-19T05:00:00.000Z', confidence: 'verified' });
const staleCheck = verifyToolEvidence(stale, 'weather', { now, maxAgeMs: 60_000, requireFresh: true });
assert.equal(staleCheck.ok, false);
assert.equal(staleCheck.reason, 'stale_evidence');

assert.equal(requiresLiveEvidence("What's the weather today?"), true);
assert.equal(requiresLiveEvidence('Explain opportunity cost.'), false);
console.log('PI live evidence gate passed');
