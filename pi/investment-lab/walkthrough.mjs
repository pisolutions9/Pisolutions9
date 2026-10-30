#!/usr/bin/env node
// PI Investment Lab — concise synthetic owner walkthrough (offline).
//   npm run walkthrough:investment-lab [-- --out DIR]
// Runs the full mission against the local SYNTHETIC broker fixture and prints what an owner would review:
// live-access status, gateway decisions, analysis with provenance, paper-trade decisions, verification.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixtureDemo, runLive, scanForLeaks } from './demo.mjs';
import { ROBINHOOD_REVIEWED_ALLOWLIST } from './reviewed-allowlist.mjs';
import { FIXTURE_ACCOUNT_NUMBER } from './fixture-mcp-server.mjs';

const pct = value => (value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(2)}%`);
const usd = value => `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function runWalkthrough() {
  // 1. Live status is taken from the real live entry point, with a network stub that must never be called.
  let liveNetworkAttempts = 0;
  const live = await runLive({ env: {}, fetchImpl: async () => { liveNetworkAttempts += 1; throw new Error('walkthrough_network_forbidden'); } });

  const { result, serverCalls } = await runFixtureDemo();
  const { discovery, research, quant, risk, simulation, verification } = result;
  const src = research.data.sources;
  const tag = (...capabilities) => `[source: ${capabilities.map(c => `${src[c].tool}@${src[c].observedAt}`).join(', ')} · synthetic]`;
  const snapshot = quant.data.snapshot;
  const pr = quant.data.portfolioRisk;

  const lines = [
    '# PI Investment Lab — synthetic owner walkthrough',
    '',
    `LIVE ROBINHOOD ACCESS: DISABLED — live entry point refused with "${live.reason}" (reviewed Robinhood tools: ${ROBINHOOD_REVIEWED_ALLOWLIST.length}; network attempts: ${liveNetworkAttempts}).`,
    'DATA: SYNTHETIC FIXTURE on 127.0.0.1 — not a real account. Trades below are SIMULATED on a local paper ledger; nothing is sent to any broker. Not investment advice.',
    '',
    '## 1. What the gateway allowed',
    `${discovery.tools.filter(t => t.decision === 'allow').length} of ${discovery.tools.length} server tools allowed (exact reviewed fingerprint match): ${discovery.tools.filter(t => t.decision === 'allow').map(t => t.name).join(', ')}.`,
    `Denied: ${discovery.tools.filter(t => t.decision === 'deny').map(t => `${t.name} (${t.reason})`).join('; ')}.`,
    `Server-side call log: ${serverCalls.join(', ')} — no denied tool was called.`,
    '',
    '## 2. Account snapshot',
    `${research.data.account.accountRef} (real identifier withheld) · type ${research.data.account.type} · settled cash ${usd(research.data.account.cash)} · source-reported equity ${usd(research.data.portfolio.equity)} ${tag('accounts', 'portfolio')}`,
    '',
    '## 3. Analysis (deterministic, recomputed from inspected data)',
    ...snapshot.holdings.map(h => `- ${h.symbol}: ${h.quantity} × ${usd(h.last)} = ${usd(h.marketValue)} (${pct(h.weight)} of equity) ${tag('positions', 'quotes')}`),
    `- Total equity ${usd(snapshot.totalEquity)}; cash ${pct(snapshot.cashWeight)}; effective holdings ${snapshot.effectiveHoldings}.`,
    pr.ok ? `- Annualized volatility ${pct(pr.annualizedVolatility)}; 1-day 95% historical VaR ${pct(pr.historicalVaR1d)} over ${pr.observations} days ${tag('historicals')}` : `- Risk statistics unavailable: ${pr.reason}`,
    ...risk.data.flags.map(f => `- Risk flag [${f.severity}] ${f.code}: ${f.detail}`),
    '',
    '## 4. Paper-trade decisions (SIMULATED — never submitted)',
    ...risk.data.decisions.map(d => {
      const o = d.order;
      if (!d.approvedForSimulation) return `- ${o.side} ${o.quantity} ${o.symbol}: BLOCKED by risk limits (${d.reason}).`;
      const fill = simulation.data.paper.fills.find(f => f.symbol === o.symbol && f.side === o.side && f.quantity === o.quantity);
      const rej = simulation.data.paper.rejections.find(r => r.order.symbol === o.symbol && r.order.side === o.side);
      return fill
        ? `- ${o.side} ${o.quantity} ${o.symbol}: risk-approved → SIMULATED fill ${fill.id} @ ${usd(fill.price)} (quote ${usd(fill.referencePrice)} ${fill.side === 'buy' ? '+' : '−'} ${fill.slippageBps} bps slippage); cash ${usd(fill.cashBefore)} → ${usd(fill.cashAfter)}; submittedToBroker=${fill.submittedToBroker} ${tag('quotes')}`
        : `- ${o.side} ${o.quantity} ${o.symbol}: risk-approved → SIMULATED rejection (${rej?.reason || 'unknown'}).`;
    }),
    `- Live execution request (even with ownerApproval=true): ${simulation.data.liveExecution.status} — ${simulation.data.liveExecution.reason}.`,
    '',
    '## 5. Verification',
    `${verification.result} Scope: ${verification.data.scope}`,
    ...verification.data.checks.filter(c => !c.ok).map(c => `- FAIL ${c.name}: ${c.detail}`)
  ];
  const text = `${lines.join('\n')}\n`;
  const leaks = scanForLeaks(text, { rawIdentifiers: [FIXTURE_ACCOUNT_NUMBER] });
  if (leaks.length) throw Object.assign(new Error('output_leak_detected'), { code: 'output_leak_detected', detail: leaks });
  return { text, ok: result.ok && live.ok === false && liveNetworkAttempts === 0, live, liveNetworkAttempts, serverCalls };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { text, ok } = await runWalkthrough();
    process.stdout.write(text);
    const index = process.argv.indexOf('--out');
    if (index !== -1) {
      const dir = process.argv[index + 1];
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'owner-walkthrough.md'), text);
    }
    if (!ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error?.code || 'error', detail: Array.isArray(error?.detail) ? error.detail : undefined }));
    process.exitCode = 1;
  }
}
