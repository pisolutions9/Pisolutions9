#!/usr/bin/env node
// PI Investment Lab — freeze/reveal proof for the owner's target rebalancing (SYNTHETIC, paper only).
//   node pi/investment-lab/rebalance-proof.mjs plan     T0: inspect synthetic fixture on a pinned clock, apply the
//                                                       owner's plan, freeze choice + benchmark + costs. Never reads T1.
//   node pi/investment-lab/rebalance-proof.mjs reveal   T1: verify the frozen record, replay the rule from frozen
//                                                       inputs, reveal each synthetic T1 file, compare paths.
// Reuses: proposeRebalance (rebalance.mjs), portfolioSnapshot (quant.mjs), digest (decision-proof.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './decision-proof.mjs';
import { runFixtureDemo, runLive, scanForLeaks } from './demo.mjs';
import { proposeRebalance } from './rebalance.mjs';
import { portfolioSnapshot } from './quant.mjs';
import { FIXTURE_ACCOUNT_NUMBER } from './fixture-mcp-server.mjs';

const r6 = n => Number(n.toFixed(6));
const cents = n => Math.round(n * 100) / 100;
const usd = n => `${n < 0 ? '-' : ''}$${Math.abs(cents(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = n => `${(n * 100).toFixed(2)}%`;
const positive = (n, label) => { if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid_${label}`); return n; };

// Predeclared benchmark entry at T0: sell every other holding at bid less slippage, buy the benchmark at ask
// plus slippage (fractional), using the same cost model as the paper broker. Frozen with the decision.
export function benchmarkEntry({ cash, holdings, quotes, symbol, slippageBps }) {
  const slip = slippageBps / 10_000;
  const proceeds = holdings.filter(h => h.symbol !== symbol).reduce((sum, h) => sum + h.quantity * (quotes[h.symbol].bid ?? quotes[h.symbol].last) * (1 - slip), 0);
  const kept = holdings.find(h => h.symbol === symbol)?.quantity ?? 0;
  const bought = (cash + proceeds) / ((quotes[symbol].ask ?? quotes[symbol].last) * (1 + slip));
  const before = cash + holdings.reduce((sum, h) => sum + h.quantity * quotes[h.symbol].last, 0);
  const shares = r6(kept + bought);
  return { symbol, shares, cashLeft: 0, entryCost: r6(before - shares * quotes[symbol].last) };
}

function datasetFromInputs(inputs) {
  const positions = inputs.holdings.map(h => ({ ...h }));
  const quotes = Object.fromEntries(Object.entries(inputs.quotes).map(([symbol, q]) => [symbol, { symbol, ...q }]));
  return {
    dataset: { account: { accountRef: 'acct_ref_1', cash: inputs.cash, marginEnabled: inputs.marginEnabled, type: 'synthetic' }, positions, quotes, series: {}, sources: {} },
    quant: { snapshot: portfolioSnapshot({ positions, quotes, cash: inputs.cash }), perSymbol: {}, portfolioRisk: { ok: false, reason: 'not_used_by_rebalance' } }
  };
}

const summarizeChoice = proposal => ({
  status: proposal.status,
  stage: proposal.stage ?? null,
  problems: proposal.problems ?? [],
  orders: proposal.orders.map(o => ({ side: o.side, symbol: o.symbol, quantity: o.quantity })),
  fills: proposal.fills.map(f => ({ side: f.side, symbol: f.symbol, quantity: f.quantity, referencePrice: f.referencePrice, price: f.price, notional: f.notional })),
  afterCash: proposal.after?.cash ?? null,
  afterHoldings: null, // filled from the fills by freezeRebalance
  totalCost: proposal.costs?.total ?? 0
});

// T0 only. Its inputs are the owner file and the synthetic fixture at the owner's T0 clock; T1 is not a parameter.
export async function freezeRebalance(ownerInput) {
  if (ownerInput?.provenance !== 'synthetic-fixture') throw new Error('synthetic_owner_input_required');
  const t0 = Date.parse(ownerInput.t0);
  if (!Number.isFinite(t0)) throw new Error('invalid_t0_time');
  const clock = () => t0;
  const { result } = await runFixtureDemo({ now: clock });
  const dataset = result.research.data;
  const quant = result.quant.data;
  const symbol = String(ownerInput.benchmark?.symbol || '');
  if (!dataset.quotes[symbol]) throw new Error('benchmark_not_quoted_at_t0');
  const proposal = await proposeRebalance({ dataset, quant, plan: ownerInput.plan, now: clock });
  const unsafe = await proposeRebalance({ dataset, quant, plan: ownerInput.unsafePlan, now: clock });
  const inputs = {
    cash: dataset.account.cash,
    marginEnabled: dataset.account.marginEnabled,
    holdings: dataset.positions.map(p => ({ symbol: p.symbol, quantity: p.quantity, averageCost: p.averageCost })),
    quotes: Object.fromEntries(Object.entries(dataset.quotes).map(([s, q]) => [s, { last: q.last, bid: q.bid, ask: q.ask, updatedAt: q.updatedAt }]))
  };
  const slippageBps = proposal.plan?.slippageBps ?? 5;
  const choice = summarizeChoice(proposal);
  if (choice.status === 'proposed') {
    const held = new Map(inputs.holdings.map(h => [h.symbol, h.quantity]));
    for (const f of choice.fills) held.set(f.symbol, (held.get(f.symbol) || 0) + (f.side === 'buy' ? f.quantity : -f.quantity));
    choice.afterHoldings = [...held].filter(([, q]) => q > 0).map(([s, q]) => ({ symbol: s, quantity: q }));
  }
  const record = {
    schema: 'pi.investment-lab.rebalance-proof.v1',
    provenance: 'synthetic-fixture',
    sourceAt: dataset.sources.quotes.observedAt,
    decidedAt: new Date(clock()).toISOString(),
    ownerPlan: ownerInput.plan,
    unsafePlan: ownerInput.unsafePlan,
    benchmark: { ...benchmarkEntry({ cash: inputs.cash, holdings: inputs.holdings, quotes: inputs.quotes, symbol, slippageBps }), description: ownerInput.benchmark.description || null },
    costs: { slippageBps, feesPerOrder: 0, basis: 'entry costs at T0 for every path; all paths marked at T1 last price, no exit costs' },
    inputs,
    rows: proposal.rows ? proposal.rows.map(row => ({ symbol: row.symbol, current: row.current, target: row.target, postTrade: row.postTrade })) : [],
    cashBefore: proposal.doNothing.cashWeight,
    cashAfter: proposal.after?.cashWeight ?? null,
    choice,
    unsafeChoice: { status: unsafe.status, stage: unsafe.stage ?? null, problems: unsafe.problems ?? [] },
    thesis: 'Owner-set target weights and cash floor applied at current quotes; not a price forecast.'
  };
  return { record, sha256: digest(record) };
}

// Re-run the owner's rule from the frozen inputs alone; the frozen choice must be exactly what the rule produces.
export async function replayFrozenChoice(frozen) {
  const r = frozen.record;
  const { dataset, quant } = datasetFromInputs(r.inputs);
  const clock = () => Date.parse(r.sourceAt);
  // The frozen cost model is part of the rule: replay with it, not with defaults.
  const withCosts = plan => ({ ...plan, slippageBps: r.costs.slippageBps });
  const again = summarizeChoice(await proposeRebalance({ dataset, quant, plan: withCosts(r.ownerPlan), now: clock }));
  const unsafe = await proposeRebalance({ dataset, quant, plan: withCosts(r.unsafePlan), now: clock });
  const bench = benchmarkEntry({ cash: r.inputs.cash, holdings: r.inputs.holdings, quotes: r.inputs.quotes, symbol: r.benchmark.symbol, slippageBps: r.costs.slippageBps });
  const comparable = c => JSON.stringify({ status: c.status, orders: c.orders, fills: c.fills, afterCash: c.afterCash, totalCost: c.totalCost });
  return comparable(again) === comparable(r.choice)
    && unsafe.status === r.unsafeChoice.status && JSON.stringify(unsafe.problems ?? []) === JSON.stringify(r.unsafeChoice.problems)
    && bench.shares === r.benchmark.shares && bench.entryCost === r.benchmark.entryCost;
}

export async function revealRebalance(frozen, t1) {
  if (digest(frozen?.record) !== frozen?.sha256) throw new Error('decision_record_changed');
  const r = frozen.record;
  if (r.provenance !== 'synthetic-fixture' || t1?.provenance !== 'synthetic-fixture') throw new Error('synthetic_data_required');
  const outcomeAt = Date.parse(t1.at);
  if (!(outcomeAt > Date.parse(r.sourceAt) && outcomeAt > Date.parse(r.decidedAt))) throw new Error('outcome_must_follow_decision');
  if (!(await replayFrozenChoice(frozen))) throw new Error('decision_rule_inconsistent');
  const symbols = new Set([...r.inputs.holdings.map(h => h.symbol), ...(r.choice.afterHoldings || []).map(h => h.symbol), r.benchmark.symbol]);
  const prices = {};
  for (const s of symbols) prices[s] = positive(t1.prices?.[s], `t1_price_${s}`);
  const value = (cash, holdings) => cash + holdings.reduce((sum, h) => sum + h.quantity * prices[h.symbol], 0);
  const doNothing = value(r.inputs.cash, r.inputs.holdings);
  const piPaper = r.choice.status === 'proposed' ? value(r.choice.afterCash, r.choice.afterHoldings) : doNothing;
  const benchmark = r.benchmark.shares * prices[r.benchmark.symbol] + r.benchmark.cashLeft;
  // Independent challenge: rebuild the PI path from the raw fills, and the benchmark from raw quotes.
  let cash = r.inputs.cash;
  const held = {};
  for (const h of r.inputs.holdings) held[h.symbol] = h.quantity;
  if (r.choice.status === 'proposed') for (const f of r.choice.fills) { cash += f.side === 'sell' ? f.notional : -f.notional; held[f.symbol] = (held[f.symbol] || 0) + (f.side === 'buy' ? f.quantity : -f.quantity); }
  let independentPi = cash;
  for (const s of Object.keys(held)) independentPi += held[s] * prices[s];
  const slip = r.costs.slippageBps / 10_000;
  let pot = r.inputs.cash;
  let benchShares = 0;
  for (const h of r.inputs.holdings) {
    if (h.symbol === r.benchmark.symbol) benchShares += h.quantity;
    else pot += h.quantity * (r.inputs.quotes[h.symbol].bid ?? r.inputs.quotes[h.symbol].last) * (1 - slip);
  }
  benchShares += pot / ((r.inputs.quotes[r.benchmark.symbol].ask ?? r.inputs.quotes[r.benchmark.symbol].last) * (1 + slip));
  const independentBenchmark = r6(benchShares) * prices[r.benchmark.symbol];
  if (Math.abs(independentPi - piPaper) > 1e-4 || Math.abs(independentBenchmark - benchmark) > 1e-4) throw new Error('independent_outcome_check_failed');
  return {
    schema: 'pi.investment-lab.rebalance-outcome.v1',
    provenance: 'synthetic-fixture',
    decisionHash: frozen.sha256,
    label: String(t1.label || ''),
    at: t1.at,
    revealedPrices: prices,
    endingValue: { piPaper: cents(piPaper), doNothing: cents(doNothing), benchmark: cents(benchmark) },
    vsDoNothing: cents(piPaper - doNothing),
    vsBenchmark: cents(piPaper - benchmark),
    challenge: { independentPi: cents(independentPi), independentBenchmark: cents(independentBenchmark), agrees: true },
    limitation: 'One invented scenario shows mechanics and discipline, not skill, alpha, or a forecast.'
  };
}

const bar = (w, scale = 0.35, width = 24) => '█'.repeat(Math.max(0, Math.round(Math.min(w, scale) / scale * width))).padEnd(width, '·');
const signedBar = (delta, scale, width = 14) => {
  const n = scale > 0 ? Math.round(Math.min(Math.abs(delta), scale) / scale * width) : 0;
  return delta < 0 ? `${'▓'.repeat(n).padStart(width, ' ')}|${' '.repeat(width)}` : `${' '.repeat(width)}|${'▓'.repeat(n).padEnd(width, ' ')}`;
};

export function formatRebalanceProof(frozen, outcomes, { live = null } = {}) {
  if (!Array.isArray(outcomes) || !outcomes.length) throw new Error('no_t1_outcomes'); // never render an empty proof
  const r = frozen.record;
  const c = r.choice;
  const lines = [
    '# PI Investment Lab — owner rebalancing proof (freeze → reveal)',
    '',
    live ? `LIVE ROBINHOOD ACCESS: DISABLED — live entry point refused with "${live.reason}" (network attempts: ${live.networkAttempts}).` : 'LIVE ROBINHOOD ACCESS: DISABLED.',
    '**SYNTHETIC ONLY · PAPER ONLY · OWNER-SET TARGETS · NOT A FORECAST · NOT ADVICE**',
    '',
    '| Timestamp | Value (synthetic clock) |',
    '|---|---|',
    `| Source quotes observed (T0) | ${r.sourceAt} |`,
    `| Decision frozen (T0) | ${r.decidedAt} · SHA-256 \`${frozen.sha256}\` |`,
    ...outcomes.map(o => `| Outcome revealed (T1, ${o.label.split(':')[0]}) | ${o.at} |`),
    '',
    '## 1. Current vs owner target vs paper result',
    '```',
    `${'Symbol'.padEnd(6)}  ${'current'.padEnd(33)}  ${'target'.padEnd(33)}  after`,
    ...r.rows.map(row => `${row.symbol.padEnd(6)}  ${bar(row.current)} ${pct(row.current).padStart(7)}  ${bar(row.target)} ${pct(row.target).padStart(7)}  ${bar(row.postTrade)} ${pct(row.postTrade).padStart(7)}`),
    `${'Cash'.padEnd(6)}  ${bar(r.cashBefore)} ${pct(r.cashBefore).padStart(7)}  ${('floor ≥ ' + pct(r.ownerPlan.minCashWeight)).padEnd(33)}  ${bar(r.cashAfter ?? 0)} ${pct(r.cashAfter ?? 0).padStart(7)}`,
    '```',
    '',
    `## 2. Proposed paper trades (${c.status}; never sent to a broker)`,
    ...c.fills.map(f => `- ${f.side} ${f.quantity} ${f.symbol} @ ${usd(f.price)} (quote ${usd(f.referencePrice)}, ${r.costs.slippageBps} bps slippage)`),
    `- Total cost vs last-price marks: ${usd(c.totalCost)} · fees ${usd(r.costs.feesPerOrder)} per order.`,
    '',
    '## 3. Refused unsafe plan (also frozen)',
    `- Targets ${Object.entries(r.unsafePlan.targets).map(([s, w]) => `${s} ${pct(w)}`).join(', ')}, cash ≥ ${pct(r.unsafePlan.minCashWeight)} → **${r.unsafeChoice.status}** at ${r.unsafeChoice.stage}: ${r.unsafeChoice.problems.join('; ')}. Its outcome is identical to doing nothing.`,
    '',
    '## 4. Frozen before any outcome',
    `- PI paper choice, the do-nothing path, and the predeclared benchmark (${r.benchmark.symbol}: ${r.benchmark.description}; ${r.benchmark.shares} shares, entry cost ${usd(r.benchmark.entryCost)}) were hashed together at ${r.decidedAt}.`,
    `- Costs: ${r.costs.basis}.`,
    '',
    '## 5. Later outcomes (each T1 file revealed only after the freeze)'
  ];
  const scale = Math.max(1, ...outcomes.flatMap(o => [Math.abs(o.vsDoNothing), Math.abs(o.endingValue.benchmark - o.endingValue.doNothing)]));
  for (const o of outcomes) {
    const e = o.endingValue;
    lines.push(
      '',
      `### ${o.label} — revealed ${o.at}`,
      `Prices: ${Object.entries(o.revealedPrices).map(([s, p]) => `${s} ${usd(p)}`).join(', ')}`,
      '',
      '| Path | Ending value | vs do nothing |',
      '|---|---:|---:|',
      `| PI paper rebalance | ${usd(e.piPaper)} | ${usd(e.piPaper - e.doNothing)} |`,
      `| Do nothing | ${usd(e.doNothing)} | $0.00 |`,
      `| Predeclared benchmark (${r.benchmark.symbol}) | ${usd(e.benchmark)} | ${usd(e.benchmark - e.doNothing)} |`,
      '',
      '```',
      `rebalance vs do nothing  ${signedBar(e.piPaper - e.doNothing, scale)} ${usd(e.piPaper - e.doNothing)}`,
      `benchmark vs do nothing  ${signedBar(e.benchmark - e.doNothing, scale)} ${usd(e.benchmark - e.doNothing)}`,
      '```',
      `Verdict: the paper rebalance ${o.vsDoNothing >= 0 ? 'beat' : 'TRAILED'} doing nothing by ${usd(Math.abs(o.vsDoNothing))} and ${o.vsBenchmark >= 0 ? 'beat' : 'TRAILED'} the benchmark by ${usd(Math.abs(o.vsBenchmark))}. Independent recomputation agreed.`
    );
  }
  lines.push(
    '',
    '## Limits',
    '- These synthetic T0 and T1 files were written together by the lab authors; the hash detects later edits but is not an independent timestamp.',
    '- Two invented scenarios show the mechanics and that the rule can lose (scenario B). They are not evidence of skill, alpha, or future returns.',
    '- Rebalancing here only enforces the owner\'s own targets and cash floor; it does not predict prices.',
    ''
  );
  return lines.join('\n');
}

const root = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(root, 'rebalance-proof-fixture');
const frozenPath = path.join(root, 'evidence', 'rebalance-frozen.json');
export const t1Files = () => fs.readdirSync(fixtureDir).filter(f => /^t1-.*\.json$/.test(f)).sort().map(f => path.join(fixtureDir, f));

export function scanProofText(text) {
  // SHA-256 hex can contain long digit runs; mask hashes before the generic leak scan.
  return scanForLeaks(text.replace(/\b[0-9a-f]{64}\b/g, '<sha256>'), { rawIdentifiers: [FIXTURE_ACCOUNT_NUMBER] });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const stage = process.argv[2];
    if (stage === 'plan') {
      const ownerInput = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'owner-plan.json'), 'utf8'));
      const frozen = await freezeRebalance(ownerInput); // T1 files are never opened in this stage.
      const text = `${JSON.stringify(frozen, null, 2)}\n`;
      if (scanProofText(text).length) throw Object.assign(new Error('output_leak_detected'), { code: 'output_leak_detected' });
      fs.writeFileSync(frozenPath, text);
      console.log(`Synthetic rebalancing decision frozen at ${frozen.record.decidedAt}: ${frozen.sha256}`);
    } else if (stage === 'reveal') {
      const frozen = JSON.parse(fs.readFileSync(frozenPath, 'utf8'));
      const outcomes = [];
      if (!t1Files().length) throw new Error('no_t1_outcome_files');
      for (const file of t1Files()) outcomes.push(await revealRebalance(frozen, JSON.parse(fs.readFileSync(file, 'utf8'))));
      let networkAttempts = 0;
      const liveStatus = await runLive({ env: {}, fetchImpl: async () => { networkAttempts += 1; throw new Error('proof_network_forbidden'); } });
      const report = formatRebalanceProof(frozen, outcomes, { live: { reason: liveStatus.reason, networkAttempts } });
      const leaks = scanProofText(report);
      if (leaks.length) throw Object.assign(new Error('output_leak_detected'), { code: 'output_leak_detected', detail: leaks });
      fs.writeFileSync(path.join(root, 'evidence', 'rebalance-proof.md'), report);
      console.log(report);
    } else {
      throw new Error('use_plan_or_reveal');
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error?.code || error?.message || 'error' }));
    process.exitCode = 1;
  }
}
