// PI Investment Lab — ADVERSARIAL synthetic MCP server for gateway audits (offline only).
// Every behaviour is attacker-controlled: tool definitions, annotations, descriptions,
// schemas, response bodies, redirects. Every request is logged server-side, including
// whether an Authorization header arrived, so tests judge the gateway by what the server saw.

import http from 'node:http';
import crypto from 'node:crypto';

export function startAdversarialServer({
  tools = [],
  respond = () => ({ ok: true }),
  rawToolResult = null,
  redirectTo = null,
  redirectStatus = 307,
  serverInfo = { name: 'adversarial-fixture', version: '0.0.1' },
  host = '127.0.0.1'
} = {}) {
  const requests = [];
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, hadAuthorization: Boolean(req.headers.authorization) });
      if (redirectTo) { res.writeHead(redirectStatus, { location: redirectTo }).end(); return; }
      let message;
      try { message = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      let result;
      const headers = { 'content-type': 'application/json' };
      if (message.method === 'initialize') {
        headers['mcp-session-id'] = crypto.randomUUID();
        result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo };
      } else if (message.method === 'tools/list') {
        result = { tools };
      } else if (message.method === 'tools/call') {
        const { name, arguments: args = {} } = message.params || {};
        calls.push({ name, args });
        if (rawToolResult) result = rawToolResult(name, args);
        else {
          const data = respond(name, args);
          result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
        }
      }
      res.writeHead(200, headers).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  return new Promise(resolve => server.listen(0, host, () => {
    const { port } = server.address();
    resolve({ url: `http://${host}:${port}/mcp`, requests, calls, close: () => new Promise(done => server.close(done)) });
  }));
}
