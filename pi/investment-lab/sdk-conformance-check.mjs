// Optional cross-check against the official MCP TypeScript SDK (not a repo dependency).
//   npm install --prefix /some/dir @modelcontextprotocol/sdk zod
//   MCP_SDK_DIR=/some/dir/node_modules/@modelcontextprotocol/sdk node pi/investment-lab/sdk-conformance-check.mjs
// 1) PI's client + gateway against an SDK McpServer (JSON and SSE responses).
// 2) The SDK Client against PI's synthetic fixture server.

import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMcpClient } from './mcp-client.mjs';
import { createPermissionGateway, fingerprintTool } from './permission-gateway.mjs';
import { startFixtureServer } from './fixture-mcp-server.mjs';

const dir = process.env.MCP_SDK_DIR;
if (!dir) {
  console.log(JSON.stringify({ ok: true, skipped: 'MCP_SDK_DIR not set' }));
  process.exit(0);
}
const sdk = file => import(pathToFileURL(path.join(dir, 'dist/esm', file)).href);
const { McpServer } = await sdk('server/mcp.js');
const { StreamableHTTPServerTransport } = await sdk('server/streamableHttp.js');
const { Client } = await sdk('client/index.js');
const { StreamableHTTPClientTransport } = await sdk('client/streamableHttp.js');
const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(dir, 'package.json'), 'utf8'));
const results = { sdkVersion: pkg.version };

async function sdkServer(enableJsonResponse) {
  const server = http.createServer(async (req, res) => {
    const mcp = new McpServer({ name: 'official-sdk-server', version: pkg.version });
    mcp.registerTool('get_quotes', { description: 'quotes', annotations: { readOnlyHint: true } }, async () => ({
      content: [{ type: 'text', text: JSON.stringify({ results: [{ symbol: 'AAPL', last_trade_price: '1.00' }] }) }]
    }));
    mcp.registerTool('place_order', { description: 'write', annotations: { destructiveHint: true } }, async () => ({ content: [{ type: 'text', text: 'EXECUTED' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse });
    await mcp.connect(transport);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => transport.handleRequest(req, res, body ? JSON.parse(body) : undefined));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => new Promise(done => server.close(done)) };
}

for (const json of [true, false]) {
  const server = await sdkServer(json);
  try {
    // Protocol harness only: pin whatever the SDK server serves so a read call can be exercised.
    // Real authorization comes from a human-reviewed entry in reviewed-allowlist.mjs, never from listing.
    const lister = createMcpClient({ endpoint: server.url });
    await lister.initialize();
    const served = (await lister.listTools()).find(tool => tool.name === 'get_quotes');
    const reviewedAllowlist = [{ capability: 'quotes', name: 'get_quotes', fingerprint: fingerprintTool(served), args: {} }];
    const gateway = createPermissionGateway({ client: createMcpClient({ endpoint: server.url }), reviewedAllowlist });
    const discovery = await gateway.connect();
    const quotes = await gateway.inspect('quotes', {});
    results[`piClientVsSdkServer_${json ? 'json' : 'sse'}`] = {
      protocolVersion: discovery.protocolVersion,
      server: discovery.server.name,
      decisions: Object.fromEntries(discovery.tools.map(tool => [tool.name, tool.decision])),
      quoteOk: quotes.ok && quotes.data.results[0].symbol === 'AAPL'
    };
  } finally { await server.close(); }
}

const token = 'fixture-only-conformance-token-abc';
const fixture = await startFixtureServer({ token, responseMode: 'sse' });
try {
  const client = new Client({ name: 'official-sdk-client', version: pkg.version });
  await client.connect(new StreamableHTTPClientTransport(new URL(fixture.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const tools = await client.listTools();
  const call = await client.callTool({ name: 'get_quotes', arguments: { symbols: 'AAPL' } });
  results.sdkClientVsPiFixture = { tools: tools.tools.length, structuredContent: Boolean(call.structuredContent), symbol: call.structuredContent?.results?.[0]?.symbol };
  await client.close();
} finally { await fixture.close(); }

const ok = Object.entries(results).filter(([key]) => key.startsWith('piClient')).every(([, r]) => r.quoteOk && r.decisions.get_quotes === 'allow' && r.decisions.place_order === 'deny')
  && results.sdkClientVsPiFixture.symbol === 'AAPL';
console.log(JSON.stringify({ ok, ...results }, null, 2));
if (!ok) process.exitCode = 1;
