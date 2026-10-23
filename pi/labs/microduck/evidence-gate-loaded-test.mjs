import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyLoadedMicroduckReport } from './evidence-gate-loaded.mjs';

const raw = readFileSync(new URL('./runtime_probe-result-loaded.json', import.meta.url), 'utf8');
// Workflow metadata was read separately from GitHub's run API.
const run = {
  id: 40014087452,
  html_url: 'https://github.com/pisolutions9/Pisolutions9/actions/runs/40014087452',
  conclusion: 'success',
  event: 'pull_request',
  head_sha: 'd6531484095c4bff7f244166f89f6b5edb33609a',
};
const good = verifyLoadedMicroduckReport(raw, run);
assert.equal(good.passed, true);
assert.equal(good.digest, '1bc96b4f13ac8834a1bbee3999ed14c3fe0dfd7ce7db65aebec4f03ba443ea0f');
assert.equal(good.evidence.confidence, 'verified');
const badRun = verifyLoadedMicroduckReport(raw, { ...run, conclusion: 'failure' });
assert.equal(badRun.passed, false);
assert.equal(badRun.checks.workflow, false);
const modified = JSON.parse(raw);
modified.tick_traces.loaded.intervals_ms[0] = 100;
const altered = verifyLoadedMicroduckReport(JSON.stringify(modified), run);
assert.equal(altered.passed, false);
assert.equal(altered.checks.digest, false);
assert.equal(altered.checks.loaded_trace, false);
assert.equal(altered.evidence.confidence, 'unknown');
console.log(JSON.stringify({
  recorded: good.passed,
  digest: good.digest,
  rejected_failed_run: !badRun.passed,
  rejected_modified_trace: !altered.passed,
  checks: good.checks,
}));
