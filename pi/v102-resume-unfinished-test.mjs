import assert from 'node:assert/strict';
import { createRuntime } from './runtime.mjs';

const stored = [
  { id: 'planned-1', objective: 'continue safe work', status: 'planned', context: {} },
  { id: 'retry-1', objective: 'retry safe work', status: 'retrying', context: {} },
  { id: 'running-1', objective: 'recover interrupted work', status: 'running', context: {} },
  { id: 'blocked-1', objective: 'needs owner secret', status: 'blocked', context: {} },
  { id: 'done-1', objective: 'already done', status: 'completed', context: {} }
];
const state = {
  async save(m) { const i=stored.findIndex(x=>x.id===m.id); if(i>=0) stored[i]=structuredClone(m); else stored.push(structuredClone(m)); return structuredClone(m); },
  async load(id) { return structuredClone(stored.find(x=>x.id===id) || null); },
  async findByIdempotencyKey() { return null; },
  async list() { return structuredClone(stored); },
  async clear() {}
};
const runtime = createRuntime({ state, execute: async mission => ({ status:'completed', completed:[mission.objective], evidence:[{source:'resume-test',claim:'executed'}] }) });
const resumed = await runtime.resumeUnfinished();
assert.equal(resumed.resumed, 3);
assert.deepEqual(new Set(resumed.missionIds), new Set(['planned-1','retry-1','running-1']));
assert.equal(runtime.queue.size(), 3);
const outcome = await runtime.runCycles({ maxCycles: 3 });
assert.equal(outcome.status, 'completed');
assert.equal(runtime.queue.size(), 0);
assert.equal(stored.find(x=>x.id==='blocked-1').status, 'blocked');
assert.equal(stored.find(x=>x.id==='done-1').status, 'completed');
console.log(JSON.stringify({ok:true,resumed:resumed.resumed,blockedOwnerWorkSkipped:true,completedWorkSkipped:true}));
