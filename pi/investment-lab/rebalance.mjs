// PI Investment Lab — owner-controlled target-based rebalancing, PAPER ONLY.
// The owner supplies target weights and a cash minimum. This module only computes what it would take
// to move the inspected portfolio to those targets at current quotes, and simulates it on the local
// paper ledger. It never decides targets, never uses price history or forecasts, and never contacts a broker.

import { validateSpecialistInput } from '../specialist-contracts.mjs';
import { freshnessPolicy } from '../tool-evidence.mjs';
import { riskAgent, DEFAULT_LIMITS, CONTRACT } from './agents.mjs';
import { createPaperBroker } from './paper-broker.mjs';
import { portfolioSnapshot } from './quant.mjs';

const TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;
export const HARD_MAX_POSITION_WEIGHT = 0.5; // owners may tighten the 25% default, or loosen it up to this ceiling
const round = (value, places = 6) => Number(value.toFixed(places));

// Returns { ok, plan } or { ok: false, problems } — impossible or unsafe plans are refused outright.
export function validateRebalancePlan(plan = {}, { quotes = {}, holdings = [] } = {}) {
  const problems = [];
  const targets = plan?.targets;
  if (!targets || typeof targets !== 'object' || Array.isArray(targets) || !Object.keys(targets).length) {
    return { ok: false, problems: ['targets_required'] };
  }
  const maxPositionWeight = plan.maxPositionWeight ?? DEFAULT_LIMITS.maxPositionWeight;
  const minCashWeight = plan.minCashWeight;
  const driftBand = plan.driftBand ?? 0.01;
  const slippageBps = plan.slippageBps ?? 5;
  if (typeof minCashWeight !== 'number' || !Number.isFinite(minCashWeight) || minCashWeight < 0 || minCashWeight >= 1) problems.push('min_cash_weight_must_be_in_[0,1)');
  if (typeof maxPositionWeight !== 'number' || !(maxPositionWeight > 0) || maxPositionWeight > HARD_MAX_POSITION_WEIGHT) problems.push(`max_position_weight_must_be_in_(0,${HARD_MAX_POSITION_WEIGHT}]`);
  if (typeof driftBand !== 'number' || !(driftBand >= 0) || driftBand > 0.1) problems.push('drift_band_must_be_in_[0,0.1]');
  if (typeof slippageBps !== 'number' || !(slippageBps >= 0) || slippageBps > 100) problems.push('slippage_bps_must_be_in_[0,100]');
  const normalized = {};
  for (const [rawSymbol, weight] of Object.entries(targets)) {
    const symbol = String(rawSymbol).toUpperCase();
    if (!TICKER.test(symbol)) { problems.push(`invalid_symbol:${String(rawSymbol).slice(0, 12)}`); continue; }
    if (symbol in normalized) { problems.push(`duplicate_symbol:${symbol}`); continue; }
    if (typeof weight !== 'number' || !Number.isFinite(weight)) { problems.push(`weight_not_a_number:${symbol}`); continue; }
    if (weight < 0) { problems.push(`negative_weight_means_short_not_allowed:${symbol}`); continue; }
    if (weight > 1) { problems.push(`weight_above_100pct:${symbol}`); continue; }
    if (typeof maxPositionWeight === 'number' && weight > maxPositionWeight) problems.push(`target_exceeds_position_cap:${symbol}:${weight}>${maxPositionWeight}`);
    if (weight > 0 && !quotes[symbol]) problems.push(`no_quote_cannot_price:${symbol}`);
    normalized[symbol] = weight;
  }
  const invested = Object.values(normalized).reduce((sum, weight) => sum + weight, 0);
  if (typeof minCashWeight === 'number' && invested + minCashWeight > 1 + 1e-9) {
    problems.push(`impossible_targets_plus_cash_exceed_100pct:${round(invested + minCashWeight, 4)}`);
  }
  if (problems.length) return { ok: false, problems };
  // Holdings the owner did not list get an explicit 0% target, so nothing is left implicit.
  const implicitZero = holdings.map(holding => holding.symbol).filter(symbol => !(symbol in normalized));
  for (const symbol of implicitZero) normalized[symbol] = 0;
  return { ok: true, plan: Object.freeze({ targets: Object.freeze(normalized), implicitZero, minCashWeight, maxPositionWeight, driftBand, slippageBps, residualCashTarget: round(1 - invested, 6) }) };
}

function concentration(snapshot) {
  return { topWeight: snapshot.topWeight, herfindahl: snapshot.herfindahl, effectiveHoldings: snapshot.effectiveHoldings, cashWeight: snapshot.cashWeight, cash: snapshot.cash, totalEquity: snapshot.totalEquity };
}

// Deterministic order sizing at current quotes: sells round UP so a holding ends at or below target,
// buys round DOWN and are funded only from cash above the owner's floor. Whole shares only.
function sizeOrders({ snapshot, quotes, plan }) {
  const equity = snapshot.totalEquity;
  const held = new Map(snapshot.holdings.map(holding => [holding.symbol, holding]));
  const sells = [];
  const buys = [];
  for (const [symbol, target] of Object.entries(plan.targets)) {
    const quote = quotes[symbol];
    const currentValue = held.get(symbol)?.marketValue ?? 0;
    const drift = currentValue / equity - target;
    if (Math.abs(drift) <= plan.driftBand && !(target === 0 && currentValue > 0)) continue;
    if (drift > 0) {
      const quantity = Math.min(held.get(symbol).quantity, Math.ceil(round((currentValue - target * equity) / quote.last, 9)));
      if (quantity > 0) sells.push({ side: 'sell', symbol, quantity, type: 'market' });
    } else if (drift < 0) {
      buys.push({ symbol, shortfall: target * equity - currentValue });
    }
  }
  const buyPrice = symbol => (quotes[symbol].ask ?? quotes[symbol].last) * (1 + plan.slippageBps / 10_000);
  const sellPrice = symbol => (quotes[symbol].bid ?? quotes[symbol].last) * (1 - plan.slippageBps / 10_000);
  let budget = snapshot.cash + sells.reduce((sum, order) => sum + order.quantity * sellPrice(order.symbol), 0) - plan.minCashWeight * equity;
  const sizedBuys = [];
  for (const { symbol, shortfall } of buys.sort((a, b) => b.shortfall - a.shortfall || a.symbol.localeCompare(b.symbol))) {
    const price = buyPrice(symbol);
    const quantity = Math.floor(round(Math.min(shortfall, Math.max(0, budget)) / price, 9));
    if (quantity > 0) {
      sizedBuys.push({ side: 'buy', symbol, quantity, type: 'market' });
      budget -= quantity * price;
    }
  }
  return [...sells.sort((a, b) => a.symbol.localeCompare(b.symbol)), ...sizedBuys];
}

export async function proposeRebalance({ missionId = 'rebalance', dataset, quant, plan: ownerPlan, now = () => Date.now() } = {}) {
  validateSpecialistInput(CONTRACT, { missionId, objective: 'owner-controlled target rebalancing (paper only)', context: { dataset }, constraints: {} });
  const snapshot = quant.snapshot;
  const doNothing = Object.freeze({
    label: 'Do nothing (keep current portfolio)',
    trades: 0,
    totalCost: 0,
    weights: Object.fromEntries(snapshot.holdings.map(holding => [holding.symbol, holding.weight])),
    ...concentration(snapshot)
  });
  const base = { schema: 'pi.investment-lab.rebalance.v1', paperOnly: true, submittedToBroker: false, usesPriceForecasts: false, doNothing };

  const validation = validateRebalancePlan(ownerPlan, { quotes: dataset.quotes, holdings: snapshot.holdings });
  if (!validation.ok) return Object.freeze({ ...base, status: 'refused', stage: 'plan_validation', problems: validation.problems, orders: [], fills: [] });
  const plan = validation.plan;
  if (!(snapshot.totalEquity > 0)) return Object.freeze({ ...base, status: 'refused', stage: 'plan_validation', problems: ['no_equity_to_rebalance'], orders: [], fills: [] });
  const orders = sizeOrders({ snapshot, quotes: dataset.quotes, plan });

  // Reuse the lab's risk pre-check with the owner's cash floor and position cap.
  const risk = await riskAgent({ missionId, objective: 'rebalance pre-check', context: { dataset, quant }, constraints: { proposedOrders: orders, limits: { maxPositionWeight: plan.maxPositionWeight, minCashWeight: plan.minCashWeight } } });
  const blocked = risk.data.decisions.filter(decision => !decision.approvedForSimulation);
  if (blocked.length) return Object.freeze({ ...base, status: 'refused', stage: 'risk_precheck', plan, orders, problems: blocked.map(item => `${item.order.side}_${item.order.symbol}:${item.reason}`), fills: [] });

  // Reuse the paper broker: cash-only, no shorting, fresh quotes. All-or-nothing: any rejection refuses the plan.
  const broker = createPaperBroker({ cash: snapshot.cash, positions: dataset.positions, quotes: dataset.quotes, slippageBps: plan.slippageBps, maxQuoteAgeMs: freshnessPolicy('markets').maxAgeMs, now });
  for (const order of orders) broker.simulateOrder(order);
  const paper = broker.state();
  if (paper.rejections.length) return Object.freeze({ ...base, status: 'refused', stage: 'paper_broker', plan, orders, problems: paper.rejections.map(item => `${item.order.side}_${item.order.symbol}:${item.reason}`), fills: [] });

  const after = portfolioSnapshot({ positions: paper.positions, quotes: dataset.quotes, cash: paper.cash });
  const lastOf = symbol => dataset.quotes[symbol].last;
  const costs = paper.fills.map(fill => ({
    id: fill.id,
    slippageCost: round(Math.abs(fill.price - fill.referencePrice) * fill.quantity),
    spreadCost: round(Math.abs(fill.referencePrice - lastOf(fill.symbol)) * fill.quantity)
  }));
  const totalSlippage = round(costs.reduce((sum, item) => sum + item.slippageCost, 0));
  const totalSpread = round(costs.reduce((sum, item) => sum + item.spreadCost, 0));
  const postProblems = [];
  if (after.cashWeight + 1e-9 < plan.minCashWeight) postProblems.push('post_trade_cash_below_owner_minimum');
  if (after.holdings.some(holding => holding.weight > plan.maxPositionWeight + 1e-9)) postProblems.push('post_trade_position_above_cap');
  if (paper.cash < 0) postProblems.push('negative_cash');
  if (postProblems.length) return Object.freeze({ ...base, status: 'refused', stage: 'post_trade_check', plan, orders, problems: postProblems, fills: [] });

  const symbols = [...new Set([...Object.keys(plan.targets), ...snapshot.holdings.map(holding => holding.symbol)])].sort();
  const weightOf = (snap, symbol) => snap.holdings.find(holding => holding.symbol === symbol)?.weight ?? 0;
  const rows = symbols.map(symbol => Object.freeze({
    symbol,
    current: weightOf(snapshot, symbol),
    target: plan.targets[symbol] ?? 0,
    implicitZeroTarget: plan.implicitZero.includes(symbol),
    paperChange: paper.fills.filter(fill => fill.symbol === symbol).map(fill => `${fill.side} ${fill.quantity}`).join(', ') || 'none',
    postTrade: weightOf(after, symbol),
    residualDrift: round(weightOf(after, symbol) - (plan.targets[symbol] ?? 0))
  }));
  // Never overstate success: whole-share sizing can leave targets out of reach.
  const outside = rows.filter(row => Math.abs(row.residualDrift) > plan.driftBand + 1e-9);
  if (!orders.length && outside.length) {
    return Object.freeze({ ...base, status: 'refused', stage: 'sizing', plan, orders: [], fills: [], rows, problems: [`targets_unreachable_with_whole_shares:${outside.map(row => row.symbol).join(',')}`] });
  }
  return Object.freeze({
    ...base,
    status: orders.length ? 'proposed' : 'already_within_band',
    warnings: outside.map(row => `outside_drift_band_after_paper_trades:${row.symbol}:${(row.residualDrift * 100).toFixed(2)}pct`),
    plan,
    orders,
    fills: paper.fills,
    rows,
    costs: Object.freeze({ totalSlippage, totalSpread, fees: 0, total: round(totalSlippage + totalSpread), perFill: costs, basis: 'vs marking each holding at its last trade price' }),
    before: concentration(snapshot),
    after: concentration(after),
    turnover: round(paper.fills.reduce((sum, fill) => sum + fill.notional, 0)),
    decision: 'owner'
  });
}
