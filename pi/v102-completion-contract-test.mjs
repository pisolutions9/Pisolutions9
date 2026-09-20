import assert from 'node:assert/strict';
import { createRuntime } from './runtime.mjs';

function safeNetra() {
  return { inspect: () => ({ allowed: true, severity: 'none', findings: [] }) };
}

const runtime = createRuntime({
  netra: safeNetra(),
  execute: async () => {
    const error = new Error('temporary_failure');
    error.code = 'temporary_failure';
    throw error;
  }
});

await runtime.submit('Verify bounded completion semantics', { idempotencyKey: 'v102-completion-contract' });
const unfinished = await runtime.runCycles({ maxCycles: 1 });
assert.equal(unfinished.status, 'incomplete');
assert.equal(unfinished.exhausted, true);
assert.equal(unfinished.nextAction, 'continue_or_escalate');
assert.notEqual(unfinished.status, 'completed');

const completedRuntime = createRuntime({
  netra: safeNetra(),
  execute: async mission => ({
    status: 'completed',
    completed: [{ verified: true, missionId: mission.id, claim: 'goal achieved' }],
    evidence: [{ source: 'completion-contract-test', claim: 'verified completion evidence' }]
  })
});
await completedRuntime.submit('Complete a verified mission', { idempotencyKey: 'v102-completion-success' });
const completed = await completedRuntime.runCycles({ maxCycles: 1 });
assert.equal(completed.status, 'completed');
assert.equal(completed.exhausted, false);

console.log(JSON.stringify({ ok: true, falseCompletionPrevented: true, verifiedCompletionPreserved: true }));
