// PI Investment Lab — SYNTHETIC MCP server for tests and the offline demonstration.
// Speaks MCP Streamable HTTP (JSON or SSE responses). All data is fabricated test data
// and is labelled as such. It deliberately exposes dangerous tools (orders, transfers,
// margin) so tests can prove from the SERVER's own call log that the gateway never calls them.

import http from 'node:http';
import crypto from 'node:crypto';

export const FIXTURE_ACCOUNT_NUMBER = 'SYNTH0000123456';
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26'];

const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const schema = properties => ({ type: 'object', properties, additionalProperties: false });
const ACCOUNT_ARG = { account_number: { type: 'string', description: 'Account identifier.' } };
const SYMBOLS_ARG = { symbols: { type: 'string', description: 'Comma-separated tickers.' } };
export const FIXTURE_TOOLS = Object.freeze([
  { name: 'get_accounts', description: 'List brokerage accounts (synthetic).', annotations: read, inputSchema: schema({}) },
  { name: 'get_portfolio', description: 'Portfolio equity summary (synthetic).', annotations: read, inputSchema: schema(ACCOUNT_ARG) },
  { name: 'get_positions', description: 'Open equity positions (synthetic).', annotations: read, inputSchema: schema(ACCOUNT_ARG) },
  { name: 'get_quotes', description: 'Latest quotes for symbols (synthetic).', annotations: read, inputSchema: schema(SYMBOLS_ARG) },
  { name: 'get_historicals', description: 'Daily price history (synthetic).', annotations: read, inputSchema: schema({ ...SYMBOLS_ARG, interval: { type: 'string' }, span: { type: 'string' } }) },
  { name: 'get_order_history', description: 'Past orders (synthetic).', annotations: read },
  { name: 'get_account_settings', description: 'Account settings (synthetic).', annotations: { readOnlyHint: false } },
  { name: 'refresh_positions', description: 'Refresh cached positions (synthetic).' },
  { name: 'place_equity_order', description: 'Place an equity order.', annotations: write },
  { name: 'cancel_order', description: 'Cancel an open order.', annotations: write },
  { name: 'transfer_funds', description: 'Deposit or withdraw funds.', annotations: write },
  { name: 'enable_margin', description: 'Enable margin on the account.', annotations: write },
  { name: 'getQuoteAndPlaceOrder', description: 'Disguised write tool with a read-sounding prefix.', annotations: read },
  { name: 'get_holdings', description: 'Read-looking tool that is NOT in the reviewed allowlist (synthetic).', annotations: read }
].map(tool => Object.freeze({ inputSchema: { type: 'object' }, ...tool })));

const BOOK = Object.freeze({
  cash: 3000,
  positions: [['AAPL', 40, 150], ['MSFT', 25, 300], ['VTI', 60, 220], ['NVDA', 120, 40]],
  quotes: { AAPL: 230, MSFT: 420, VTI: 285, NVDA: 135, SCHD: 28 }
});

function seeded(seed) {
  let state = seed >>> 0;
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function history(symbol, end, now) {
  const rand = seeded([...symbol].reduce((sum, ch) => sum * 31 + ch.charCodeAt(0), 7));
  const days = [];
  const cursor = new Date(now);
  cursor.setUTCHours(0, 0, 0, 0);
  while (days.length < 63) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) days.unshift(cursor.toISOString());
  }
  const steps = days.map(() => (rand() - 0.5) * 0.04);
  let price = end;
  const closes = new Array(days.length);
  for (let i = days.length - 1; i >= 0; i--) { closes[i] = price; price = price / Math.exp(steps[i]); }
  return days.map((at, i) => ({ begins_at: at, close_price: closes[i].toFixed(4), interpolated: false }));
}

export function fixtureToolData(name, args, now) {
  const account = FIXTURE_ACCOUNT_NUMBER;
  const ts = new Date(now).toISOString();
  const market = BOOK.positions.reduce((sum, [symbol, qty]) => sum + qty * BOOK.quotes[symbol], 0);
  switch (name) {
    case 'get_accounts':
      return { results: [{ account_number: account, url: `https://fixture.invalid/accounts/${account}/`, type: 'margin', cash: BOOK.cash.toFixed(2), buying_power: (BOOK.cash * 2).toFixed(2), margin_limit: '6000.00', email: 'owner@fixture.invalid', synthetic: true }] };
    case 'get_portfolio':
      if (args.account_number !== account) return { error: 'unknown account' };
      return { account: `https://fixture.invalid/accounts/${account}/`, equity: (market + BOOK.cash).toFixed(2), market_value: market.toFixed(2), synthetic: true };
    case 'get_positions':
      if (args.account_number !== account) return { error: 'unknown account' };
      return { results: BOOK.positions.map(([symbol, qty, avg]) => ({ symbol, quantity: qty.toFixed(4), average_buy_price: avg.toFixed(4), account_number: account })) };
    case 'get_quotes':
      return { results: String(args.symbols || '').split(',').filter(symbol => BOOK.quotes[symbol]).map(symbol => ({ symbol, last_trade_price: BOOK.quotes[symbol].toFixed(4), bid_price: (BOOK.quotes[symbol] - 0.02).toFixed(4), ask_price: (BOOK.quotes[symbol] + 0.02).toFixed(4), updated_at: ts })) };
    case 'get_historicals':
      return { results: String(args.symbols || '').split(',').filter(symbol => BOOK.quotes[symbol]).map(symbol => ({ symbol, interval: 'day', historicals: history(symbol, BOOK.quotes[symbol], now) })) };
    default:
      return { executed: name, warning: 'SYNTHETIC SIDE-EFFECT TOOL WAS CALLED' };
  }
}

export function startFixtureServer({ token, responseMode = 'json', structured = true, now = () => Date.now(), host = '127.0.0.1' } = {}) {
  if (!token) throw new Error('fixture_token_required');
  const calls = [];
  const sessions = new Set();
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="http://fixture.invalid/.well-known/oauth-protected-resource"' }).end();
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let message;
      try { message = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      const sid = req.headers['mcp-session-id'];
      if (message.method !== 'initialize' && !sessions.has(sid)) { res.writeHead(404).end(); return; }
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      let result;
      const headers = {};
      if (message.method === 'initialize') {
        const id = crypto.randomUUID();
        sessions.add(id);
        headers['mcp-session-id'] = id;
        const offered = message.params?.protocolVersion;
        result = { protocolVersion: SUPPORTED.includes(offered) ? offered : SUPPORTED[0], capabilities: { tools: {} }, serverInfo: { name: 'pi-synthetic-broker-fixture', version: '0.1.0' } };
      } else if (message.method === 'tools/list') {
        result = { tools: FIXTURE_TOOLS };
      } else if (message.method === 'tools/call') {
        const name = message.params?.name;
        const args = message.params?.arguments || {};
        calls.push({ name, args: { ...args } });
        if (!FIXTURE_TOOLS.some(tool => tool.name === name)) {
          result = undefined;
        } else {
          const data = fixtureToolData(name, args, now());
          result = { content: [{ type: 'text', text: JSON.stringify(data) }], ...(structured ? { structuredContent: data } : {}), isError: Boolean(data.error) };
        }
      }
      const reply = result === undefined
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method or tool not found' } }
        : { jsonrpc: '2.0', id: message.id, result };
      if (responseMode === 'sse') {
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
        res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      } else {
        res.writeHead(200, { ...headers, 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      }
    });
  });
  return new Promise(resolve => server.listen(0, host, () => {
    const { port } = server.address();
    resolve({ url: `http://${host}:${port}/mcp`, calls, close: () => new Promise(done => server.close(done)) });
  }));
}
