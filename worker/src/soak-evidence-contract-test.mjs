import { stageDurationMs } from './index.js';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const worker=readFileSync(new URL('./index.js',import.meta.url),'utf8');
const workflow=readFileSync(new URL('../../.github/workflows/pi-v1-tests.yml',import.meta.url),'utf8');
for(const stage of ['pi_route','pi_edge','pi_verify','pi_provider','pi_chat'])assert.ok(worker.includes(stage),`Worker timing stage ${stage} missing`);
assert.match(worker,/event:'pi_chat_boundary'[^\n]+providerMs:providerMs\?\?null/);
for(const metric of ['%{time_connect}','%{time_appconnect}','%{time_starttransfer}','%{time_total}','%header{x-pi-request-id}','%header{server-timing}'])assert.ok(workflow.includes(metric),`soak metric ${metric} missing`);
assert.match(workflow,/zero_byte_failures/);
assert.match(workflow,/ready_rate < 0\.80/);
assert.doesNotMatch(workflow,/body_prefix|['"]prefix['"]\s*:/,'soak evidence must not persist model output');
assert.doesNotMatch(workflow,/prompt_prefix|history_prefix|credential_value/);
console.log('Provider-free PI soak diagnostics contract passed.');

const behavioral=spawnSync('python',[fileURLToPath(new URL('./soak-evidence-behavior-test.py',import.meta.url))],{encoding:'utf8'});
assert.equal(behavioral.status,0,behavioral.stdout+'\n'+behavioral.stderr);
console.log(behavioral.stdout.trim());

for(const stage of ['edge','provider','verify']){
  assert.equal(stageDurationMs({},stage,100),undefined);
  assert.equal(stageDurationMs({[`${stage}Ms`]:20},stage,100),20);
  assert.equal(stageDurationMs({[`${stage}StartedAt`]:0},stage,100),100);
  assert.equal(stageDurationMs({[`${stage}Ms`]:20,[`${stage}StartedAt`]:50},stage,100),70);
  assert.equal(stageDurationMs({[`${stage}Ms`]:20,[`${stage}StartedAt`]:150},stage,100),20);
}
console.log('Completed and active timing attempts passed.');
