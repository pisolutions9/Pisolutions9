import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runFixtureDemo } from './demo.mjs';
import { riskAgent } from './agents.mjs';
import { proposeRebalance, validateRebalancePlan, HARD_MAX_POSITION_WEIGHT } from './rebalance.mjs';
import { runRebalanceScenario, EXAMPLE_OWNER_PLAN, UNSAFE_OWNER_PLAN } from './rebalance-scenario.mjs';
import { ROBINHOOD_REVIEWED_ALLOWLIST } from './reviewed-allowlist.mjs';
import { FIXTURE_ACCOUNT_NUMBER } from './fixture-mcp-server.mjs';

const { result } = await runFixtureDemo();
const dataset = result.research.data;
const quant = result.quant.data;
const propose = (plan, extra = {}) => proposeRebalance({ dataset, quant, plan, ...extra });

// 1. Risk pre-check: risk-REDUCING sells are never blocked by the cash floor or position cap they improve.
{
  const run = (orders, limits) => riskAgent({ missionId: 't', objective: 't', context: { dataset, quant }, constraints: { proposedOrders: orders, limits } });
  const cashRaise = await run([{ side: 'sell', symbol: 'AAPL', quantity: 1 }], { minCashWeight: 0.2 });
  assert.equal(cashRaise.data.decisions[0].approvedForSimulation, true, 'a sell that raises cash is not blocked for cash still below the floor');
  const partialTrim = await run([{ side: 'sell', symbol: 'VTI', quantity: 1 }], { maxPositionWeight: 0.25 });
  assert.equal(partialTrim.data.decisions[0].approvedForSimulation, true, 'a sell that trims an over-cap holding is not blocked for still being above the cap');
  const buyBelowFloor = await run([{ side: 'buy', symbol: 'MSFT', quantity: 1 }], { minCashWeight: 0.2 });
  assert.equal(buyBelowFloor.data.decisions[0].approvedForSimulation, false, 'buys are still blocked by the cash floor');
  const buyOverCap = await run([{ side: 'buy', symbol: 'VTI', quantity: 1 }], { maxPositionWeight: 0.25 });
  assert.equal(buyOverCap.data.decisions[0].approvedForSimulation, false, 'buys are still blocked by the position cap');
}

// 2. Impossible or unsafe owner plans are refused before any paper trade.
{
  const quotes = dataset.quotes;
  const refuse = (plan, pattern) => {
    const out = validateRebalancePlan(plan, { quotes, holdings: quant.snapshot.holdings });
    assert.equal(out.ok, false, `accepted ${JSON.stringify(plan)}`);
    assert.ok(out.problems.some(problem => pattern.test(problem)), `${out.problems} !~ ${pattern}`);
  };
  refuse({}, /targets_required/);
  refuse({ targets: {}, minCashWeight: 0.05 }, /targets_required/);
  refuse({ targets: { VTI: 0.2 } }, /min_cash_weight/);
  refuse({ targets: { VTI: 0.2 }, minCashWeight: 1 }, /min_cash_weight/);
  refuse({ targets: { VTI: 0.2 }, minCashWeight: -0.1 }, /min_cash_weight/);
  refuse({ targets: { VTI: -0.1 }, minCashWeight: 0.05 }, /negative_weight_means_short_not_allowed:VTI/);
  refuse({ targets: { VTI: 1.5 }, minCashWeight: 0.05 }, /weight_above_100pct:VTI/);
  refuse({ targets: { VTI: Number.NaN }, minCashWeight: 0.05 }, /weight_not_a_number:VTI/);
  refuse({ targets: { VTI: '0.2' }, minCashWeight: 0.05 }, /weight_not_a_number:VTI/);
  refuse({ targets: { VTI: 0.2, vti: 0.1 }, minCashWeight: 0.05 }, /duplicate_symbol:VTI/);
  refuse({ targets: { 'not a ticker': 0.1 }, minCashWeight: 0.05 }, /invalid_symbol/);
  refuse({ targets: { ZZZZ: 0.1 }, minCashWeight: 0.05 }, /no_quote_cannot_price:ZZZZ/);
  refuse({ targets: { NVDA: 0.3 }, minCashWeight: 0.05 }, /target_exceeds_position_cap:NVDA/);
  refuse({ targets: { NVDA: 0.6 }, minCashWeight: 0.05, maxPositionWeight: 0.7 }, /max_position_weight/);
  refuse({ targets: { VTI: 0.25, NVDA: 0.25, MSFT: 0.25, AAPL: 0.2 }, minCashWeight: 0.1 }, /impossible_targets_plus_cash_exceed_100pct/);
  refuse({ targets: { VTI: 0.2 }, minCashWeight: 0.05, driftBand: 0.5 }, /drift_band/);
  refuse({ targets: { VTI: 0.2 }, minCashWeight: 0.05, slippageBps: 1000 }, /slippage_bps/);
  assert.equal(HARD_MAX_POSITION_WEIGHT, 0.5);
  const refused = await propose(UNSAFE_OWNER_PLAN);
  assert.equal(refused.status, 'refused');
  assert.equal(refused.stage, 'plan_validation');
  assert.deepEqual(refused.fills, []);
  assert.equal(refused.doNothing.totalCost, 0, 'do-nothing is always offered');
}

// 3. A valid owner plan becomes a paper-only proposal that meets the owner's constraints.
const proposal = await propose(EXAMPLE_OWNER_PLAN);
{
  assert.equal(proposal.status, 'proposed', `${proposal.stage}: ${proposal.problems}`);
  assert.equal(proposal.paperOnly, true);
  assert.equal(proposal.submittedToBroker, false);
  assert.equal(proposal.usesPriceForecasts, false);
  assert.ok(proposal.fills.length > 0);
  assert.ok(proposal.fills.every(fill => fill.simulated === true && fill.submittedToBroker === false));
  const firstBuy = proposal.orders.findIndex(order => order.side === 'buy');
  assert.ok(firstBuy === -1 || proposal.orders.slice(firstBuy).every(order => order.side === 'buy'), 'sells are sized and simulated before buys');
  assert.ok(proposal.after.cashWeight >= EXAMPLE_OWNER_PLAN.minCashWeight, `cash ${proposal.after.cashWeight} below owner minimum`);
  assert.ok(proposal.after.topWeight <= 0.25 + 1e-9, 'post-trade concentration within cap');
  assert.ok(proposal.after.topWeight < proposal.doNothing.topWeight, 'concentration reduced vs do-nothing');
  for (const row of proposal.rows) {
    const price = dataset.quotes[row.symbol].last;
    const oneShare = price / proposal.after.totalEquity;
    assert.ok(row.residualDrift <= 0.01 + 1e-6 && row.residualDrift >= -(0.01 + oneShare + 1e-6), `${row.symbol} residual ${row.residualDrift}`);
  }
  const summed = proposal.costs.perFill.reduce((sum, item) => sum + item.slippageCost + item.spreadCost, 0);
  assert.ok(Math.abs(summed - proposal.costs.total) < 1e-6, 'cost total equals the sum of per-fill costs');
  for (const fill of proposal.fills) {
    const cost = proposal.costs.perFill.find(item => item.id === fill.id);
    assert.ok(Math.abs(cost.slippageCost - Math.abs(fill.price - fill.referencePrice) * fill.quantity) < 1e-6);
  }
  const flows = proposal.fills.reduce((sum, fill) => sum + (fill.side === 'buy' ? -fill.notional : fill.notional), 0);
  assert.ok(Math.abs(quant.snapshot.cash + flows - proposal.after.cash) < 1e-4, 'paper cash reconciles');
  assert.equal(proposal.doNothing.trades, 0);
  assert.equal(proposal.doNothing.cash, quant.snapshot.cash);
  assert.equal(proposal.decision, 'owner');
}

// 4. Determinism and no forecasting: removing all price history changes nothing.
{
  const again = await propose(EXAMPLE_OWNER_PLAN);
  assert.deepEqual(again.orders, proposal.orders);
  const noHistory = await proposeRebalance({ dataset: { ...dataset, series: {} }, quant: { ...quant, perSymbol: {}, portfolioRisk: { ok: false, reason: 'removed' } }, plan: EXAMPLE_OWNER_PLAN });
  assert.deepEqual(noHistory.orders, proposal.orders, 'orders do not depend on price history');
  const source = fs.readFileSync(new URL('./rebalance.mjs', import.meta.url), 'utf8');
  assert.ok(!/seriesStats|portfolioRisk|momentum|historical|\.series\b|forecast\(|predict/.test(source.replace(/^\s*\/\/.*$/gm, '')), 'rebalancer reads no price history');
}

// 5. Unlisted holdings get an explicit 0% target, and in-band targets produce no trades.
{
  const out = await propose({ targets: { VTI: 0.25, NVDA: 0.25, MSFT: 0.2 }, minCashWeight: 0.05 });
  assert.equal(out.status, 'proposed', `${out.problems}`);
  const aapl = out.rows.find(row => row.symbol === 'AAPL');
  assert.equal(aapl.implicitZeroTarget, true);
  assert.equal(aapl.postTrade, 0, 'unlisted holding fully sold on paper');
  const current = Object.fromEntries(quant.snapshot.holdings.map(holding => [holding.symbol, holding.weight]));
  const steady = await propose({ targets: current, minCashWeight: 0.05, maxPositionWeight: 0.35 });
  assert.equal(steady.status, 'already_within_band');
  assert.deepEqual(steady.orders, []);
}

// 5b. Tight plan: targets + cash minimum = 100%. Buys cost ask + slippage, so the buy budget must hold back
//     the owner's cash floor or the result would end just below it.
{
  const tight = await propose({ targets: { VTI: 0.25, NVDA: 0.25, MSFT: 0.2, AAPL: 0.15, SCHD: 0.1 }, minCashWeight: 0.05 });
  assert.equal(tight.status, 'proposed', `${tight.stage}: ${tight.problems}`);
  assert.ok(tight.after.cashWeight >= 0.05, `cash ${tight.after.cashWeight} below floor`);
}

// 6. All-or-nothing: if the paper broker rejects any order (stale quotes here), the whole plan is refused.
{
  const stale = await propose(EXAMPLE_OWNER_PLAN, { now: () => Date.now() + 10 * 60_000 });
  assert.equal(stale.status, 'refused');
  assert.equal(stale.stage, 'paper_broker');
  assert.deepEqual(stale.fills, [], 'no partial rebalance is reported');
  assert.ok(stale.problems.every(problem => /stale_or_undated_quote/.test(problem)));
}

// 7. Owner scenario: live access disabled via the real entry point, provenance, a refusal, no identifiers.
{
  const scenario = await runRebalanceScenario();
  assert.equal(scenario.live.reason, 'no_reviewed_allowlist');
  assert.equal(scenario.liveNetworkAttempts, 0);
  assert.equal(ROBINHOOD_REVIEWED_ALLOWLIST.length, 0, 'empty live allowlist preserved');
  assert.match(scenario.text, /LIVE ROBINHOOD ACCESS: DISABLED/);
  assert.match(scenario.text, /SYNTHETIC FIXTURE/);
  assert.match(scenario.text, /does not forecast prices or recommend targets/);
  assert.match(scenario.text, /Status: PAPER PROPOSAL/);
  assert.match(scenario.text, /Status: REFUSED\*\* at plan_validation/);
  assert.match(scenario.text, /\| Trades \| 0 \|/, 'do-nothing column shown');
  assert.match(scenario.text, /\[prices: get_quotes@.* · synthetic\]/);
  assert.ok(!scenario.text.includes(FIXTURE_ACCOUNT_NUMBER));
}

// 8. Status must not overstate success: no "already_within_band" when targets are unreachable, and
//    proposals that leave holdings outside the band say so.
{
  const { portfolioSnapshot } = await import('./quant.mjs');
  const t0 = Date.parse('2026-10-01T15:00:00Z');
  const q = symbol => ({ symbol, last: 100, bid: 99.98, ask: 100.02, updatedAt: '2026-10-01T15:00:00.000Z' });
  const account = (cash, positions = []) => {
    const quotes = { AAA: q('AAA'), BBB: q('BBB') };
    return { dataset: { account: { cash, marginEnabled: false }, positions, quotes, series: {}, sources: {} }, quant: { snapshot: portfolioSnapshot({ positions, quotes, cash }), portfolioRisk: { ok: false, reason: 'n/a' } } };
  };
  const plan = { targets: { AAA: 0.2, BBB: 0.2 }, minCashWeight: 0.05 };
  const zero = await proposeRebalance({ ...account(0), plan, now: () => t0 });
  assert.equal(zero.status, 'refused');
  assert.ok(zero.problems.includes('no_equity_to_rebalance'), String(zero.problems));
  const tiny = await proposeRebalance({ ...account(50), plan, now: () => t0 });
  assert.notEqual(tiny.status, 'already_within_band', 'unreachable targets must not be reported as satisfied');
  assert.equal(tiny.status, 'refused');
  assert.equal(tiny.stage, 'sizing');
  assert.ok(tiny.problems.some(problem => /targets_unreachable_with_whole_shares:AAA,BBB/.test(problem)), String(tiny.problems));
  const coarse = await proposeRebalance({ ...account(1000), plan: { targets: { AAA: 0.25, BBB: 0.25 }, minCashWeight: 0.05 }, now: () => t0 });
  assert.equal(coarse.status, 'proposed');
  assert.ok(coarse.warnings.some(w => /outside_drift_band_after_paper_trades:AAA/.test(w)), String(coarse.warnings));
  assert.deepEqual(proposal.warnings, [], 'the example plan lands within band');
}

console.log(JSON.stringify({ ok: true, suite: 'pi-investment-lab-rebalance', paperOnly: true, forecasts: false }));
