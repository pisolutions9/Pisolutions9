#!/usr/bin/env node
// PI Investment Lab — owner rebalancing paper scenario (offline, SYNTHETIC data only).
//   npm run rebalance:investment-lab                       example owner plan + one deliberately unsafe plan
//   npm run rebalance:investment-lab -- --plan plan.json   your own plan: {"targets":{"VTI":0.25,...},"minCashWeight":0.05}
// The plans below are EXAMPLES of owner input, not recommendations. Nothing here forecasts prices.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixtureDemo, runLive, scanForLeaks } from './demo.mjs';
import { proposeRebalance } from './rebalance.mjs';
import { ROBINHOOD_REVIEWED_ALLOWLIST } from './reviewed-allowlist.mjs';
import { FIXTURE_ACCOUNT_NUMBER } from './fixture-mcp-server.mjs';

export const EXAMPLE_OWNER_PLAN = Object.freeze({
  label: 'Example owner plan (illustrative input, not advice)',
  targets: { VTI: 0.25, NVDA: 0.2, MSFT: 0.2, AAPL: 0.15, SCHD: 0.1 },
  minCashWeight: 0.08
});
export const UNSAFE_OWNER_PLAN = Object.freeze({
  label: 'Deliberately unsafe plan (shows a refusal)',
  targets: { NVDA: 0.45, VTI: 0.3, MSFT: 0.2 },
  minCashWeight: 0.1
});

const pct = value => `${(value * 100).toFixed(2)}%`;
const usd = value => `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function renderProposal(title, proposal, provenance) {
  const lines = [`## ${title}`, ''];
  const d = proposal.doNothing;
  if (proposal.status === 'refused') {
    lines.push(`**Status: REFUSED** at ${proposal.stage}. No paper trades were made.`);
    for (const problem of proposal.problems) lines.push(`- ${problem}`);
    lines.push('', `Do-nothing remains available: top holding ${pct(d.topWeight)}, cash ${pct(d.cashWeight)}, cost $0.00.`, '');
    return lines;
  }
  lines.push(
    `**Status: ${proposal.status === 'proposed' ? 'PAPER PROPOSAL' : 'ALREADY WITHIN DRIFT BAND'}** — paper only, nothing sent to any broker. Decision: owner. ${provenance}`,
    '',
    '| Symbol | Current | Target | Paper change | After | Residual |',
    '|---|---:|---:|---|---:|---:|',
    ...proposal.rows.map(row => `| ${row.symbol} | ${pct(row.current)} | ${pct(row.target)}${row.implicitZeroTarget ? ' (unlisted→0%)' : ''} | ${row.paperChange} | ${pct(row.postTrade)} | ${pct(row.residualDrift)} |`),
    `| Cash | ${pct(proposal.before.cashWeight)} | ≥ ${pct(proposal.plan.minCashWeight)} | | ${pct(proposal.after.cashWeight)} | |`,
    '',
    '| | Do nothing | Paper proposal |',
    '|---|---:|---:|',
    `| Trades | 0 | ${proposal.fills.length} |`,
    `| Turnover | $0.00 | ${usd(proposal.turnover)} |`,
    `| Cost (slippage + spread, fees ${usd(proposal.costs.fees)}) | $0.00 | ${usd(proposal.costs.total)} (${usd(proposal.costs.totalSlippage)} + ${usd(proposal.costs.totalSpread)}) |`,
    `| Largest holding | ${pct(d.topWeight)} | ${pct(proposal.after.topWeight)} |`,
    `| Effective holdings | ${d.effectiveHoldings} | ${proposal.after.effectiveHoldings} |`,
    `| Cash | ${usd(d.cash)} (${pct(d.cashWeight)}) | ${usd(proposal.after.cash)} (${pct(proposal.after.cashWeight)}) |`,
    '',
    ...proposal.fills.map(fill => `- SIMULATED ${fill.side} ${fill.quantity} ${fill.symbol} @ ${usd(fill.price)} (quote ${usd(fill.referencePrice)} ${fill.side === 'buy' ? '+' : '−'} ${fill.slippageBps} bps), submittedToBroker=${fill.submittedToBroker}`),
    ...(proposal.warnings || []).map(warning => `- **WARNING** ${warning}: whole-share sizing could not bring this holding within the ${pct(proposal.plan.driftBand)} band.`),
    `- Costs are measured ${proposal.costs.basis}. Whole shares only, so small residual drift remains.`,
    ''
  );
  return lines;
}

export async function runRebalanceScenario({ plans = [EXAMPLE_OWNER_PLAN, UNSAFE_OWNER_PLAN] } = {}) {
  let liveNetworkAttempts = 0;
  const live = await runLive({ env: {}, fetchImpl: async () => { liveNetworkAttempts += 1; throw new Error('scenario_network_forbidden'); } });
  const { result } = await runFixtureDemo();
  const src = result.research.data.sources;
  const provenance = `[prices: ${src.quotes.tool}@${src.quotes.observedAt}; holdings: ${src.positions.tool}@${src.positions.observedAt} · synthetic]`;
  const proposals = [];
  for (const plan of plans) proposals.push({ plan, proposal: await proposeRebalance({ dataset: result.research.data, quant: result.quant.data, plan }) });
  const lines = [
    '# PI Investment Lab — owner rebalancing paper scenario',
    '',
    `LIVE ROBINHOOD ACCESS: DISABLED — live entry point refused with "${live.reason}" (reviewed Robinhood tools: ${ROBINHOOD_REVIEWED_ALLOWLIST.length}; network attempts: ${liveNetworkAttempts}).`,
    'DATA: SYNTHETIC FIXTURE — not a real account. PAPER ONLY — no order is sent anywhere. Targets come from the owner; the lab does not forecast prices or recommend targets. Not investment advice.',
    '',
    ...proposals.flatMap(({ plan, proposal }) => renderProposal(`${plan.label || 'Owner plan'}: targets ${Object.entries(plan.targets).map(([s, w]) => `${s} ${pct(w)}`).join(', ')}; cash ≥ ${pct(plan.minCashWeight)}`, proposal, provenance))
  ];
  const text = `${lines.join('\n')}\n`;
  const leaks = scanForLeaks(text, { rawIdentifiers: [FIXTURE_ACCOUNT_NUMBER] });
  if (leaks.length) throw Object.assign(new Error('output_leak_detected'), { code: 'output_leak_detected', detail: leaks });
  return { text, live, liveNetworkAttempts, proposals };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const arg = name => { const index = process.argv.indexOf(name); return index === -1 ? null : process.argv[index + 1]; };
    const planFile = arg('--plan');
    const plans = planFile ? [{ label: 'Owner plan', ...JSON.parse(fs.readFileSync(planFile, 'utf8')) }] : undefined;
    const { text } = await runRebalanceScenario(plans ? { plans } : {});
    process.stdout.write(text);
    const out = arg('--out');
    if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'rebalance-scenario.md'), text); }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error?.code || error?.message || 'error', detail: Array.isArray(error?.detail) ? error.detail : undefined }));
    process.exitCode = 1;
  }
}
