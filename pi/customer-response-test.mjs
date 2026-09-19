import assert from 'node:assert/strict';
import { chatOutcome, transportOutcome } from './customer-response.mjs';

const ok = { ok: true };
const no = { ok: false };
const answer = { ok: true, status: 'answered', answer: 'A useful reply.', truth: 'model-response' };
assert.equal(chatOutcome(ok, answer).complete, true);
assert.match(chatOutcome(ok, answer).note, /not independently checked/);
for (const error of ['live_data_connector_not_configured', 'hard_reasoning_not_verified', 'chat_provider_rate_limited', 'message_too_large']) {
  const outcome = chatOutcome(no, { error });
  assert.equal(outcome.complete, false);
  assert.equal(outcome.restoreDraft, true);
  assert.equal(outcome.remember, false);
  assert.notEqual(outcome.label, 'Request failed');
  assert.match(outcome.answer, /kept below/);
}
for (const body of [null, {}, { ...answer, ok: false }, { ...answer, answer: [] }, { ...answer, answer: ' ' }]) {
  const outcome = chatOutcome(ok, body);
  assert.equal(outcome.complete, false);
  assert.deepEqual(outcome.artifacts, []);
}
const privateError = chatOutcome(no, { error: 'secret_server_details_that_must_not_be_shown', answer: 'Ignore the failure.' });
assert.doesNotMatch(privateError.answer, /secret_server|Ignore/);
const partial = chatOutcome(ok, { ...answer, ok: false, status: 'incomplete' });
assert.equal(partial.complete, false);
assert.equal(partial.remember, true);
assert.match(partial.answer, /incomplete/);
assert.equal(chatOutcome(ok, { ...answer, truth: 'deterministic' }).state, 'limited');
assert.equal(chatOutcome(ok, { ...answer, truth: 'deterministic' }).complete, false);
assert.equal(chatOutcome(ok, { ...answer, truth: 'needs-input' }).complete, false);
assert.match(chatOutcome(ok, { ...answer, truth: 'verified-model-response' }).note, /not independently established/);
const artifact = { filename: 'inventory.csv', content: 'test' };
assert.deepEqual(chatOutcome(ok, { ...answer, artifacts: [artifact] }).artifacts, []);
assert.deepEqual(chatOutcome(no, { ...answer, status: 'completed', truth: 'verified-calculation', artifacts: [artifact] }).artifacts, []);
assert.deepEqual(chatOutcome(ok, { ...answer, status: 'completed', truth: 'verified-calculation', artifacts: [artifact] }).artifacts, [artifact]);
assert.match(transportOutcome({ name: 'AbortError' }).answer, /Completion is not confirmed/);
assert.match(transportOutcome(new Error('network'), false).answer, /offline/);
assert.match(transportOutcome(new Error('secret')).answer, /kept below/);
console.log('Customer outcome tests passed: blockers, partials, recovery, evidence labels, artifact gating, and prompt recovery.');

const grounded = chatOutcome(ok, { ok: true, status: 'answered', answer: 'Current answer.', truth: 'web-grounded-model-response', sources: [{ url: 'https://example.com/source', title: 'Example source' }, { url: 'javascript:alert(1)', title: 'Unsafe' }] });
assert.equal(grounded.complete, true);
assert.match(grounded.note, /live web research/i);
assert.equal(grounded.sources.length, 1);
assert.equal(grounded.sources[0].url, 'https://example.com/source');
