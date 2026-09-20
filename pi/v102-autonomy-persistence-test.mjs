import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/pi-team-24x7.yml', import.meta.url), 'utf8');

assert.match(workflow, /PI_STATE_FILE_PATH:\s*['"]?\.pi\/state\.json['"]?/);
assert.match(workflow, /actions\/cache\/restore@v4/);
assert.match(workflow, /actions\/cache\/save@v4/);
assert.match(workflow, /if:\s*always\(\)/);
assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
assert.doesNotMatch(workflow, /contents:\s*write/);

const restoreIndex = workflow.indexOf('Restore durable PI mission state');
const verifyIndex = workflow.indexOf('Verify PI before autonomous cycle');
const runIndex = workflow.indexOf('Run bounded PI Team cycle loop');
const saveIndex = workflow.indexOf('Persist PI mission state');
assert.ok(restoreIndex >= 0 && restoreIndex < verifyIndex);
assert.ok(verifyIndex < runIndex && runIndex < saveIndex);

console.log(JSON.stringify({
  ok: true,
  durableStateConfigured: true,
  saveOnFailureConfigured: true,
  repositoryWritePrivilegeDenied: true
}));
