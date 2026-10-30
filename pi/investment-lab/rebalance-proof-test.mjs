// Focused regressions for the owner rebalancing freeze/reveal proof (offline, synthetic only).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from './decision-proof.mjs';
import { benchmarkEntry, freezeRebalance, revealRebalance, replayFrozenChoice, formatRebalanceProof, scanProofText, t1Files } from './rebalance-proof.mjs';
import { ROBINHOOD_REVIEWED_ALLOWLIST } from './reviewed-allowlist.mjs';
import { FIXTURE_ACCOUNT_NUMBER } from './fixture-mcp-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'rebalance-proof-fixture');
const owner = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'owner-plan.json'), 'utf8'));
const t1s = t1Files().map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
const reseal = record => ({ record, sha256: digest(record) });
const frozen = await freezeRebalance(owner);
let checks = 0;
const check = (...args) => { assert.ok(...args); checks += 1; };

// 1. Lookahead: T0 cannot see T1.
{
  check(!/\bt1\b|t1Files|revealedPrices|readFileSync/.test(freezeRebalance.toString()), 'freezeRebalance references no T1 input or file reads');
  const trapped = { ...owner, future: new Proxy({}, { get() { throw new Error('future_leaked_into_plan'); } }) };
  check((await freezeRebalance(trapped)).sha256 === frozen.sha256, 'extra future data is never read and does not change the freeze');
  check((await freezeRebalance(owner)).sha256 === frozen.sha256, 'T0 freeze is deterministic on the pinned clock');
  // The plan CLI succeeds with every T1 file hidden, and produces the same frozen record.
  const hidden = t1Files().map(file => [file, `${file}.hidden-for-test`]);
  const frozenPath = path.join(here, 'evidence', 'rebalance-frozen.json');
  const committed = fs.existsSync(frozenPath) ? fs.readFileSync(frozenPath, 'utf8') : null;
  for (const [from, to] of hidden) fs.renameSync(from, to);
  try {
    const run = spawnSync(process.execPath, [path.join(here, 'rebalance-proof.mjs'), 'plan'], { cwd: here, encoding: 'utf8' });
    check(run.status === 0, run.stderr);
    check(JSON.parse(fs.readFileSync(frozenPath, 'utf8')).sha256 === frozen.sha256, 'CLI freeze without T1 matches in-process freeze');
    if (committed !== null) check(committed === fs.readFileSync(frozenPath, 'utf8'), 'committed frozen evidence is current, not stale');
  } finally {
    for (const [from, to] of hidden) if (fs.existsSync(to)) fs.renameSync(to, from);
  }
  for (const at of [frozen.record.sourceAt, '2026-09-30T00:00:00.000Z']) {
    await assert.rejects(revealRebalance(frozen, { ...t1s[0], at }), /outcome_must_follow_decision/);
    checks += 1;
  }
}

// 2. Arithmetic: hand-checked ending values, plus an independent recomputation from raw fills.
const outcomes = [];
for (const t1 of t1s) outcomes.push(await revealRebalance(frozen, t1));
{
  const [a, b] = outcomes;
  assert.deepEqual(a.endingValue, { piPaper: 52799.69, doNothing: 51100, benchmark: 54837.07 });
  assert.deepEqual(b.endingValue, { piPaper: 60746.14, doNothing: 63374, benchmark: 57634.88 });
  checks += 2;
  // do nothing in A by hand: 3000 + 40*232.3 + 25*428.4 + 60*279.3 + 120*94.5
  check(3000 + 40 * 232.3 + 25 * 428.4 + 60 * 279.3 + 120 * 94.5 === 51100);
  for (const o of outcomes) {
    let value = frozen.record.choice.afterCash;
    for (const h of frozen.record.choice.afterHoldings) value += h.quantity * o.revealedPrices[h.symbol];
    check(Math.abs(Math.round(value * 100) / 100 - o.endingValue.piPaper) < 0.01, 'PI path equals frozen post-trade holdings at T1');
    check(o.challenge.agrees === true && o.challenge.independentPi === o.endingValue.piPaper && o.challenge.independentBenchmark === o.endingValue.benchmark);
  }
  check(outcomes.every(o => o.decisionHash === frozen.sha256 && o.provenance === 'synthetic-fixture'));
}

// 3. Adverse counterexample present: the rule visibly loses to doing nothing in at least one scenario.
check(outcomes.some(o => o.vsDoNothing < 0), 'no cherry-picking: at least one revealed scenario where rebalancing loses');
check(outcomes.some(o => o.vsDoNothing > 0), 'and at least one where it helps');

// 4. Unsafe targets: refused and frozen as refused; forging it into a proposal is detected by replay.
{
  check(frozen.record.unsafeChoice.status === 'refused' && frozen.record.unsafeChoice.stage === 'plan_validation');
  check(frozen.record.unsafeChoice.problems.some(problem => /target_exceeds_position_cap:NVDA/.test(problem)));
  check(frozen.record.unsafeChoice.problems.some(problem => /impossible_targets_plus_cash_exceed_100pct/.test(problem)));
  const forged = structuredClone(frozen.record);
  forged.unsafeChoice = { status: 'proposed', stage: null, problems: [] };
  await assert.rejects(revealRebalance(reseal(forged), t1s[0]), /decision_rule_inconsistent/);
  checks += 1;
}

// 5. Costs: same model on every path, frozen at T0.
{
  const r = frozen.record;
  check(r.costs.slippageBps === 5 && r.costs.feesPerOrder === 0);
  for (const f of r.choice.fills) {
    const expected = f.referencePrice * (1 + (f.side === 'buy' ? 1 : -1) * r.costs.slippageBps / 10_000);
    check(Math.abs(f.price - expected) < 1e-6, `${f.symbol} fill priced with frozen slippage`);
  }
  check(Math.abs(r.choice.totalCost - 12.65) < 0.01, 'paper rebalance entry cost');
  const before = r.inputs.cash + r.inputs.holdings.reduce((sum, h) => sum + h.quantity * r.inputs.quotes[h.symbol].last, 0);
  check(Math.abs(r.benchmark.entryCost - (before - r.benchmark.shares * r.inputs.quotes[r.benchmark.symbol].last)) < 1e-4 && r.benchmark.entryCost > 0, 'benchmark pays entry costs too');
  const costFree = structuredClone(r);
  costFree.costs.slippageBps = 0;
  await assert.rejects(revealRebalance(reseal(costFree), t1s[0]), /decision_rule_inconsistent/, 'changing the frozen cost model is detected');
  checks += 1;
  // A consistent forgery: claim zero slippage and re-derive the benchmark to match. The fills were priced
  // with 5 bps, so replaying the rule under the claimed cost model must disagree.
  const consistentForgery = structuredClone(r);
  consistentForgery.costs.slippageBps = 0;
  Object.assign(consistentForgery.benchmark, benchmarkEntry({ cash: r.inputs.cash, holdings: r.inputs.holdings, quotes: r.inputs.quotes, symbol: r.benchmark.symbol, slippageBps: 0 }));
  await assert.rejects(revealRebalance(reseal(consistentForgery), t1s[0]), /decision_rule_inconsistent/, 'a cost model edit with a matching benchmark is still detected');
  checks += 1;
  const cheaperBenchmark = structuredClone(r);
  cheaperBenchmark.benchmark.shares += 10;
  await assert.rejects(revealRebalance(reseal(cheaperBenchmark), t1s[0]), /decision_rule_inconsistent/, 'editing the frozen benchmark entry is detected');
  checks += 1;
}

// 6. Save/replay of the frozen choice.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rebalance-proof-'));
  try {
    const file = path.join(tmp, 'frozen.json');
    fs.writeFileSync(file, JSON.stringify(frozen, null, 2));
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    check(await replayFrozenChoice(loaded), 'saved choice replays exactly from frozen inputs');
    check(JSON.stringify(await revealRebalance(loaded, t1s[1])) === JSON.stringify(outcomes[1]), 'saved and in-memory reveals agree');
    const tampered = structuredClone(loaded);
    tampered.record.choice.fills[0].quantity += 1;
    await assert.rejects(revealRebalance(tampered, t1s[0]), /decision_record_changed/);
    const resealed = reseal(tampered.record);
    await assert.rejects(revealRebalance(resealed, t1s[0]), /decision_rule_inconsistent/, 'a re-hashed edited choice no longer matches the rule');
    const quoteEdit = structuredClone(loaded.record);
    quoteEdit.inputs.quotes.NVDA.last = 50;
    await assert.rejects(revealRebalance(reseal(quoteEdit), t1s[0]), /decision_rule_inconsistent/, 'editing frozen inputs breaks replay');
    checks += 3;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  await assert.rejects(revealRebalance(frozen, { ...t1s[0], provenance: 'live-robinhood-mcp' }), /synthetic_data_required/);
  await assert.rejects(revealRebalance(frozen, { ...t1s[0], prices: { ...t1s[0].prices, SCHD: 0 } }), /invalid_t1_price_SCHD/);
  checks += 2;
}

// 7. Owner report: timestamps, labels, refusal, counterexample, live disabled, no identifiers.
{
  const report = formatRebalanceProof(frozen, outcomes, { live: { reason: 'no_reviewed_allowlist', networkAttempts: 0 } });
  for (const pattern of [/Source quotes observed \(T0\) \| 2026-10-01T15:00:00\.000Z/, /Decision frozen \(T0\)/, /Outcome revealed \(T1, A\) \| 2026-10-29/, /SYNTHETIC ONLY · PAPER ONLY/, /LIVE ROBINHOOD ACCESS: DISABLED/, /refused\*\* at plan_validation/, /TRAILED doing nothing/, /not evidence of skill, alpha, or future returns/]) check(pattern.test(report), `report shows ${pattern}`);
  check(scanProofText(report).length === 0 && !report.includes(FIXTURE_ACCOUNT_NUMBER), 'no identifiers or PII patterns');
  check(ROBINHOOD_REVIEWED_ALLOWLIST.length === 0, 'live allowlist still empty');
}

// 8. Fail closed when no T1 outcome is available: never print an empty "proof". Uses a temp copy of the tree.
{
  assert.throws(() => formatRebalanceProof(frozen, []), /no_t1_outcomes/);
  checks += 1;
  const repo = path.resolve(here, '..', '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rebalance-empty-'));
  try {
    fs.cpSync(path.join(repo, 'pi'), path.join(tmp, 'pi'), { recursive: true, filter: src => !src.includes(`investment-lab${path.sep}evidence${path.sep}`) || src.endsWith('rebalance-frozen.json') });
    fs.mkdirSync(path.join(tmp, 'worker', 'src'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'worker/src/execution-trace.mjs'), path.join(tmp, 'worker/src/execution-trace.mjs'));
    fs.copyFileSync(path.join(repo, 'package.json'), path.join(tmp, 'package.json'));
    const copyFixture = path.join(tmp, 'pi/investment-lab/rebalance-proof-fixture');
    for (const f of fs.readdirSync(copyFixture)) if (/^t1-/.test(f)) fs.rmSync(path.join(copyFixture, f));
    const run = spawnSync(process.execPath, [path.join(tmp, 'pi/investment-lab/rebalance-proof.mjs'), 'reveal'], { encoding: 'utf8' });
    check(run.status !== 0 && /no_t1_outcome/.test(run.stderr), `reveal with no T1 files must fail closed (status ${run.status})`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

console.log(`rebalance-proof: ${checks} checks passed; T0 frozen without T1, adverse counterexample shown, replay verified`);
