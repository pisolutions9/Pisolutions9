import assert from 'node:assert/strict';
import { createMission, markFailure, failureFingerprint } from './core.mjs';

const mission = createMission('Execute a real PI task');
const first = markFailure(mission, new Error('provider timeout 503 request 12345'));
assert.equal(first.status, 'retrying');
assert.equal(first.recovery.repeatedFingerprintCount, 1);
assert.equal(first.recovery.requiresStrategyChange, false);

const sameClass = markFailure(first, new Error('provider timeout 503 request 67890'));
assert.equal(sameClass.status, 'blocked');
assert.equal(sameClass.recovery.repeatedFingerprintCount, 2);
assert.equal(sameClass.recovery.requiresStrategyChange, true);
assert.equal(sameClass.recovery.blockReason, 'repeated_failure_requires_strategy_change');

const different = markFailure(first, new Error('network disconnected'));
assert.equal(different.status, 'retrying');
assert.equal(different.recovery.repeatedFingerprintCount, 1);
assert.equal(different.recovery.requiresStrategyChange, false);
assert.equal(failureFingerprint(new Error('timeout 123')), failureFingerprint(new Error('timeout 456')));

console.log(JSON.stringify({ ok: true, duplicateFailureDetected: true, blindSecondRetryPrevented: true, differentFailureCanRetry: true }));
