#!/usr/bin/env node
// PI Investment Lab — end-to-end read-only demonstration.
//
//   node pi/investment-lab/demo.mjs [--out DIR]          offline: synthetic MCP fixture over loopback HTTP
//   node pi/investment-lab/demo.mjs --review-tools FILE  offline: draft allowlist review of an owner-saved tools/list JSON
//   node pi/investment-lab/demo.mjs --allowlist-digest   offline: digest of the reviewed Robinhood allowlist
//   node pi/investment-lab/demo.mjs --live --approve-allowlist DIGEST --out DIR
//                                                        live read-only inspection — REFUSES while the reviewed
//                                                        Robinhood allowlist is empty (it is, in this version),
//                                                        and whenever DIGEST does not match the current list
//
// The live path never logs in, never stores or prints the token, and never sends proposed orders anywhere.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createMcpClient } from './mcp-client.mjs';
import { createPermissionGateway, classifyTool, fingerprintTool, auditInputSchema, safeLabel, isOrderShapedField, allowlistDigest } from './permission-gateway.mjs';
import { runInvestmentMission } from './orchestrator.mjs';
import { startFixtureServer, FIXTURE_ACCOUNT_NUMBER } from './fixture-mcp-server.mjs';
import { ROBINHOOD_REVIEWED_ALLOWLIST, FIXTURE_REVIEWED_ALLOWLIST } from './reviewed-allowlist.mjs';

export const LIVE_ENDPOINT = 'https://agent.robinhood.com/mcp/trading';
const REPO_ROOT = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));

// Resolves symlinks for the deepest existing ancestor so a symlinked or not-yet-created --out
// cannot disguise a location inside the repository.
function realTarget(target) {
  let existing = path.resolve(target);
  const rest = [];
  while (!fs.existsSync(existing)) {
    rest.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...rest);
}

export const DEMO_CONSTRAINTS = Object.freeze({
  watchlist: ['SCHD'],
  proposedOrders: [
    { side: 'buy', symbol: 'SCHD', quantity: 10, type: 'market' },
    { side: 'sell', symbol: 'AAPL', quantity: 5, type: 'market' },
    { side: 'buy', symbol: 'NVDA', quantity: 20, type: 'market' },
    { side: 'buy', symbol: 'VTI', quantity: 1000, type: 'market' }
  ],
  requestLiveExecution: true,
  ownerApproval: true
});

const OUTPUT_LEAK_PATTERNS = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['ssn', /\b\d{3}-\d{2}-\d{4}\b/],
  ['phone', /\(\d{3}\)\s?\d{3}[\s.-]\d{4}|\b\d{3}[.-]\d{3}[.-]\d{4}\b/],
  ['long_number', /\b\d{9,}\b/],
  ['bearer', /bearer\s+[A-Za-z0-9._~+\/-]{8,}/i]
];

// Allowlisted projection of a mission result: nothing from raw tool payloads or evidence claims.
function projectRun(result) {
  const pick = agent => (agent ? { status: agent.status, truthLevel: agent.truthLevel, failureClass: agent.failureClass, problems: agent.problems, result: agent === result.research || agent === result.verification ? agent.result : undefined } : null);
  return {
    schema: 'pi.investment-lab.run.v2',
    missionId: result.missionId,
    provenance: result.provenance,
    ok: result.ok,
    stoppedAt: result.stoppedAt || null,
    executionStatus: result.executionStatus,
    discovery: result.discovery && {
      server: result.discovery.server,
      protocolVersion: result.discovery.protocolVersion,
      endpointHost: result.discovery.endpointHost,
      reviewedEntries: result.discovery.reviewedEntries,
      tools: result.discovery.tools.map(({ name, decision, reason, capability }) => ({ name, decision, reason: safeLabel(reason), capability })),
      routes: result.discovery.routes
    },
    research: pick(result.research),
    quant: result.quant && { ...pick(result.quant), data: result.quant.data },
    risk: result.risk && { ...pick(result.risk), data: result.risk.data },
    simulation: result.simulation && { ...pick(result.simulation), data: result.simulation.data },
    verification: result.verification && { ...pick(result.verification), data: result.verification.data },
    audit: result.audit,
    trace: result.trace
  };
}

export function scanForLeaks(text, { canaries = [], rawIdentifiers = [] } = {}) {
  const hits = [];
  for (const value of [...canaries, ...rawIdentifiers]) if (typeof value === 'string' && value.length >= 4 && text.includes(value)) hits.push('known_secret_or_identifier');
  for (const [name, pattern] of OUTPUT_LEAK_PATTERNS) if (pattern.test(text)) hits.push(name);
  return [...new Set(hits)];
}

// Renders report + JSON and refuses (throws) if either contains a token, raw identifier, or PII pattern.
export function renderOutputs(result, { canaries = [], rawIdentifiers = [], containsIdentifier = null, extra = {} } = {}) {
  const report = `${result.report || `Mission stopped at ${result.stoppedAt || 'unknown'}; no report rendered.`}\n`;
  const json = `${JSON.stringify({ ...projectRun(result), ...extra }, null, 2)}\n`;
  const hits = scanForLeaks(`${report}\n${json}`, { canaries, rawIdentifiers });
  if (typeof containsIdentifier === 'function' && containsIdentifier(`${report}\n${json}`)) hits.push('gateway_known_identifier');
  if (hits.length) {
    const error = new Error('output_leak_detected');
    error.code = 'output_leak_detected';
    error.detail = hits;
    throw error;
  }
  return { report, json };
}

export function writeOutputs(outDir, outputs, { provenance }) {
  const target = realTarget(outDir);
  if (provenance !== 'synthetic-fixture' && (target === REPO_ROOT || target.startsWith(`${REPO_ROOT}${path.sep}`))) {
    throw Object.assign(new Error('live_output_inside_repository_refused'), { code: 'live_output_inside_repository_refused' });
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const reportPath = path.join(target, 'investment-lab-report.md');
  const jsonPath = path.join(target, 'investment-lab-run.json');
  fs.writeFileSync(reportPath, outputs.report, { mode: 0o600 });
  fs.writeFileSync(jsonPath, outputs.json, { mode: 0o600 });
  for (const file of [reportPath, jsonPath]) fs.chmodSync(file, 0o600); // mode above only applies to newly created files
  return { reportPath, jsonPath };
}

// `now` pins a synthetic clock for the fixture server, gateway and mission (default: wall clock).
export async function runFixtureDemo({ outDir = null, responseMode = 'json', now = () => Date.now() } = {}) {
  const token = `fixture-only-${crypto.randomBytes(12).toString('hex')}`;
  const fixture = await startFixtureServer({ token, responseMode, now });
  try {
    const client = createMcpClient({ endpoint: fixture.url, getAccessToken: async () => token });
    const gateway = createPermissionGateway({ client, reviewedAllowlist: FIXTURE_REVIEWED_ALLOWLIST, secretCanaries: [token], now });
    const result = await runInvestmentMission({ gateway, provenance: 'synthetic-fixture', constraints: DEMO_CONSTRAINTS, missionId: `lab_demo_${now()}`, now });
    const serverCalls = fixture.calls.map(call => call.name);
    // renderOutputs throws if the token, the raw fixture account number, or any identifier the gateway saw appears.
    const outputs = renderOutputs(result, { canaries: [token], rawIdentifiers: [FIXTURE_ACCOUNT_NUMBER], containsIdentifier: gateway.containsKnownIdentifier, extra: { demoEvidence: { serverCalls } } });
    const files = outDir ? writeOutputs(outDir, outputs, { provenance: 'synthetic-fixture' }) : null;
    return { result, outputs, serverCalls, files };
  } finally {
    await fixture.close();
  }
}

export const currentLiveAllowlistDigest = () => allowlistDigest(ROBINHOOD_REVIEWED_ALLOWLIST, LIVE_ENDPOINT);

// Live read-only path. Fails closed before ANY network I/O unless the reviewed allowlist is non-empty AND
// the operator presents the digest of exactly that list (printed by --allowlist-digest after review).
export async function runLive({ env = process.env, fetchImpl = globalThis.fetch, outDir = null, approvedDigest = null } = {}) {
  if (!ROBINHOOD_REVIEWED_ALLOWLIST.length) {
    return { ok: false, reason: 'no_reviewed_allowlist', detail: 'ROBINHOOD_REVIEWED_ALLOWLIST is empty; complete the owner-controlled review in PI_INVESTMENT_LAB.md first.' };
  }
  if (!approvedDigest) return { ok: false, reason: 'owner_allowlist_digest_required' };
  if (approvedDigest !== currentLiveAllowlistDigest()) return { ok: false, reason: 'owner_allowlist_digest_mismatch' };
  const token = env.ROBINHOOD_MCP_ACCESS_TOKEN;
  if (!token) return { ok: false, reason: 'token_not_supplied' };
  if (!outDir) return { ok: false, reason: 'out_dir_required_outside_repository' };
  const client = createMcpClient({ endpoint: LIVE_ENDPOINT, getAccessToken: async () => token, fetchImpl });
  const gateway = createPermissionGateway({ client, reviewedAllowlist: ROBINHOOD_REVIEWED_ALLOWLIST, secretCanaries: [token] });
  const result = await runInvestmentMission({ gateway, provenance: 'live-robinhood-mcp', constraints: { watchlist: [], proposedOrders: [] } });
  const outputs = renderOutputs(result, { canaries: [token], containsIdentifier: gateway.containsKnownIdentifier });
  const files = writeOutputs(outDir, outputs, { provenance: 'live-robinhood-mcp' });
  return { ok: result.ok, files, stoppedAt: result.stoppedAt || null };
}

// Offline review aid: reads a tools/list result the OWNER saved, prints fingerprints, screens and
// DRAFT entries. It never edits reviewed-allowlist.mjs; a human must review and commit any entry.
export function reviewToolsList(listing) {
  const tools = Array.isArray(listing) ? listing : Array.isArray(listing?.tools) ? listing.tools : Array.isArray(listing?.result?.tools) ? listing.result.tools : [];
  return tools.map(tool => {
    const screen = classifyTool(tool);
    const properties = tool?.inputSchema?.properties || {};
    const primitive = Object.entries(properties).filter(([, sub]) => ['string', 'number', 'boolean'].includes(sub?.type));
    const args = Object.fromEntries(primitive.filter(([name]) => !/account/i.test(name) && !isOrderShapedField(name)).map(([name, sub]) => [name, sub.type]));
    const accountArg = primitive.map(([name]) => name).find(name => /account/i.test(name)) || null;
    const draft = { capability: screen.capability, name: String(tool?.name || ''), fingerprint: fingerprintTool(tool), args, accountArg };
    const audit = auditInputSchema(tool?.inputSchema, draft);
    return {
      name: safeLabel(tool?.name),
      fingerprint: draft.fingerprint,
      screen: `${screen.decision}:${screen.reason}`,
      schemaAudit: audit.ok ? 'ok' : audit.problems,
      draftEntry: screen.decision === 'allow' && audit.ok ? { ...draft, status: 'DRAFT_REQUIRES_HUMAN_REVIEW_AGAINST_OFFICIAL_DOCS' } : null
    };
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const arg = name => { const index = process.argv.indexOf(name); return index === -1 ? null : process.argv[index + 1]; };
  const outDir = arg('--out');
  try {
    if (process.argv.includes('--probe')) {
      console.log(JSON.stringify({ ok: false, reason: 'probe_removed_lab_is_offline_until_reviewed_allowlist' }));
      process.exitCode = 1;
    } else if (process.argv.includes('--allowlist-digest')) {
      console.log(JSON.stringify({ entries: ROBINHOOD_REVIEWED_ALLOWLIST.length, endpoint: LIVE_ENDPOINT, digest: currentLiveAllowlistDigest() }, null, 2));
    } else if (process.argv.includes('--review-tools')) {
      console.log(JSON.stringify(reviewToolsList(JSON.parse(fs.readFileSync(arg('--review-tools'), 'utf8'))), null, 2));
    } else if (process.argv.includes('--live')) {
      const out = await runLive({ outDir, approvedDigest: arg('--approve-allowlist') });
      console.log(JSON.stringify(out, null, 2));
      if (!out.ok) process.exitCode = 1;
    } else {
      const { result, outputs, serverCalls, files } = await runFixtureDemo({ outDir });
      console.log(outputs.report);
      console.log('---');
      console.log(JSON.stringify({ ok: result.ok, provenance: result.provenance, verification: result.verification.result, serverCalls, outputGuard: 'passed', trace: result.trace, files }, null, 2));
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error?.code || 'error', detail: Array.isArray(error?.detail) ? error.detail : undefined }));
    process.exitCode = 1;
  }
}
