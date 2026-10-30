import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freezeDecision, revealOutcome, formatOwnerProof } from './decision-proof.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const t0 = JSON.parse(fs.readFileSync(path.join(here, 'decision-proof-fixture', 't0.json'), 'utf8'));
const t1Path = path.join(here, 'decision-proof-fixture', 't1.json');
const t1 = JSON.parse(fs.readFileSync(t1Path, 'utf8'));
const frozen = freezeDecision(t0);
assert.equal(frozen.record.decision, 'hold_cash');
assert.equal(frozen.record.reason, 'exceeds_owner_concentration_limit');
assert.equal(frozen.record.proposedWeightPercent, 30);
assert.equal(frozen.record.challenge.independentlyComputedWeightPercent, 30);

// This extra future value is deliberately unreadable. Planning must not access it.
const withTrap = { ...t0, future: new Proxy({}, { get() { throw new Error('future_leaked_into_plan'); } }) };
assert.equal(freezeDecision(withTrap).sha256, frozen.sha256);

// Stage 1 succeeds even while its entire T1 fixture is unavailable on disk.
const hidden = t1Path + '.hidden-for-test';
fs.renameSync(t1Path, hidden);
try {
  const result = spawnSync(process.execPath, [path.join(here, 'decision-proof.mjs'), 'plan'], { cwd: here, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(here, 'evidence', 'decision-frozen.json'), 'utf8')).sha256, frozen.sha256);
} finally { fs.renameSync(hidden, t1Path); }

const result = revealOutcome(frozen, t1);
assert.deepEqual(result.endingValue, { pi: 1000, noAction: 1000, benchmark: 1016.96, rejectedCandidate: 907.75 });
assert.equal(result.challenge.independentCandidate, 907.75);
assert.equal(result.challenge.independentBenchmark, 1016.96);
assert.equal(result.challenge.agrees, true);
assert.match(formatOwnerProof(frozen, result), /One synthetic case cannot establish an investment edge/);
const upside = revealOutcome(frozen, { ...t1, prices: { ...t1.prices, FOCUS: 13 } });
assert.ok(upside.endingValue.rejectedCandidate > upside.endingValue.pi);

const tampered = structuredClone(frozen);
tampered.record.candidate.price = 1;
assert.throws(() => revealOutcome(tampered, t1), /decision_record_changed/);
assert.throws(() => revealOutcome(frozen, { ...t1, at: t0.at }), /outcome_must_follow_decision/);
assert.throws(() => freezeDecision({ ...t0, provenance: 'live-robinhood-mcp' }), /synthetic_t0_required/);
const forged = structuredClone(frozen);
forged.record.decision = 'paper_buy_candidate';
forged.sha256 = crypto.createHash('sha256').update(JSON.stringify(forged.record)).digest('hex');
assert.throws(() => revealOutcome(forged, t1), /decision_rule_inconsistent/);
console.log('decision-proof: 17 checks passed; T0 planned without T1, outcome challenged independently');
