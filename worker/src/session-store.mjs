const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DRAFT = 8000;
const MAX_TURNS = 20;
const MAX_TURN = 12000;
const MAX_TOTAL = 32000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function reply(body, status = 200, origin = '', allowedOrigin = '') {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin'
  };
  if (origin && origin === allowedOrigin) headers['access-control-allow-origin'] = allowedOrigin;
  return new Response(JSON.stringify(body), { status, headers });
}

function sanitizeConversation(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TURNS) throw new Error('session_invalid');
  let total = 0;
  return value.map(turn => {
    if (!turn || !['user', 'assistant'].includes(turn.role) || typeof turn.content !== 'string' || turn.content.length > MAX_TURN) throw new Error('session_invalid');
    total += turn.content.length;
    if (total > MAX_TOTAL) throw new Error('session_too_large');
    return { role: turn.role, content: turn.content };
  });
}

function sanitizeDraft(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > MAX_DRAFT) throw new Error('session_invalid');
  return value;
}

async function tokenKey(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export class PISessionStore {
  constructor(ctx) { this.ctx = ctx; }

  async fetch(request) {
    let payload;
    try { payload = await request.json(); } catch { return reply({ ok: false, error: 'invalid_json' }, 400); }
    const action = payload?.action;
    if (action === 'load') {
      const saved = await this.ctx.storage.get('session');
      if (!saved) return reply({ ok: true, session: null });
      if (!Number.isFinite(saved.expiresAt) || saved.expiresAt <= Date.now()) {
        await this.ctx.storage.delete('session');
        return reply({ ok: true, session: null });
      }
      return reply({ ok: true, session: { conversation: saved.conversation || [], draft: saved.draft || '', updatedAt: saved.updatedAt || 0 } });
    }
    if (action === 'save') {
      try {
        const conversation = sanitizeConversation(payload.conversation);
        const draft = sanitizeDraft(payload.draft);
        const updatedAt = Date.now();
        await this.ctx.storage.put('session', { conversation, draft, updatedAt, expiresAt: updatedAt + SESSION_TTL_MS });
        return reply({ ok: true, updatedAt });
      } catch (error) {
        const code = String(error?.message || error);
        return reply({ ok: false, error: code }, code === 'session_too_large' ? 413 : 400);
      }
    }
    if (action === 'clear') {
      await this.ctx.storage.delete('session');
      return reply({ ok: true });
    }
    return reply({ ok: false, error: 'session_action_invalid' }, 400);
  }
}

export async function handleSessionRequest(request, env, allowedOrigin) {
  const origin = request.headers.get('Origin') || '';
  if (origin && origin !== allowedOrigin) return reply({ ok: false, error: 'origin_not_allowed' }, 403, origin, allowedOrigin);
  if (request.method === 'OPTIONS') {
    const response = reply({}, 204, origin, allowedOrigin);
    return new Response(null, { status: 204, headers: response.headers });
  }
  if (request.method !== 'POST') return reply({ ok: false, error: 'method_not_allowed' }, 405, origin, allowedOrigin);
  if (!env.PI_SESSION || typeof env.PI_SESSION.idFromName !== 'function') return reply({ ok: false, error: 'session_sync_unavailable' }, 503, origin, allowedOrigin);

  let payload;
  try { payload = await request.json(); } catch { return reply({ ok: false, error: 'invalid_json' }, 400, origin, allowedOrigin); }
  const token = String(payload?.token || '');
  if (!TOKEN_PATTERN.test(token)) return reply({ ok: false, error: 'session_token_invalid' }, 400, origin, allowedOrigin);

  const id = env.PI_SESSION.idFromName(await tokenKey(token));
  const stub = env.PI_SESSION.get(id);
  const internal = await stub.fetch('https://pi-session.internal/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: payload.action, conversation: payload.conversation, draft: payload.draft })
  });
  let body;
  try { body = await internal.json(); } catch { return reply({ ok: false, error: 'session_store_invalid_response' }, 503, origin, allowedOrigin); }
  return reply(body, internal.status, origin, allowedOrigin);
}
