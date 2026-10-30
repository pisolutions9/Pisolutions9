import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMcpClient, McpTransportError } from './mcp-client.mjs';
import { classifyTool, createPermissionGateway, DENY_TOKENS } from './permission-gateway.mjs';
import { requestLiveExecution, EXECUTION_STATUS } from './execution-gate.mjs';
import { createPaperBroker } from './paper-broker.mjs';
import { maxDrawdown, portfolioSnapshot, seriesStats } from './quant.mjs';
import { verificationAgent, AGENT_ROLES } from './agents.mjs';
import { runInvestmentMission } from './orchestrator.mjs';
import { startFixtureServer, FIXTURE_ACCOUNT_NUMBER, FIXTURE_TOOLS } from './fixture-mcp-server.mjs';
import { runFixtureDemo, DEMO_CONSTRAINTS, reviewToolsList } from './demo.mjs';
import { getTeamRole } from '../team-manifest.mjs';
import { FIXTURE_REVIEWED_ALLOWLIST, ROBINHOOD_REVIEWED_ALLOWLIST } from './reviewed-allowlist.mjs';
import { fingerprintTool } from './permission-gateway.mjs';

const READ_TOOLS = ['get_accounts', 'get_portfolio', 'get_positions', 'get_quotes', 'get_historicals'];
const TOKEN = 'fixture-only-test-token-0123456789';

// 1. Tool classification: deny-by-default, write verbs and annotations always win.
const classify = (name, annotations, toolMap) => classifyTool({ name, annotations }, { toolMap });
assert.equal(classify('get_positions').decision, 'allow');
assert.equal(classify('get_positions').capability, 'positions');
assert.equal(classify('getAccountPositions').capability, 'positions');
for (const name of ['place_equity_order', 'cancel_order', 'transfer_funds', 'enable_margin', 'get_order_history', 'getQuoteAndPlaceOrder', 'get_buy_quote', 'list_ach_relationships', 'get_options_chain']) {
  assert.equal(classify(name, { readOnlyHint: true }).decision, 'deny', `${name} must be denied`);
}
assert.equal(classify('get_account_settings', { readOnlyHint: false }).reason, 'annotation_not_read_only');
assert.equal(classify('get_quotes', { destructiveHint: true }).reason, 'annotation_destructive');
assert.equal(classify('refresh_positions').reason, 'no_read_intent');
assert.equal(classify('get_weather').reason, 'not_in_read_capability_allowlist');
assert.equal(classify('place_order', { readOnlyHint: true }, { positions: 'place_order' }).decision, 'deny', 'owner map cannot override deny tokens');
assert.equal(classify('fetch_book', { readOnlyHint: true }, { positions: 'fetch_book' }).capability, 'positions', 'owner map can route a read tool');
assert.equal(classify('fetch_book', { readOnlyHint: true }, { orders: 'fetch_book' }).decision, 'deny', 'owner map cannot invent capabilities');
// Each critical write token blocks on its own, even wrapped in a read verb, a read capability and readOnlyHint.
for (const token of ['order', 'trade', 'buy', 'sell', 'place', 'submit', 'cancel', 'replace', 'transfer', 'deposit', 'withdraw', 'fund', 'ach', 'wire', 'margin', 'borrow', 'card', 'pay', 'approve', 'enable', 'execute', 'rebalance', 'liquidate', 'short', 'options', 'token', 'credentials']) {
  assert.ok(DENY_TOKENS.has(token), `${token} is a deny token`);
  assert.equal(classify(`get_${token}_quotes`, { readOnlyHint: true }).reason, `deny_token:${token}`);
}

// 2. MCP client: endpoint hygiene and credential confinement.
assert.throws(() => createMcpClient({ endpoint: 'http://example.com/mcp' }), /https_required/);
assert.throws(() => createMcpClient({ endpoint: 'https://user:pw@example.com/mcp' }), /credentials_in_url_forbidden/);
assert.throws(() => createMcpClient({ endpoint: 'https://example.com/mcp?token=x' }), /query_string_forbidden/);
{
  const fixture = await startFixtureServer({ token: TOKEN });
  try {
    const client = createMcpClient({ endpoint: fixture.url, getAccessToken: async () => 'wrong-token-value-xyz' });
    const error = await client.initialize().catch(e => e);
    assert.ok(error instanceof McpTransportError);
    assert.equal(error.code, 'unauthorized');
    assert.equal(error.detail.wwwAuthenticate, true);
    assert.ok(!JSON.stringify({ m: error.message, d: error.detail }).includes('wrong-token-value-xyz'));
    const good = createMcpClient({ endpoint: fixture.url, getAccessToken: async () => TOKEN });
    assert.ok(!JSON.stringify(Object.getOwnPropertyNames(good)).includes('token'));
    const session = await good.initialize();
    assert.equal(session.protocolVersion, '2025-11-25');
  } finally { await fixture.close(); }
}

// 3. Gateway: refuses before connect, unknown capabilities, order-shaped args, foreign account refs, budget.
{
  const fixture = await startFixtureServer({ token: TOKEN });
  try {
    const client = createMcpClient({ endpoint: fixture.url, getAccessToken: async () => TOKEN });
    const unreviewed = createPermissionGateway({ client: createMcpClient({ endpoint: fixture.url, getAccessToken: async () => TOKEN }) });
    assert.deepEqual((await unreviewed.connect()).routes, {}, 'no reviewed allowlist => nothing is callable');
    const gateway = createPermissionGateway({ client, reviewedAllowlist: FIXTURE_REVIEWED_ALLOWLIST, maxCalls: 4, secretCanaries: [TOKEN] });
    assert.deepEqual(Object.keys(gateway).sort(), ['auditLog', 'capabilities', 'connect', 'containsKnownIdentifier', 'discovery', 'inspect'], 'no generic tool-call surface');
    assert.equal((await gateway.inspect('accounts')).reason, 'gateway_not_connected');
    const discovery = await gateway.connect();
    assert.deepEqual(discovery.tools.filter(t => t.decision === 'allow').map(t => t.name).sort(), [...READ_TOOLS].sort());
    assert.equal((await gateway.inspect('orders')).reason, 'capability_not_allowed');
    assert.equal((await gateway.inspect('place_equity_order')).reason, 'capability_not_allowed');
    assert.equal((await gateway.inspect('quotes', { symbols: 'AAPL', quantity: 5 })).reason, 'forbidden_arg:quantity');
    assert.equal((await gateway.inspect('quotes', { symbols: 'AAPL', side: 'buy' })).reason, 'forbidden_arg:side');
    assert.equal((await gateway.inspect('positions', { account_number: FIXTURE_ACCOUNT_NUMBER })).reason, 'account_must_use_accountRef', 'raw account numbers are not accepted from agents');
    assert.equal((await gateway.inspect('positions', {}, { accountRef: 'acct_ref_9' })).reason, 'unknown_account_ref');
    assert.ok(discovery.tools.find(t => t.name === 'get_holdings').reason === 'not_in_reviewed_allowlist', 'read-looking but unreviewed tool is denied');
    const accounts = await gateway.inspect('accounts');
    assert.ok(accounts.ok);
    const row = accounts.data.results[0];
    assert.equal(row.account_number, 'acct_ref_1');
    assert.equal(row.email, '[REDACTED]');
    assert.equal(row.url, '[REDACTED]', 'URLs embedding account numbers are withheld');
    assert.ok((await gateway.inspect('positions', {}, { accountRef: 'acct_ref_1' })).ok);
    assert.equal(fixture.calls.at(-1).args.account_number, FIXTURE_ACCOUNT_NUMBER, 'gateway translates ref back only at the transport boundary');
    await gateway.inspect('quotes', { symbols: 'AAPL' });
    await gateway.inspect('quotes', { symbols: 'MSFT' });
    assert.equal((await gateway.inspect('quotes', { symbols: 'VTI' })).reason, 'call_budget_exhausted');
    assert.ok(fixture.calls.every(call => READ_TOOLS.includes(call.name)), 'server saw only read tools');
    assert.ok(gateway.auditLog().filter(e => e.decision === 'deny').length >= 6);
  } finally { await fixture.close(); }
}

// 4. Canary scrubbing: a server echoing the bearer token never gets it through to agents.
{
  const ECHO_TOOL = { name: 'get_quotes', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { symbols: { type: 'string' } } } };
  const echoClient = {
    endpointHost: 'stub', initialize: async () => ({ protocolVersion: '2025-11-25', serverInfo: { name: 'stub', version: '0' } }),
    listTools: async () => [ECHO_TOOL],
    callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ results: [{ symbol: 'AAPL', last_trade_price: '1', note: `echo ${TOKEN}`, status: TOKEN, session_token: 'abc' }] }) }] })
  };
  const gateway = createPermissionGateway({ client: echoClient, reviewedAllowlist: [{ capability: 'quotes', name: 'get_quotes', fingerprint: fingerprintTool(ECHO_TOOL), args: { symbols: 'string' } }], secretCanaries: [TOKEN] });
  await gateway.connect();
  const out = await gateway.inspect('quotes', { symbols: 'AAPL' });
  assert.ok(!JSON.stringify(out).includes(TOKEN));
  assert.ok(out.ok);
  assert.equal(out.data.results[0].session_token, '[REDACTED]');
  assert.equal(out.data.results[0].status, '[REDACTED]');
}

// 5. Paper broker: cash-only, no shorting, fresh quotes, simulated flags.
{
  const now = Date.parse('2026-10-29T15:00:00Z');
  const quotes = { AAA: { symbol: 'AAA', last: 100, bid: 99.9, ask: 100.1, updatedAt: '2026-10-29T15:00:00Z' }, OLD: { symbol: 'OLD', last: 10, bid: null, ask: null, updatedAt: '2026-10-29T14:00:00Z' } };
  const broker = createPaperBroker({ cash: 1000, positions: [{ symbol: 'AAA', quantity: 2 }], quotes, maxQuoteAgeMs: 120_000, now: () => now });
  assert.equal(broker.simulateOrder({ side: 'buy', symbol: 'AAA', quantity: 20 }).reason, 'insufficient_settled_cash_no_margin');
  assert.equal(broker.simulateOrder({ side: 'sell', symbol: 'AAA', quantity: 3 }).reason, 'exceeds_holding_no_shorting');
  assert.equal(broker.simulateOrder({ side: 'buy', symbol: 'OLD', quantity: 1 }).reason, 'stale_or_undated_quote');
  assert.equal(broker.simulateOrder({ side: 'buy', symbol: 'AAA', quantity: 1, type: 'limit' }).reason, 'only_simulated_market_orders_supported');
  assert.equal(broker.simulateOrder({ side: 'short', symbol: 'AAA', quantity: 1 }).reason, 'invalid_side');
  const fill = broker.simulateOrder({ side: 'buy', symbol: 'AAA', quantity: 5 });
  assert.equal(fill.status, 'simulated_fill');
  assert.equal(fill.simulated, true);
  assert.equal(fill.submittedToBroker, false);
  assert.equal(fill.price, 100.15005);
  assert.equal(broker.state().cash, 499.24975);
  assert.ok(broker.state().rejections.every(r => r.simulated && !r.submittedToBroker));
}

// 6. Execution gate: refused even with owner approval, because no executor exists in this version.
{
  const unapproved = requestLiveExecution({ kind: 'equity_order' });
  assert.equal(unapproved.ok, false);
  assert.equal(unapproved.policyDecision.reason, 'human_approval_required');
  const approved = requestLiveExecution({ kind: 'equity_order', approved: true });
  assert.equal(approved.ok, false);
  assert.equal(approved.sideEffect, false);
  assert.equal(approved.reason, 'live_execution_not_available_in_this_version');
  assert.equal(EXECUTION_STATUS.margin, 'forbidden');
  assert.equal(EXECUTION_STATUS.liveOrders, 'not_built');
}

// 7. Quant: known values.
assert.equal(maxDrawdown([100, 120, 90, 130]), -0.25);
{
  const snap = portfolioSnapshot({ positions: [{ symbol: 'A', quantity: 10, averageCost: 5 }, { symbol: 'B', quantity: 1, averageCost: null }], quotes: { A: { last: 10 } }, cash: 100 });
  assert.equal(snap.totalEquity, 200);
  assert.equal(snap.topWeight, 0.5);
  assert.deepEqual(snap.missingQuotes, ['B']);
  const stats = seriesStats([{ at: '1', close: 100 }, { at: '2', close: 110 }, { at: '3', close: 99 }]);
  assert.equal(stats.totalReturn, -0.01);
  assert.equal(stats.maxDrawdown, -0.1);
}

// 8. Full missions over JSON, SSE, and text-only tool results.
for (const [responseMode, structured] of [['json', true], ['sse', true], ['json', false]]) {
  const fixture = await startFixtureServer({ token: TOKEN, responseMode, structured });
  try {
    const client = createMcpClient({ endpoint: fixture.url, getAccessToken: async () => TOKEN });
    const gateway = createPermissionGateway({ client, reviewedAllowlist: FIXTURE_REVIEWED_ALLOWLIST, secretCanaries: [TOKEN] });
    const result = await runInvestmentMission({ gateway, provenance: 'synthetic-fixture', constraints: DEMO_CONSTRAINTS, missionId: `t_${responseMode}_${structured}` });
    assert.equal(result.ok, true, `${responseMode}/${structured}: ${result.verification?.problems}`);
    assert.equal(result.verification.truthLevel, 'verified');
    assert.equal(result.quant.data.snapshot.totalEquity, 56000);
    assert.deepEqual(result.simulation.data.paper.fills.map(f => `${f.side}:${f.symbol}`), ['buy:SCHD', 'sell:AAPL']);
    assert.deepEqual(result.risk.data.decisions.filter(d => !d.approvedForSimulation).map(d => d.order.symbol), ['NVDA', 'VTI']);
    assert.equal(result.simulation.data.liveExecution.status, 'refused');
    assert.ok(fixture.calls.every(call => READ_TOOLS.includes(call.name)), 'server log proves only read tools were called');
    const dangerous = FIXTURE_TOOLS.map(t => t.name).filter(n => !READ_TOOLS.includes(n));
    assert.ok(!fixture.calls.some(call => dangerous.includes(call.name)));
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(TOKEN), 'token never in output');
    assert.ok(!serialized.includes(FIXTURE_ACCOUNT_NUMBER), 'raw account number never in output');
    assert.match(result.report, /SYNTHETIC FIXTURE/);
    assert.match(result.report, /NOT INVESTMENT ADVICE/);
  } finally { await fixture.close(); }
}

// 9. Fail closed on unrecognized response shapes (e.g. a real server whose schema differs).
{
  let weirdBody = '';
  const weird = {
    endpointHost: 'stub', initialize: async () => ({ protocolVersion: '2025-11-25', serverInfo: { name: 'stub', version: '0' } }),
    listTools: async () => FIXTURE_TOOLS,
    callTool: async () => ({ content: [{ type: 'text', text: weirdBody }] })
  };
  for (const [body, problem] of [['Your account looks great!', 'accounts:tool_result_not_json'], ['{"unexpected":1}', 'accounts:accounts_shape_unrecognized']]) {
    weirdBody = body;
    const gateway = createPermissionGateway({ client: weird, reviewedAllowlist: FIXTURE_REVIEWED_ALLOWLIST });
    const result = await runInvestmentMission({ gateway, provenance: 'live-robinhood-mcp', missionId: 't_weird' });
    assert.equal(result.ok, false);
    assert.equal(result.stoppedAt, 'research');
    assert.ok(result.research.problems.includes(problem), result.research.problems.join());
  }
}

// 10. Verification catches tampering instead of trusting other agents.
{
  const fixture = await startFixtureServer({ token: TOKEN });
  try {
    const client = createMcpClient({ endpoint: fixture.url, getAccessToken: async () => TOKEN });
    const gateway = createPermissionGateway({ client, reviewedAllowlist: FIXTURE_REVIEWED_ALLOWLIST });
    const good = await runInvestmentMission({ gateway, provenance: 'synthetic-fixture', constraints: DEMO_CONSTRAINTS, missionId: 't_tamper' });
    const base = { missionId: 't_tamper', objective: 'verify', constraints: {} };
    const tamperedQuant = { ...good.quant.data, snapshot: { ...good.quant.data.snapshot, totalEquity: 99999 } };
    const forgedFill = { ...good.simulation.data.paper.fills[0], submittedToBroker: true };
    const tamperedSim = { ...good.simulation.data, paper: { ...good.simulation.data.paper, fills: [forgedFill, ...good.simulation.data.paper.fills.slice(1)] } };
    const v = await verificationAgent({ ...base, context: { dataset: good.research.data, quant: tamperedQuant, simulation: tamperedSim, discovery: good.discovery } }, { gateway });
    assert.equal(v.truthLevel, 'probable');
    assert.ok(v.problems.includes('equity_recomputed_independently'));
    assert.ok(v.problems.includes('all_trades_simulated_not_submitted'));
    const later = await verificationAgent({ ...base, context: { dataset: good.research.data, quant: good.quant.data, simulation: good.simulation.data, discovery: good.discovery } }, { gateway, now: () => Date.now() + 10 * 60_000 });
    assert.ok(later.problems.includes('quotes_fresh_per_source_timestamp'), 'stale quotes are caught');
  } finally { await fixture.close(); }
}

// 11. Static boundaries: only the client and gateway may call MCP tools; simulation cannot reach a broker.
{
  const dir = new URL('./', import.meta.url);
  // sdk-conformance-check.mjs is an opt-in harness that drives the official SDK client against the synthetic fixture.
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.endsWith('-test.mjs') && f !== 'sdk-conformance-check.mjs');
  for (const file of files) {
    const text = fs.readFileSync(new URL(file, dir), 'utf8');
    if (!['mcp-client.mjs', 'permission-gateway.mjs'].includes(file)) assert.ok(!/\.callTool\(/.test(text), `${file} must not call MCP tools directly`);
  }
  const broker = fs.readFileSync(new URL('paper-broker.mjs', dir), 'utf8');
  assert.ok(!/^import /m.test(broker), 'paper broker imports nothing');
  const agents = fs.readFileSync(new URL('agents.mjs', dir), 'utf8');
  assert.ok(!/mcp-client|fetch\(/.test(agents), 'agents have no transport access');
  assert.ok(!/process\.env/.test(fs.readFileSync(new URL('execution-gate.mjs', dir), 'utf8')), 'execution cannot be toggled by environment');
  assert.ok(!/process\.env|readFileSync|import\(/.test(fs.readFileSync(new URL('reviewed-allowlist.mjs', dir), 'utf8')), 'allowlist is code-reviewed data only');
  assert.equal(ROBINHOOD_REVIEWED_ALLOWLIST.length, 0, 'no Robinhood tool is authorized until an owner-controlled review is committed');
  assert.ok(Object.isFrozen(ROBINHOOD_REVIEWED_ALLOWLIST));
  for (const pinned of FIXTURE_REVIEWED_ALLOWLIST) assert.equal(fingerprintTool(FIXTURE_TOOLS.find(t => t.name === pinned.name)), pinned.fingerprint, `${pinned.name} pin matches fixture`);
}

// R4. A pull-request CI check must run the lab suites whenever lab code, its allowlist, or its workflow changes,
//     so an allowlist edit or a gateway regression cannot ride a PR whose required checks never run lab tests.
{
  const workflows = new URL('../../.github/workflows/', import.meta.url);
  const covering = fs.readdirSync(workflows).filter(f => /\.ya?ml$/.test(f)).map(f => fs.readFileSync(new URL(f, workflows), 'utf8'))
    .filter(text => /^\s*pull_request:/m.test(text) && /npm run test:investment-lab/.test(text) && /['"]?pi\/investment-lab\/\*\*['"]?/.test(text) && /package\.json/.test(text));
  assert.ok(covering.length >= 1, 'no pull_request workflow runs npm run test:investment-lab for pi/investment-lab/** changes');
}

// 12. Roles map onto the existing PI team.
for (const role of [...Object.values(AGENT_ROLES), 'Krishna', 'Durga']) assert.ok(getTeamRole(role), `${role} is a PI team role`);

// 13. Demo entry point runs and reports no leakage.
{
  const demo = await runFixtureDemo();
  assert.equal(demo.result.ok, true);
  const text = `${demo.outputs.report}${demo.outputs.json}`;
  assert.ok(!text.includes(FIXTURE_ACCOUNT_NUMBER), 'raw account number absent from rendered outputs');
  assert.ok(!/fixture-only-[0-9a-f]{24}/.test(text), 'token absent from rendered outputs');
  assert.deepEqual([...new Set(demo.serverCalls)].sort(), [...READ_TOOLS].sort());
}

// 15. Synthetic owner walkthrough: live access shown as disabled by the real entry point, zero network
//     attempts, synthetic provenance on every analysis line, simulated-only trades, no identifiers.
{
  const { runWalkthrough } = await import('./walkthrough.mjs');
  const walk = await runWalkthrough();
  assert.equal(walk.ok, true);
  assert.equal(walk.live.reason, 'no_reviewed_allowlist');
  assert.equal(walk.liveNetworkAttempts, 0);
  assert.match(walk.text, /LIVE ROBINHOOD ACCESS: DISABLED/);
  assert.match(walk.text, /SYNTHETIC FIXTURE/);
  assert.match(walk.text, /SIMULATED fill sim_1/);
  assert.match(walk.text, /BLOCKED by risk limits/);
  assert.match(walk.text, /quote \$229\.98 − 5 bps slippage/);
  for (const line of walk.text.split('\n').filter(l => / × \$/.test(l))) assert.match(line, /\[source: get_positions@.*get_quotes@.* · synthetic\]/);
  assert.ok(!walk.text.includes(FIXTURE_ACCOUNT_NUMBER));
  assert.ok(walk.serverCalls.every(name => READ_TOOLS.includes(name)));
}

// 14. Offline review aid drafts entries from a saved tools/list but never authorizes anything itself.
{
  const review = reviewToolsList({ tools: FIXTURE_TOOLS });
  for (const pinned of FIXTURE_REVIEWED_ALLOWLIST) {
    const row = review.find(item => item.name === pinned.name);
    assert.equal(row.draftEntry.fingerprint, pinned.fingerprint);
    assert.equal(row.draftEntry.status, 'DRAFT_REQUIRES_HUMAN_REVIEW_AGAINST_OFFICIAL_DOCS');
    assert.deepEqual(row.draftEntry.args, pinned.args);
    assert.equal(row.draftEntry.accountArg, pinned.accountArg);
  }
  for (const name of ['place_equity_order', 'transfer_funds', 'getQuoteAndPlaceOrder', 'get_order_history', 'enable_margin']) assert.equal(review.find(item => item.name === name).draftEntry, null, `${name} gets no draft`);
  assert.equal(ROBINHOOD_REVIEWED_ALLOWLIST.length, 0, 'review aid does not modify the allowlist');
}

console.log(JSON.stringify({ ok: true, suite: 'pi-investment-lab', readOnlyGateway: true, simulatedTradesOnly: true, executionRefused: true, transports: ['json', 'sse', 'text-only'] }));
