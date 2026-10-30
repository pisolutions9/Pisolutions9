// PI Investment Lab — specialist agents. Each takes and returns the existing PI
// `data-finance` specialist contract (missionId/objective/context/constraints ->
// result/evidence/truthLevel/failureClass). Agents are deterministic code, not LLM calls:
// numbers come from inspected data and arithmetic, never from model text.

import { evidenceRecord } from '../evidence.mjs';
import { verifyToolEvidence, verifyDomainFreshness, freshnessPolicy } from '../tool-evidence.mjs';
import { validateSpecialistInput, validateSpecialistResult } from '../specialist-contracts.mjs';
import { normalizeAccounts, normalizePortfolio, normalizePositions, normalizeQuotes, normalizeHistoricals } from './normalize.mjs';
import { portfolioSnapshot, seriesStats, portfolioRisk } from './quant.mjs';
import { createPaperBroker } from './paper-broker.mjs';
import { requestLiveExecution, EXECUTION_STATUS } from './execution-gate.mjs';

export const CONTRACT = 'data-finance';
export const AGENT_ROLES = Object.freeze({
  research: 'Garuda',
  quant: 'Kubera',
  risk: 'Rama',
  simulation: 'Hanuman',
  verification: 'Saraswati',
  reporting: 'Chitragupta'
});
export const DEFAULT_LIMITS = Object.freeze({ maxPositionWeight: 0.25, minCashWeight: 0.02, maxPortfolioVolatility: 0.30, maxHistoricalVaR1d: 0.03 });
const TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;

function output({ result, evidence = [], truthLevel, failureClass = 'unknown', status = 'ok', data = {}, problems = [] }) {
  const out = { result, evidence, truthLevel, failureClass, status, problems, data };
  validateSpecialistResult(CONTRACT, out);
  return out;
}

function failed(result, failureClass, problems, data = {}) {
  return output({ result, truthLevel: 'unknown', failureClass, status: 'failed', problems, data });
}

// Garuda — perception: read-only account inspection through the gateway.
export async function researchAgent(input, { gateway }) {
  validateSpecialistInput(CONTRACT, input);
  const evidence = [];
  const problems = [];
  const sources = {};
  const take = async (capability, args, normalizer, options = {}) => {
    const response = await gateway.inspect(capability, args, options);
    if (!response.ok) { problems.push(`${capability}:${response.reason}`); return null; }
    evidence.push(response.evidence);
    sources[capability] = { tool: response.tool, observedAt: response.observedAt, evidence: response.evidence };
    const normalized = normalizer(response.data);
    problems.push(...normalized.problems.map(problem => `${capability}:${problem}`));
    return normalized;
  };

  const accounts = await take('accounts', {}, normalizeAccounts);
  if (!accounts?.accounts?.length) return failed('No account could be inspected.', 'evidence-insufficient', problems);
  const wanted = input.constraints.accountRef;
  const account = accounts.accounts.find(item => item.accountRef === wanted) || accounts.accounts[0];
  const scope = account.accountRef ? { accountRef: account.accountRef } : {};
  const portfolio = await take('portfolio', {}, normalizePortfolio, scope);
  const positions = await take('positions', {}, normalizePositions, scope);
  if (!positions) return failed('Positions could not be inspected.', 'tool-failure', problems);
  const watchlist = (input.constraints.watchlist || []).map(symbol => String(symbol).toUpperCase()).filter(symbol => TICKER.test(symbol));
  const symbols = [...new Set([...positions.positions.map(position => position.symbol), ...watchlist])].slice(0, 25);
  const quotes = symbols.length ? await take('quotes', { symbols: symbols.join(',') }, normalizeQuotes) : { quotes: {}, problems: [] };
  const historicals = symbols.length ? await take('historicals', { symbols: symbols.join(','), interval: 'day', span: '3month' }, normalizeHistoricals) : { series: {}, problems: [] };

  const dataset = {
    account,
    accountCount: accounts.accounts.length,
    portfolio: portfolio?.portfolio || null,
    positions: positions.positions,
    quotes: quotes?.quotes || {},
    series: historicals?.series || {},
    watchlist,
    sources
  };
  const core = Boolean(quotes) && account.cash !== null;
  return output({
    result: `Inspected ${accounts.accounts.length} account(s); ${positions.positions.length} position(s); ${Object.keys(dataset.quotes).length} quote(s); ${Object.keys(dataset.series).length} price series.`,
    evidence,
    truthLevel: core ? 'probable' : 'unknown',
    failureClass: core ? 'unknown' : 'evidence-insufficient',
    status: core ? 'ok' : 'failed',
    problems,
    data: dataset
  });
}

// Kubera — deterministic quantitative analysis of the inspected dataset.
export async function quantAgent(input) {
  validateSpecialistInput(CONTRACT, input);
  const dataset = input.context.dataset;
  if (!dataset) return failed('No dataset supplied.', 'invalid-input', ['dataset_missing']);
  const snapshot = portfolioSnapshot({ positions: dataset.positions, quotes: dataset.quotes, cash: dataset.account.cash ?? 0 });
  const perSymbol = Object.fromEntries(Object.entries(dataset.series).map(([symbol, points]) => [symbol, seriesStats(points)]));
  const risk = portfolioRisk({ holdings: snapshot.holdings, series: dataset.series });
  const problems = [...snapshot.missingQuotes.map(symbol => `quote_missing:${symbol}`), ...(risk.ok ? [] : [`portfolio_risk:${risk.reason}`])];
  return output({
    result: `Total equity ${snapshot.totalEquity} across ${snapshot.holdings.length} holding(s); top weight ${(snapshot.topWeight * 100).toFixed(2)}%.`,
    evidence: [evidenceRecord({ source: 'deterministic:pi-investment-lab/quant', claim: 'portfolio snapshot, per-symbol statistics and historical VaR computed from inspected data', confidence: 'probable', limitations: ['inputs are source-reported; past returns do not predict future returns'] })],
    truthLevel: 'probable',
    problems,
    data: { snapshot, perSymbol, portfolioRisk: risk }
  });
}

// Rama — risk limits, account flags and pre-trade checks for proposed simulated orders.
export async function riskAgent(input) {
  validateSpecialistInput(CONTRACT, input);
  const { dataset, quant } = input.context;
  const limits = { ...DEFAULT_LIMITS, ...(input.constraints.limits || {}) };
  const { snapshot, portfolioRisk: pr } = quant;
  const flags = [];
  for (const holding of snapshot.holdings) {
    if (holding.weight > limits.maxPositionWeight) flags.push({ severity: 'high', code: 'concentration', detail: `${holding.symbol} is ${(holding.weight * 100).toFixed(2)}% of equity (limit ${(limits.maxPositionWeight * 100).toFixed(0)}%).` });
  }
  if (snapshot.cashWeight < limits.minCashWeight) flags.push({ severity: 'medium', code: 'cash_buffer', detail: `Cash is ${(snapshot.cashWeight * 100).toFixed(2)}% of equity (minimum ${(limits.minCashWeight * 100).toFixed(0)}%).` });
  if (pr.ok && pr.annualizedVolatility > limits.maxPortfolioVolatility) flags.push({ severity: 'medium', code: 'volatility', detail: `Annualized portfolio volatility ${(pr.annualizedVolatility * 100).toFixed(2)}% exceeds ${(limits.maxPortfolioVolatility * 100).toFixed(0)}%.` });
  if (pr.ok && pr.historicalVaR1d > limits.maxHistoricalVaR1d) flags.push({ severity: 'medium', code: 'var', detail: `1-day 95% historical VaR ${(pr.historicalVaR1d * 100).toFixed(2)}% exceeds ${(limits.maxHistoricalVaR1d * 100).toFixed(0)}%.` });
  if (!pr.ok) flags.push({ severity: 'info', code: 'risk_model_unavailable', detail: `Portfolio risk statistics unavailable: ${pr.reason}.` });
  if (dataset.account.marginEnabled) flags.push({ severity: 'info', code: 'margin_account', detail: 'The inspected account reports margin capability. The lab never uses margin; simulations are cash-only.' });

  const equity = snapshot.totalEquity;
  let projectedCash = snapshot.cash;
  const projected = new Map(snapshot.holdings.map(holding => [holding.symbol, holding.marketValue]));
  const decisions = (input.constraints.proposedOrders || []).map(order => {
    const symbol = String(order.symbol || '').toUpperCase();
    const quote = dataset.quotes[symbol];
    const quantity = Number(order.quantity);
    const side = String(order.side || '').toLowerCase();
    if (!quote || !Number.isFinite(quantity) || quantity <= 0 || !['buy', 'sell'].includes(side)) return { order, approvedForSimulation: false, reason: 'invalid_or_unquoted_order' };
    const delta = quote.last * quantity * (side === 'buy' ? 1 : -1);
    const value = (projected.get(symbol) || 0) + delta;
    const cash = projectedCash - delta;
    // Limits gate orders that can worsen them (buys). A sell only lowers its position and raises cash,
    // so it is never blocked for leaving a position above the cap or cash below the floor it improves.
    if (side === 'buy' && value / equity > limits.maxPositionWeight) return { order, approvedForSimulation: false, reason: `post_trade_weight_${(value / equity * 100).toFixed(2)}pct_exceeds_limit` };
    if (side === 'buy' && cash / equity < limits.minCashWeight) return { order, approvedForSimulation: false, reason: 'post_trade_cash_below_minimum' };
    projected.set(symbol, value);
    projectedCash = cash;
    return { order, approvedForSimulation: true, reason: 'within_limits' };
  });
  return output({
    result: `${flags.filter(flag => flag.severity !== 'info').length} risk flag(s); ${decisions.filter(item => item.approvedForSimulation).length}/${decisions.length} proposed order(s) approved for simulation.`,
    evidence: [evidenceRecord({ source: 'deterministic:pi-investment-lab/risk', claim: `limits ${JSON.stringify(limits)}`, confidence: 'probable' })],
    truthLevel: 'probable',
    data: { limits, flags, decisions }
  });
}

// Hanuman — bounded execution, here limited to the local paper ledger.
export async function simulationAgent(input, { now = () => Date.now() } = {}) {
  validateSpecialistInput(CONTRACT, input);
  const { dataset, risk } = input.context;
  const broker = createPaperBroker({
    cash: dataset.account.cash ?? 0,
    positions: dataset.positions,
    quotes: dataset.quotes,
    maxQuoteAgeMs: freshnessPolicy('markets').maxAgeMs,
    now
  });
  for (const decision of risk.decisions) if (decision.approvedForSimulation) broker.simulateOrder(decision.order);
  const liveExecution = input.constraints.requestLiveExecution ? requestLiveExecution({ kind: 'equity_order', approved: input.constraints.ownerApproval === true }) : null;
  const state = broker.state();
  return output({
    result: `${state.fills.length} simulated fill(s), ${state.rejections.length} simulated rejection(s). No order was sent to any broker.`,
    evidence: [evidenceRecord({ source: 'deterministic:pi-investment-lab/paper-broker', claim: 'local paper ledger; hypothetical fills priced from inspected quotes', confidence: 'probable', limitations: ['simulated fills ignore market impact beyond fixed slippage and do not reflect real execution'] })],
    truthLevel: 'probable',
    data: { paper: state, liveExecution, executionStatus: EXECUTION_STATUS }
  });
}

// Saraswati (+ Nandi) — independent verification. Recomputes rather than trusting other agents.
export async function verificationAgent(input, { gateway, now = () => Date.now() } = {}) {
  validateSpecialistInput(CONTRACT, input);
  const { dataset, quant, simulation, discovery } = input.context;
  const checks = [];
  const check = (name, ok, detail) => checks.push(Object.freeze({ name, ok: Boolean(ok), detail }));

  let recomputed = dataset.account.cash ?? 0;
  for (const position of dataset.positions) recomputed += position.quantity * (dataset.quotes[position.symbol]?.last ?? NaN);
  check('equity_recomputed_independently', Number.isFinite(recomputed) && Math.abs(recomputed - quant.snapshot.totalEquity) < 0.01, `independent ${recomputed.toFixed(2)} vs quant ${quant.snapshot.totalEquity}`);
  const reported = dataset.portfolio?.equity;
  if (reported !== null && reported !== undefined) {
    const drift = Math.abs(recomputed - reported) / Math.max(1, Math.abs(reported));
    check('equity_matches_source_reported', drift <= 0.005, `source-reported ${reported}; relative difference ${(drift * 100).toFixed(3)}% (tolerance 0.5%)`);
  } else check('equity_matches_source_reported', false, 'source did not report equity');

  for (const [capability, source] of Object.entries(dataset.sources)) {
    const result = capability === 'quotes'
      ? verifyDomainFreshness(source.evidence, source.tool, 'markets', { now: now() })
      : verifyToolEvidence(source.evidence, source.tool);
    check(`evidence_${capability}`, result.ok, result.ok ? `tool:${source.tool} observed ${source.observedAt}` : result.reason);
  }
  const maxAge = freshnessPolicy('markets').maxAgeMs;
  const stale = Object.values(dataset.quotes).filter(quote => !(now() - Date.parse(quote.updatedAt || '') <= maxAge));
  check('quotes_fresh_per_source_timestamp', stale.length === 0, stale.length ? `stale/undated: ${stale.map(quote => quote.symbol).join(', ')}` : `all quotes within ${maxAge / 1000}s`);

  const audit = gateway.auditLog();
  const allowedTools = new Set(discovery.tools.filter(tool => tool.decision === 'allow').map(tool => tool.name));
  const calls = audit.filter(entry => entry.type === 'inspect' && entry.decision === 'allow');
  check('gateway_only_called_read_classified_tools', calls.every(entry => allowedTools.has(entry.tool)), `${calls.length} call(s), all to read-classified tools`);
  const deniedTools = discovery.tools.filter(tool => tool.decision === 'deny').map(tool => tool.name);
  check('gateway_never_called_denied_tools', !calls.some(entry => deniedTools.includes(entry.tool)), `${deniedTools.length} tool(s) denied at discovery`);

  const paper = simulation.paper;
  check('all_trades_simulated_not_submitted', [...paper.fills, ...paper.rejections].every(item => item.simulated === true && item.submittedToBroker === false), `${paper.fills.length} fill(s), ${paper.rejections.length} rejection(s)`);
  const flows = paper.fills.reduce((sum, fill) => sum + (fill.side === 'buy' ? -fill.notional : fill.notional), 0);
  check('paper_ledger_reconciles', Math.abs((dataset.account.cash ?? 0) + flows - paper.cash) < 1e-6, `start ${dataset.account.cash} + flows ${flows.toFixed(6)} = end ${paper.cash}`);
  check('paper_ledger_cash_non_negative_no_margin', paper.cash >= 0, `end cash ${paper.cash}`);
  if (simulation.liveExecution) check('live_execution_refused', simulation.liveExecution.ok === false && simulation.liveExecution.sideEffect === false, simulation.liveExecution.reason);

  const failedChecks = checks.filter(item => !item.ok);
  return output({
    result: `${checks.length - failedChecks.length}/${checks.length} verification checks passed.`,
    evidence: [evidenceRecord({ source: 'deterministic:pi-investment-lab/verification', claim: JSON.stringify(checks.map(item => [item.name, item.ok])), confidence: failedChecks.length ? 'probable' : 'verified' })],
    truthLevel: failedChecks.length ? 'probable' : 'verified',
    failureClass: failedChecks.length ? 'evidence-insufficient' : 'unknown',
    status: failedChecks.length ? 'failed' : 'ok',
    problems: failedChecks.map(item => item.name),
    data: { checks, scope: 'Internal consistency, provenance, freshness, read-only gateway behaviour and simulation integrity. Not an audit of the broker’s data.' }
  });
}

const pct = value => (value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(2)}%`);
const usd = value => (value === null || value === undefined ? 'n/a' : `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

// Chitragupta — human-readable, provenance-labelled report.
export async function reportingAgent(input) {
  validateSpecialistInput(CONTRACT, input);
  const { provenance, discovery, dataset, research, quant, risk, simulation, verification, audit, generatedAt } = input.context;
  const snapshot = quant.data.snapshot;
  const pr = quant.data.portfolioRisk;
  const synthetic = provenance === 'synthetic-fixture';
  const lines = [
    '# PI Investment Lab — Read-only Account Inspection Report',
    '',
    '> **READ-ONLY INSPECTION · SIMULATED TRADES ONLY · NOT INVESTMENT ADVICE.** No order was submitted, no funds moved, no margin used.',
    synthetic ? '> **DATA PROVENANCE: SYNTHETIC FIXTURE.** All account figures below come from a local test MCP server, not a real Robinhood account.' : '> Data provenance: live MCP server (see Source). Figures are source-reported and point-in-time.',
    '',
    `Generated: ${generatedAt} · Mission: ${input.missionId}`,
    '',
    '## Source',
    `- MCP server: ${discovery.server.name} ${discovery.server.version} at ${discovery.endpointHost} (protocol ${discovery.protocolVersion})`,
    `- Tools discovered: ${discovery.tools.length}; allowed (read-only): ${discovery.tools.filter(tool => tool.decision === 'allow').length}; denied: ${discovery.tools.filter(tool => tool.decision === 'deny').length}`,
    ...discovery.tools.map(tool => `  - \`${tool.name}\` → **${tool.decision}** (${tool.reason}${tool.capability ? `; ${tool.capability}` : ''})`),
    '',
    `## Account (${research.truthLevel})`,
    `- Account reference: ${dataset.account.accountRef} (real identifier withheld by gateway)`,
    `- Type: ${dataset.account.type}; settled cash: ${usd(dataset.account.cash)}; margin capability reported: ${dataset.account.marginEnabled ? 'yes (never used by lab)' : 'no'}`,
    `- Source-reported equity: ${usd(dataset.portfolio?.equity)}`,
    '',
    `## Holdings (${quant.truthLevel}, deterministic)`,
    '| Symbol | Qty | Last | Market value | Weight | Unrealized P&L |',
    '|---|---:|---:|---:|---:|---:|',
    ...snapshot.holdings.map(item => `| ${item.symbol} | ${item.quantity} | ${usd(item.last)} | ${usd(item.marketValue)} | ${pct(item.weight)} | ${usd(item.unrealizedPnl)} |`),
    `| Cash | | | ${usd(snapshot.cash)} | ${pct(snapshot.cashWeight)} | |`,
    `| **Total** | | | **${usd(snapshot.totalEquity)}** | | ${usd(snapshot.unrealizedPnl)} |`,
    '',
    `Effective number of holdings: ${snapshot.effectiveHoldings} (Herfindahl ${snapshot.herfindahl}).`,
    pr.ok ? `Portfolio annualized volatility ${pct(pr.annualizedVolatility)}; 1-day ${pr.varConfidence * 100}% historical VaR ${pct(pr.historicalVaR1d)} over ${pr.observations} overlapping days (${pr.method}).` : `Portfolio risk statistics unavailable: ${pr.reason}.`,
    '',
    '| Symbol | Obs | Total return | Ann. vol | Max drawdown | 20d momentum |',
    '|---|---:|---:|---:|---:|---:|',
    ...Object.entries(quant.data.perSymbol).map(([symbol, s]) => `| ${symbol} | ${s.observations} | ${pct(s.totalReturn)} | ${pct(s.annualizedVolatility)} | ${pct(s.maxDrawdown)} | ${pct(s.momentum20d)} |`),
    '',
    `## Risk (${risk.truthLevel})`,
    ...(risk.data.flags.length ? risk.data.flags.map(flag => `- [${flag.severity}] ${flag.code}: ${flag.detail}`) : ['- No limit breaches.']),
    '',
    '## Simulated trades (paper ledger only — never sent to a broker)',
    ...risk.data.decisions.map(item => `- Risk pre-check ${item.order.side} ${item.order.quantity} ${item.order.symbol}: ${item.approvedForSimulation ? 'approved for simulation' : `blocked (${item.reason})`}`),
    ...simulation.data.paper.fills.map(fill => `- SIMULATED fill ${fill.id}: ${fill.side} ${fill.quantity} ${fill.symbol} @ ${usd(fill.price)} (ref ${usd(fill.referencePrice)}, ${fill.slippageBps} bps slippage) → cash ${usd(fill.cashBefore)} → ${usd(fill.cashAfter)}`),
    ...simulation.data.paper.rejections.map(item => `- SIMULATED rejection: ${item.order.side} ${item.order.quantity} ${item.order.symbol} (${item.reason})`),
    simulation.data.liveExecution ? `- Live execution request: **${simulation.data.liveExecution.status}** (${simulation.data.liveExecution.reason}; policy: ${simulation.data.liveExecution.policyDecision.reason}).` : '- Live execution was not requested.',
    '',
    `## Verification (${verification.truthLevel})`,
    ...verification.data.checks.map(item => `- ${item.ok ? 'PASS' : 'FAIL'} ${item.name}: ${item.detail}`),
    `- Scope: ${verification.data.scope}`,
    '',
    '## Gateway audit',
    `- ${audit.filter(entry => entry.type === 'inspect' && entry.decision === 'allow').length} read call(s) executed; ${audit.filter(entry => entry.decision === 'deny').length} request(s) denied by the gateway.`,
    '',
    '## Limitations',
    '- Figures are point-in-time and source-reported; the lab does not independently audit broker records.',
    '- Historical statistics describe the past only and are not forecasts or recommendations.',
    '- Simulated fills use a fixed slippage model and ignore liquidity, fees, taxes, settlement timing and market hours.',
    '- Robinhood MCP tool names and response shapes are discovered at runtime; unrecognized shapes fail closed.',
    ...(research.problems.length ? [`- Research problems: ${research.problems.join('; ')}`] : [])
  ];
  return output({
    result: lines.join('\n'),
    evidence: [evidenceRecord({ source: 'deterministic:pi-investment-lab/reporting', claim: 'report rendered from agent outputs', confidence: verification.truthLevel === 'verified' ? 'verified' : 'probable' })],
    truthLevel: verification.truthLevel === 'verified' ? 'verified' : 'probable',
    data: { synthetic }
  });
}
