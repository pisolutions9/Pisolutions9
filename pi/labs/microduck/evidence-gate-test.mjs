import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyMicroduckReport } from './evidence-gate.mjs';

const report = JSON.parse(readFileSync(new URL('./runtime_probe-result.json', import.meta.url)));
const attestation = {
  // Snapshot independently read from GitHub Actions run 40010913525.
  url: 'https://github.com/pisolutions9/Pisolutions9/actions/runs/40010913525',
  conclusion: 'success',
  event: 'pull_request',
  head_sha: 'c3e6d4fe7b1ac1107680f2abb7edafd48620eee5',
};
const copy = value => structuredClone(value);
const cases = [
  ['recorded report', report, attestation, true],
  ['upstream success bit cannot replace observations', { ...report, verification: { passed: true }, independent_observation: {} }, attestation, false],
  ['body port must close', (() => { const x = copy(report); x.faults.body_disconnect.port_closed = false; return x; })(), attestation, false],
  ['malformed policy must fail to load', (() => { const x = copy(report); x.faults.malformed_policy.load_attempt.exit_code = 0; return x; })(), attestation, false],
  ['failed workflow', report, { ...attestation, conclusion: 'failure' }, false],
  ['wrong run commit', report, { ...attestation, head_sha: '0'.repeat(40) }, false],
];
for (const [name, input, run, expected] of cases) {
  const result = verifyMicroduckReport(input, run);
  assert.equal(result.passed, expected, name);
  assert.equal(result.evidence.confidence, expected ? 'verified' : 'unknown', name);
  console.log(JSON.stringify({ case: name, passed: result.passed, failed_checks: Object.entries(result.checks).filter(([, ok]) => !ok).map(([key]) => key) }));
}
