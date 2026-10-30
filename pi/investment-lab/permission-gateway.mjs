// PI Investment Lab — read-only permission gateway (Rama/Durga boundary).
// The ONLY component that holds the MCP client. Agents receive `inspect(capability, args, { accountRef })`
// and nothing else: no raw tool names, no arbitrary tool calls, no credentials,
// no real account identifiers, no free text from the broker.
//
// Authorization is an EXACT reviewed allowlist: a tool may be called only if a human-reviewed
// entry names it, its full definition (name, description, schemas, annotations) hashes to the
// pinned fingerprint, its input schema passes the order-shape audit, and its name is unique on the
// server. Tool names and server-supplied annotations can only DENY; they never authorize.

import crypto from 'node:crypto';
import { normalizeToolEvidence } from '../tool-evidence.mjs';

export const READ_CAPABILITIES = Object.freeze(['accounts', 'portfolio', 'positions', 'quotes', 'historicals']);

// Any of these tokens in a tool name blocks it, even if a reviewed entry names it.
export const DENY_TOKENS = Object.freeze(new Set([
  'order', 'orders', 'trade', 'trades', 'trading', 'buy', 'sell', 'place', 'submit', 'cancel', 'replace', 'modify',
  'transfer', 'transfers', 'deposit', 'deposits', 'withdraw', 'withdrawal', 'withdrawals', 'fund', 'funds', 'funding',
  'ach', 'wire', 'margin', 'borrow', 'lend', 'loan', 'card', 'spend', 'pay', 'payment', 'payments', 'approve', 'approval',
  'enable', 'disable', 'create', 'update', 'delete', 'remove', 'set', 'close', 'exercise', 'convert', 'stake', 'unstake',
  'send', 'execute', 'link', 'unlink', 'login', 'logout', 'auth', 'oauth', 'token', 'tokens', 'credential', 'credentials',
  'password', 'bank', 'recurring', 'invest', 'rebalance', 'liquidate', 'short', 'option', 'options'
]));
const READ_VERBS = new Set(['get', 'list', 'search', 'fetch', 'read', 'view', 'lookup', 'describe', 'show', 'query']);
const CAPABILITY_TOKENS = Object.freeze([
  ['positions', ['position', 'positions', 'holding', 'holdings']],
  ['quotes', ['quote', 'quotes']],
  ['historicals', ['historical', 'historicals', 'candles', 'bars']],
  ['portfolio', ['portfolio', 'portfolios', 'balance', 'balances', 'equity']],
  ['accounts', ['account', 'accounts']]
]);
// Order/transfer-shaped field names; refused anywhere in an input schema or in arguments.
export const FORBIDDEN_FIELD = /^(?:side|legs?|orders?|order_?(?:type|id)|qty|quantity|shares|notional|amount|dollars?|price|limit_?price|stop_?price|trail\w*|time_?in_?force|leverage|margin|destination|recipient|(?:to|from)_?account|bank\w*|ach\w*|wire\w*|confirm\w*|approve\w*|execute\w*)$/i;
// Tokens that make a field order/transfer-shaped even inside compound names (orderQuantity, limit_order_price).
const ORDER_FIELD_TOKENS = new Set(['side', 'order', 'orders', 'qty', 'quantity', 'shares', 'notional', 'amount', 'dollar', 'dollars', 'price',
  'stop', 'trail', 'trailing', 'leverage', 'margin', 'destination', 'recipient', 'bank', 'ach', 'wire', 'confirm', 'confirmation',
  'approve', 'approval', 'execute', 'transfer', 'deposit', 'withdraw', 'withdrawal', 'buy', 'sell']);
export function isOrderShapedField(name = '') {
  return FORBIDDEN_FIELD.test(name) || tokenizeToolName(name).some(token => ORDER_FIELD_TOKENS.has(token));
}
const SENSITIVE_KEYS = /token|secret|password|passwd|authorization|cookie|api[_-]?key|ssn|social|tax|routing|bank|email|phone|mobile|address|street|city|zip|postal|birth|dob|name|holder|owner|beneficiar|employer|memo|note|comment|message|description|text|url|uri|link|href/i;
const isIdKey = key => /(?:^|_)(?:id|uuid)$/.test(key.toLowerCase()) || /[a-z0-9](?:Id|ID|Uuid|UUID)$/.test(key);
// Keys are data too: only plain letter/underscore keys survive; anything else (digits, '@', '.') is dropped.
const SAFE_KEY = /^[A-Za-z][A-Za-z_]{0,47}$/;
const SYMBOL_KEYS = /^(?:symbol|ticker|instrument_?symbol)$/i;
const ENUM_KEYS = /^(?:type|account_?type|interval|span|bounds|currency|asset_?(?:type|class)|state|status)$/i;
const AMOUNT_KEYS = /(?:price|cash|equity|value|power|quantity|qty|shares|cost|limit|balance|close|open|high|low|volume|amount)$/i;
const ACCOUNT_KEYS = /^(?:account|account_?(?:number|num|no|id)|accountnumber|accountid|rhs_?account_?number)$/i;
const ARG_TYPES = new Set(['string', 'number', 'boolean']);
const SAFE_ARG_STRING = /^[A-Za-z0-9 ._,:\-]{0,200}$/;
const MAX_RESULT_CHARS = 1_000_000;
const MAX_DEPTH = 12;

// Value shapes the lab needs from broker data, chosen by key. Every other string is withheld from agents.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const DECIMAL = /^-?\d+\.\d+$/;
const SHORT_INTEGER = /^-?\d{1,6}$/;   // long bare integers elsewhere look like identifiers
const ANY_NUMBER = /^-?\d+(?:\.\d+)?$/;
const TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/; // same shape normalize.mjs accepts
const ENUM = /^[a-z][a-z_]{0,31}$/;
const REF = /^acct_ref_\d+$/;
export function safeValueForKey(key, value) {
  if (ISO_TIME.test(value) || DECIMAL.test(value) || SHORT_INTEGER.test(value) || REF.test(value)) return true;
  if (AMOUNT_KEYS.test(key) && ANY_NUMBER.test(value)) return true;
  if (SYMBOL_KEYS.test(key) && TICKER.test(value)) return true;
  if (ENUM_KEYS.test(key) && ENUM.test(value)) return true;
  return false;
}
const PII_PATTERNS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]'],
  [/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[REDACTED_PHONE]'],
  [/\b\d{7,}\b/g, '[REDACTED_NUMBER]'],
  [/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{6,}\b/g, '[REDACTED_ID]']
];

export function tokenizeToolName(name = '') {
  return String(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Heuristic screen. 'allow' here means only "not obviously a write tool"; it never authorizes a call.
export function classifyTool(tool = {}, { toolMap = {} } = {}) {
  const name = String(tool?.name || '');
  const tokens = tokenizeToolName(name);
  const annotations = tool?.annotations && typeof tool.annotations === 'object' ? tool.annotations : {};
  const denied = tokens.find(token => DENY_TOKENS.has(token));
  if (!name) return { name, decision: 'deny', reason: 'unnamed_tool', capability: null };
  if (denied) return { name, decision: 'deny', reason: `deny_token:${denied}`, capability: null };
  if (annotations.destructiveHint === true) return { name, decision: 'deny', reason: 'annotation_destructive', capability: null };
  if (annotations.readOnlyHint === false) return { name, decision: 'deny', reason: 'annotation_not_read_only', capability: null };
  const readIntent = READ_VERBS.has(tokens[0]) || annotations.readOnlyHint === true;
  if (!readIntent) return { name, decision: 'deny', reason: 'no_read_intent', capability: null };
  const mapped = Object.entries(toolMap).find(([, toolName]) => toolName === name)?.[0] || null;
  if (mapped && !READ_CAPABILITIES.includes(mapped)) return { name, decision: 'deny', reason: 'owner_map_unknown_capability', capability: null };
  const inferred = CAPABILITY_TOKENS.find(([, words]) => words.some(word => tokens.includes(word)))?.[0] || null;
  const capability = mapped || inferred;
  if (!capability) return { name, decision: 'deny', reason: 'not_in_read_capability_allowlist', capability: null };
  return { name, decision: 'allow', reason: mapped ? 'owner_mapped_read_tool' : 'inferred_read_tool', capability };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

// SHA-256 over the complete server-supplied definition. Any drift (description, schema, annotations) changes it.
export function fingerprintTool(tool = {}) {
  const { name, title, description, inputSchema, outputSchema, annotations } = tool || {};
  return crypto.createHash('sha256').update(canonical({ name, title, description, inputSchema, outputSchema, annotations })).digest('hex');
}

// Walk every property name a schema could accept, at any depth, through every combinator.
export function auditInputSchema(schema, entry) {
  const problems = [];
  const names = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 20) return;
    if (Array.isArray(node)) { node.forEach(item => walk(item, depth + 1)); return; }
    for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
      if (node[key] && typeof node[key] === 'object') {
        for (const [prop, sub] of Object.entries(node[key])) {
          if (key === 'properties' || key === 'patternProperties') names.add(prop);
          walk(sub, depth + 1);
        }
      }
    }
    for (const key of ['items', 'prefixItems', 'additionalProperties', 'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'contains']) walk(node[key], depth + 1);
  };
  walk(schema, 0);
  for (const name of names) if (isOrderShapedField(name)) problems.push(`schema_forbidden_field:${name}`);
  const declared = new Set(Object.keys(schema?.properties || {}));
  const reviewed = [...Object.keys(entry?.args || {}), ...(entry?.accountArg ? [entry.accountArg] : [])];
  for (const arg of reviewed) if (!declared.has(arg)) problems.push(`reviewed_arg_not_in_schema:${arg}`);
  for (const [arg, sub] of Object.entries(schema?.properties || {})) {
    if (reviewed.includes(arg) && sub && typeof sub === 'object' && sub.type && !ARG_TYPES.has(sub.type)) problems.push(`reviewed_arg_not_primitive:${arg}`);
  }
  return { ok: problems.length === 0, problems };
}

// Digest an owner must present to run live: binds approval to exactly this reviewed list and endpoint,
// so any later edit to the list (or endpoint) invalidates the approval instead of silently taking effect.
export function allowlistDigest(list = [], endpoint = '') {
  const entries = validateReviewedAllowlist(list).map(entry => ({ ...entry, args: { ...entry.args } }));
  return crypto.createHash('sha256').update(canonical({ schema: 'pi.investment-lab.allowlist.v1', endpoint, entries })).digest('hex');
}

export function validateReviewedAllowlist(list = []) {
  if (!Array.isArray(list)) throw new Error('reviewed_allowlist_must_be_array');
  const names = new Set();
  const capabilities = new Set();
  return Object.freeze(list.map((raw, index) => {
    const entry = raw || {};
    if (!READ_CAPABILITIES.includes(entry.capability)) throw new Error(`reviewed_allowlist_${index}_capability`);
    if (typeof entry.name !== 'string' || !/^[A-Za-z0-9_.\-]{1,64}$/.test(entry.name)) throw new Error(`reviewed_allowlist_${index}_name`);
    if (!/^[0-9a-f]{64}$/.test(String(entry.fingerprint))) throw new Error(`reviewed_allowlist_${index}_fingerprint`);
    if (names.has(entry.name) || capabilities.has(entry.capability)) throw new Error(`reviewed_allowlist_${index}_duplicate`);
    const args = entry.args && typeof entry.args === 'object' && !Array.isArray(entry.args) ? entry.args : {};
    for (const [arg, type] of Object.entries(args)) {
      if (!ARG_TYPES.has(type) || isOrderShapedField(arg) || ACCOUNT_KEYS.test(arg)) throw new Error(`reviewed_allowlist_${index}_arg:${arg}`);
    }
    if (entry.accountArg !== null && entry.accountArg !== undefined && (typeof entry.accountArg !== 'string' || isOrderShapedField(entry.accountArg))) throw new Error(`reviewed_allowlist_${index}_accountArg`);
    names.add(entry.name);
    capabilities.add(entry.capability);
    return Object.freeze({ capability: entry.capability, name: entry.name, fingerprint: entry.fingerprint, args: Object.freeze({ ...args }), accountArg: entry.accountArg || null });
  }));
}

function depthOf(value, depth = 0) {
  if (depth > MAX_DEPTH) return depth;
  if (!value || typeof value !== 'object') return depth;
  let max = depth;
  for (const inner of Array.isArray(value) ? value : Object.values(value)) max = Math.max(max, depthOf(inner, depth + 1));
  return max;
}

function extractPayload(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { ok: false, reason: 'tool_result_not_object' };
  if (result.isError) return { ok: false, reason: 'tool_reported_error' };
  if (result.structuredContent !== undefined) {
    const sc = result.structuredContent;
    if (!sc || typeof sc !== 'object' || Array.isArray(sc)) return { ok: false, reason: 'structured_content_not_object' };
    if (JSON.stringify(sc).length > MAX_RESULT_CHARS) return { ok: false, reason: 'tool_result_too_large' };
    if (depthOf(sc) > MAX_DEPTH) return { ok: false, reason: 'tool_result_too_deep' };
    return { ok: true, data: sc };
  }
  const texts = (Array.isArray(result.content) ? result.content : []).filter(item => item?.type === 'text').map(item => String(item.text || ''));
  const joined = texts.join('\n');
  if (joined.length > MAX_RESULT_CHARS) return { ok: false, reason: 'tool_result_too_large' };
  let data;
  try { data = JSON.parse(joined); } catch { return { ok: false, reason: 'tool_result_not_json' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'tool_result_not_json_object' };
  if (depthOf(data) > MAX_DEPTH) return { ok: false, reason: 'tool_result_too_deep' };
  return { ok: true, data };
}

// Redacts free text for output/report surfaces (not broker payloads, which are shape-filtered instead).
export function redactText(value, { canaries = [] } = {}) {
  let out = String(value);
  for (const canary of canaries) if (typeof canary === 'string' && canary.length >= 8) out = out.split(canary).join('[REDACTED]');
  for (const [pattern, label] of PII_PATTERNS) out = out.replace(pattern, label);
  return out;
}

export function safeLabel(value, { canaries = [], max = 64 } = {}) {
  const text = redactText(String(value ?? ''), { canaries }).slice(0, max);
  return /^[A-Za-z0-9 ._:\-\[\]]+$/.test(text) ? text : '[REDACTED_TEXT]';
}

export function createPermissionGateway({ client, reviewedAllowlist = [], maxCalls = 50, secretCanaries = [], now = () => Date.now() } = {}) {
  if (!client || typeof client.callTool !== 'function') throw new Error('mcp_client_required');
  const reviewed = validateReviewedAllowlist(reviewedAllowlist);
  const routes = new Map();
  const accountRefs = new Map();
  const refToAccount = new Map();
  const audit = [];
  let discovery = null;
  let calls = 0;
  const canaries = secretCanaries.filter(value => typeof value === 'string' && value.length >= 8);

  function refFor(value) {
    const raw = String(value);
    if (!accountRefs.has(raw)) {
      const ref = `acct_ref_${accountRefs.size + 1}`;
      accountRefs.set(raw, ref);
      refToAccount.set(ref, raw);
    }
    return accountRefs.get(raw);
  }

  function safeString(value, key) {
    if (canaries.some(canary => value.includes(canary))) return '[REDACTED]';
    return safeValueForKey(key, value) ? value : '[REDACTED_TEXT]';
  }

  // `key` is the nearest enclosing object key (array items inherit it), so shapes are judged in context.
  function sanitize(value, depth = 0, key = '') {
    if (depth > MAX_DEPTH) return '[TRUNCATED]';
    if (Array.isArray(value)) return value.slice(0, 1000).map(item => sanitize(item, depth + 1, key));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [innerKey, inner] of Object.entries(value)) {
        if (!SAFE_KEY.test(innerKey)) continue;
        if (ACCOUNT_KEYS.test(innerKey) && (typeof inner === 'string' || typeof inner === 'number')) out[innerKey] = refFor(inner);
        else if (SENSITIVE_KEYS.test(innerKey) || isIdKey(innerKey)) out[innerKey] = '[REDACTED]';
        else out[innerKey] = sanitize(inner, depth + 1, innerKey);
      }
      return out;
    }
    if (typeof value === 'string') return safeString(value, key);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    return null;
  }

  function translateArgs(entry, args, accountRef) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, reason: 'args_must_be_object' };
    const out = {};
    for (const [key, value] of Object.entries(args)) {
      if (isOrderShapedField(key)) return { ok: false, reason: `forbidden_arg:${key}` };
      if (ACCOUNT_KEYS.test(key) || key === entry.accountArg) return { ok: false, reason: 'account_must_use_accountRef' };
      const type = entry.args[key];
      if (!type) return { ok: false, reason: `unreviewed_arg:${key}` };
      if (typeof value !== type) return { ok: false, reason: `arg_type:${key}` };
      if (type === 'string' && !SAFE_ARG_STRING.test(value)) return { ok: false, reason: `arg_value:${key}` };
      if (type === 'number' && !Number.isFinite(value)) return { ok: false, reason: `arg_value:${key}` };
      out[key] = value;
    }
    if (accountRef !== undefined && accountRef !== null) {
      if (!entry.accountArg) return { ok: false, reason: 'tool_takes_no_account' };
      if (!refToAccount.has(accountRef)) return { ok: false, reason: 'unknown_account_ref' };
      out[entry.accountArg] = refToAccount.get(accountRef);
    }
    return { ok: true, args: out };
  }

  function record(entry) {
    const frozen = Object.freeze({ seq: audit.length + 1, at: new Date(now()).toISOString(), ...entry });
    audit.push(frozen);
    return frozen;
  }

  const deny = (capability, reason, extra = {}) => ({ ok: false, reason, entry: record({ type: 'inspect', capability: safeLabel(capability), decision: 'deny', reason, ...extra }) });

  return Object.freeze({
    async connect() {
      // Each discovery fully replaces the last: no route survives a re-listing that no longer allows it.
      routes.clear();
      discovery = null;
      const session = await client.initialize();
      const tools = await client.listTools();
      const counts = new Map();
      for (const tool of tools) {
        const key = String(tool?.name || '').normalize('NFKC').toLowerCase();
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const classified = tools.map(tool => {
        const name = String(tool?.name || '');
        const label = /^[A-Za-z0-9_.\-]{1,64}$/.test(name) ? name : '[invalid-tool-name]';
        const fingerprint = fingerprintTool(tool);
        const verdict = reason => Object.freeze({ name: label, decision: 'deny', reason, capability: null, fingerprint });
        if ((counts.get(name.normalize('NFKC').toLowerCase()) || 0) > 1) return verdict('duplicate_tool_name');
        const screen = classifyTool(tool);
        if (screen.decision === 'deny' && screen.reason !== 'not_in_read_capability_allowlist' && screen.reason !== 'no_read_intent') return verdict(screen.reason);
        const entry = reviewed.find(item => item.name === name);
        if (!entry) return verdict('not_in_reviewed_allowlist');
        if (entry.fingerprint !== fingerprint) return verdict('fingerprint_mismatch');
        const schema = auditInputSchema(tool.inputSchema, entry);
        if (!schema.ok) return verdict(schema.problems[0]);
        return Object.freeze({ name: label, decision: 'allow', reason: 'reviewed_exact_match', capability: entry.capability, fingerprint });
      });
      for (const item of classified) {
        if (item.decision === 'allow') routes.set(item.capability, reviewed.find(entry => entry.name === item.name));
      }
      discovery = Object.freeze({
        server: Object.freeze({ name: safeLabel(session?.serverInfo?.name, { canaries }), version: safeLabel(session?.serverInfo?.version, { canaries, max: 32 }) }),
        protocolVersion: session.protocolVersion,
        endpointHost: client.endpointHost,
        reviewedEntries: reviewed.length,
        tools: classified,
        routes: Object.freeze(Object.fromEntries([...routes].map(([capability, entry]) => [capability, entry.name])))
      });
      record({ type: 'discovery', decision: 'info', toolsSeen: tools.length, toolsAllowed: routes.size, reviewedEntries: reviewed.length });
      return discovery;
    },
    discovery() { return discovery; },
    // Yes/no check for output guards: reports whether text contains any raw account identifier this
    // gateway has seen, without ever returning the identifiers themselves.
    containsKnownIdentifier(text) {
      const haystack = String(text);
      for (const raw of accountRefs.keys()) if (raw.length >= 4 && haystack.includes(raw)) return true;
      return false;
    },
    capabilities() { return [...routes.keys()]; },
    auditLog() { return audit.map(entry => ({ ...entry })); },
    async inspect(capability, args = {}, { accountRef = null } = {}) {
      const started = now();
      if (!discovery) return deny(capability, 'gateway_not_connected');
      if (!READ_CAPABILITIES.includes(capability)) return deny(capability, 'capability_not_allowed');
      const entry = routes.get(capability);
      if (!entry) return deny(capability, 'no_reviewed_tool_for_capability');
      if (calls >= maxCalls) return deny(capability, 'call_budget_exhausted', { tool: entry.name });
      const translated = translateArgs(entry, args, accountRef);
      if (!translated.ok) return deny(capability, translated.reason, { tool: entry.name });
      calls += 1;
      let payload;
      try {
        payload = extractPayload(await client.callTool(entry.name, translated.args));
      } catch (error) {
        const reason = `transport:${error?.code || 'unknown'}`;
        return { ok: false, reason, entry: record({ type: 'inspect', capability, tool: entry.name, decision: 'allow', ok: false, reason, latencyMs: now() - started }) };
      }
      if (!payload.ok) return { ok: false, reason: payload.reason, entry: record({ type: 'inspect', capability, tool: entry.name, decision: 'allow', ok: false, reason: payload.reason, latencyMs: now() - started }) };
      const data = sanitize(payload.data);
      const observedAt = new Date(now()).toISOString();
      const evidence = normalizeToolEvidence({ tool: entry.name, result: data, observedAt, confidence: 'probable', limitations: ['source-reported by MCP server; not independently audited'] });
      const logged = record({ type: 'inspect', capability, tool: entry.name, decision: 'allow', ok: true, argKeys: Object.keys(translated.args).map(key => (key === entry.accountArg ? 'accountRef' : key)), latencyMs: now() - started });
      return { ok: true, capability, tool: entry.name, data, observedAt, evidence, entry: logged };
    }
  });
}
