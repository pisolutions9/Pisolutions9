// PI Investment Lab — minimal MCP client (Streamable HTTP transport, JSON-RPC 2.0).
// Dependency-free on purpose. The bearer credential lives only inside this closure:
// it is never placed on a returned object, in an error message, or in a trace.
// Agents never receive this client; only the permission gateway does.

export const MCP_PROTOCOL_VERSION = '2025-11-25';
const ACCEPTED_PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MAX_RESPONSE_CHARS = 4_000_000;

export class McpTransportError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'McpTransportError';
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

function assertSafeEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw new McpTransportError('invalid_endpoint'); }
  if (url.username || url.password) throw new McpTransportError('credentials_in_url_forbidden');
  if (url.search) throw new McpTransportError('query_string_forbidden');
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url;
  throw new McpTransportError('https_required');
}

// Reads the body incrementally and aborts once the cap is passed, so a hostile server cannot make
// the client buffer an unbounded (e.g. chunked, no content-length) response before the check.
async function readCapped(response, maxChars) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (text.length > maxChars) throw new McpTransportError('response_too_large');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > maxChars) {
      await reader.cancel().catch(() => {});
      throw new McpTransportError('response_too_large');
    }
  }
  return text + decoder.decode();
}

function parseSse(text) {
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try { messages.push(JSON.parse(data)); } catch { throw new McpTransportError('malformed_sse_payload'); }
  }
  return messages;
}

export function createMcpClient({
  endpoint,
  getAccessToken = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  clientInfo = { name: 'pi-investment-lab', version: '0.1.0' }
} = {}) {
  const url = assertSafeEndpoint(endpoint);
  if (typeof fetchImpl !== 'function') throw new McpTransportError('fetch_unavailable');
  let sessionId = null;
  let negotiatedVersion = null;
  let serverInfo = null;
  let nextId = 1;

  async function post(message) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    };
    if (negotiatedVersion) headers['mcp-protocol-version'] = negotiatedVersion;
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (getAccessToken) {
      const token = await getAccessToken();
      if (typeof token !== 'string' || !token) throw new McpTransportError('access_token_unavailable');
      headers.authorization = `Bearer ${token}`;
    }
    let response;
    try {
      // Never follow redirects: a redirect could forward the request body (and, same-origin, the token) elsewhere.
      response = await fetchImpl(url.href, { method: 'POST', headers, body: JSON.stringify(message), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new McpTransportError('network_failure', { cause: String(error?.cause?.code || error?.name || 'unknown') });
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new McpTransportError('redirect_refused', { status: response.status });
    }
    const sid = response.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (response.status === 401 || response.status === 403) {
      throw new McpTransportError('unauthorized', { status: response.status, wwwAuthenticate: Boolean(response.headers.get('www-authenticate')) });
    }
    if (response.status === 202) return null;
    if (!response.ok) throw new McpTransportError('http_error', { status: response.status });
    const type = response.headers.get('content-type') || '';
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_CHARS) throw new McpTransportError('response_too_large');
    const text = await readCapped(response, MAX_RESPONSE_CHARS);
    let messages;
    try { messages = type.includes('text/event-stream') ? parseSse(text) : text ? [JSON.parse(text)] : []; }
    catch (error) { if (error instanceof McpTransportError) throw error; throw new McpTransportError('malformed_json_payload'); }
    if (message.id === undefined) return null;
    const reply = messages.find(item => item && item.id === message.id);
    if (!reply) throw new McpTransportError('missing_response');
    if (reply.error) throw new McpTransportError('rpc_error', { rpcCode: reply.error.code, rpcMessage: String(reply.error.message || '').slice(0, 200) });
    return reply.result;
  }

  async function request(method, params = {}) {
    return post({ jsonrpc: '2.0', id: nextId++, method, params });
  }

  return Object.freeze({
    get endpointHost() { return url.host; },
    get protocolVersion() { return negotiatedVersion; },
    get serverInfo() { return serverInfo ? { ...serverInfo } : null; },
    async initialize() {
      const result = await request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo });
      if (!ACCEPTED_PROTOCOL_VERSIONS.has(result?.protocolVersion)) throw new McpTransportError('unsupported_protocol_version', { offered: String(result?.protocolVersion) });
      negotiatedVersion = result.protocolVersion;
      serverInfo = { name: String(result?.serverInfo?.name || 'unknown'), version: String(result?.serverInfo?.version || 'unknown') };
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return { protocolVersion: negotiatedVersion, serverInfo: { ...serverInfo } };
    },
    async listTools() {
      const tools = [];
      let cursor;
      for (let page = 0; page < 20; page++) {
        const result = await request('tools/list', cursor ? { cursor } : {});
        tools.push(...(Array.isArray(result?.tools) ? result.tools : []));
        cursor = result?.nextCursor;
        if (!cursor) break;
      }
      return tools;
    },
    async callTool(name, args = {}) {
      return request('tools/call', { name, arguments: args });
    }
  });
}
