const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OWNER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_OWNER_SESSIONS = 8;
const MAX_DRAFT = 8000;
const MAX_TURNS = 20;
const MAX_TURN = 12000;
const MAX_TOTAL = 32000;
const MAX_TASKS = 50;
const MAX_PREFERENCES = 50;
const MAX_ARTIFACTS = 20;
const MAX_ARTIFACT_CONTENT = 100000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function reply(body, status = 200, origin = '', allowedOrigin = '') {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    vary: 'Origin'
  };
  if (origin && origin === allowedOrigin) headers['access-control-allow-origin'] = allowedOrigin;
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

function sanitizeArtifact(value) {
  if (!value || typeof value !== 'object') return null;
  const filename = String(value.filename || '').slice(0, 160);
  const mimeType = String(value.mimeType || '').slice(0, 120);
  const content = typeof value.content === 'string' ? value.content : '';
  if (!filename || !mimeType || !content || content.length > MAX_ARTIFACT_CONTENT) return null;
  if (filename !== 'inventory.csv' || mimeType !== 'text/csv;charset=utf-8') return null;
  return { filename, mimeType, content };
}

function sanitizeConversation(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TURNS) throw new Error('session_invalid');
  let total = 0;
  return value.map(turn => {
    if (!turn || !['user', 'assistant'].includes(turn.role) || typeof turn.content !== 'string' || turn.content.length > MAX_TURN) throw new Error('session_invalid');
    total += turn.content.length;
    if (total > MAX_TOTAL) throw new Error('session_too_large');
    const sources = turn.role === 'assistant' && Array.isArray(turn.sources)
      ? turn.sources.filter(source => source && typeof source.url === 'string' && /^https:\/\//.test(source.url)).slice(0, 8).map(source => ({
          url: source.url.slice(0, 2000),
          title: typeof source.title === 'string' ? source.title.slice(0, 200) : ''
        }))
      : [];
    const artifacts = turn.role === 'assistant' && Array.isArray(turn.artifacts)
      ? turn.artifacts.map(sanitizeArtifact).filter(Boolean).slice(0, 1)
      : [];
    return { role: turn.role, content: turn.content, ...(sources.length ? { sources } : {}), ...(artifacts.length ? { artifacts } : {}) };
  });
}

function sanitizeDraft(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > MAX_DRAFT) throw new Error('session_invalid');
  return value;
}

function sanitizePreferences(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workspace_invalid');
  const result = {};
  const entries = Object.entries(value).slice(0, MAX_PREFERENCES);
  for (const [key, raw] of entries) {
    const cleanKey = String(key).trim().slice(0, 80);
    if (!cleanKey) continue;
    if (!['string','number','boolean'].includes(typeof raw)) continue;
    result[cleanKey] = typeof raw === 'string' ? raw.slice(0, 1000) : raw;
  }
  return result;
}

function sanitizeTasks(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TASKS) throw new Error('workspace_invalid');
  return value.map((task, index) => {
    if (!task || typeof task !== 'object') throw new Error('workspace_invalid');
    const title = String(task.title || '').trim().slice(0, 300);
    if (!title) throw new Error('workspace_invalid');
    return {
      id: String(task.id || `task-${index + 1}`).trim().slice(0, 100),
      title,
      status: String(task.status || 'open').trim().slice(0, 40)
    };
  });
}

function sanitizeArtifacts(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ARTIFACTS) throw new Error('workspace_invalid');
  return value.map(sanitizeArtifact).filter(Boolean);
}

function sanitizeWorkspace(payload = {}) {
  return {
    conversation: sanitizeConversation(payload.conversation),
    draft: sanitizeDraft(payload.draft),
    preferences: sanitizePreferences(payload.preferences),
    tasks: sanitizeTasks(payload.tasks),
    artifacts: sanitizeArtifacts(payload.artifacts)
  };
}

async function tokenKey(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function secureEqual(left, right) {
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(left || ''))));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(right || ''))));
  let diff = a.length ^ b.length;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
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
    if (action === 'owner_session_create') {
      const token = String(payload.token || '');
      if (!TOKEN_PATTERN.test(token)) return reply({ ok: false, error: 'owner_session_invalid' }, 400);
      const now = Date.now();
      const sessions = (await this.ctx.storage.get('owner_sessions')) || {};
      for (const [key, expiresAt] of Object.entries(sessions)) if (!Number.isFinite(expiresAt) || expiresAt <= now) delete sessions[key];
      const key = await tokenKey(token);
      sessions[key] = now + OWNER_SESSION_TTL_MS;
      const ordered = Object.entries(sessions).sort((a,b)=>b[1]-a[1]).slice(0, MAX_OWNER_SESSIONS);
      await this.ctx.storage.put('owner_sessions', Object.fromEntries(ordered));
      return reply({ ok: true, expiresAt: sessions[key] });
    }
    if (action === 'owner_session_validate') {
      const token = String(payload.token || '');
      if (!TOKEN_PATTERN.test(token)) return reply({ ok: true, authenticated: false });
      const sessions = (await this.ctx.storage.get('owner_sessions')) || {};
      const key = await tokenKey(token);
      const expiresAt = Number(sessions[key] || 0);
      if (expiresAt <= Date.now()) {
        if (sessions[key]) { delete sessions[key]; await this.ctx.storage.put('owner_sessions', sessions); }
        return reply({ ok: true, authenticated: false });
      }
      return reply({ ok: true, authenticated: true, expiresAt });
    }
    if (action === 'owner_session_revoke') {
      const token = String(payload.token || '');
      const sessions = (await this.ctx.storage.get('owner_sessions')) || {};
      if (TOKEN_PATTERN.test(token)) delete sessions[await tokenKey(token)];
      await this.ctx.storage.put('owner_sessions', sessions);
      return reply({ ok: true });
    }
    if (action === 'workspace_load') {
      const workspace = await this.ctx.storage.get('workspace');
      return reply({ ok: true, workspace: workspace || null });
    }
    if (action === 'workspace_save') {
      try {
        const current = (await this.ctx.storage.get('workspace')) || null;
        const currentRevision = Number(current?.revision || 0);
        const expectedRevision = Number(payload.expectedRevision ?? currentRevision);
        if (!Number.isInteger(expectedRevision) || expectedRevision !== currentRevision) {
          return reply({ ok: false, error: 'workspace_revision_conflict', currentRevision }, 409);
        }
        const clean = sanitizeWorkspace(payload);
        const updatedAt = Date.now();
        const workspace = { ...clean, revision: currentRevision + 1, updatedAt };
        await this.ctx.storage.put('workspace', workspace);
        return reply({ ok: true, workspace });
      } catch (error) {
        const code = String(error?.message || error);
        return reply({ ok: false, error: code }, code === 'session_too_large' ? 413 : 400);
      }
    }
    if (action === 'workspace_clear') {
      await this.ctx.storage.delete('workspace');
      return reply({ ok: true });
    }
    return reply({ ok: false, error: 'session_action_invalid' }, 400);
  }
}

function bearerToken(request) {
  const header = request.headers.get('Authorization') || request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+([A-Za-z0-9_-]{43})$/);
  return match ? match[1] : '';
}

function storeStub(env, name) {
  if (!env.PI_SESSION || typeof env.PI_SESSION.idFromName !== 'function') return null;
  const id = env.PI_SESSION.idFromName(name);
  return env.PI_SESSION.get(id);
}

async function internal(stub, payload) {
  const response = await stub.fetch('https://pi-session.internal/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  let body;
  try { body = await response.json(); } catch { return { response, body: { ok: false, error: 'session_store_invalid_response' } }; }
  return { response, body };
}

export async function handleSessionRequest(request, env, allowedOrigin) {
  const origin = request.headers.get('Origin') || '';
  if (origin && origin !== allowedOrigin) return reply({ ok: false, error: 'origin_not_allowed' }, 403, origin, allowedOrigin);
  if (request.method === 'OPTIONS') return reply({}, 204, origin, allowedOrigin);
  if (request.method !== 'POST') return reply({ ok: false, error: 'method_not_allowed' }, 405, origin, allowedOrigin);
  if (!env.PI_SESSION || typeof env.PI_SESSION.idFromName !== 'function') return reply({ ok: false, error: 'session_sync_unavailable' }, 503, origin, allowedOrigin);

  let payload;
  try { payload = await request.json(); } catch { return reply({ ok: false, error: 'invalid_json' }, 400, origin, allowedOrigin); }
  if (!['load','save','clear'].includes(payload?.action)) return reply({ ok: false, error: 'session_action_invalid' }, 400, origin, allowedOrigin);
  const token = String(payload?.token || '');
  if (!TOKEN_PATTERN.test(token)) return reply({ ok: false, error: 'session_token_invalid' }, 400, origin, allowedOrigin);

  const stub = storeStub(env, await tokenKey(token));
  const { response, body } = await internal(stub, { action: payload.action, conversation: payload.conversation, draft: payload.draft });
  return reply(body, response.status, origin, allowedOrigin);
}

export async function handleOwnerRequest(request, env, allowedOrigin) {
  const origin = request.headers.get('Origin') || '';
  if (origin && origin !== allowedOrigin) return reply({ ok: false, error: 'origin_not_allowed' }, 403, origin, allowedOrigin);
  if (request.method === 'OPTIONS') return reply({}, 204, origin, allowedOrigin);
  if (!env.PI_SESSION || typeof env.PI_SESSION.idFromName !== 'function') return reply({ ok: false, error: 'owner_workspace_unavailable' }, 503, origin, allowedOrigin);
  const url = new URL(request.url);
  const authStore = storeStub(env, 'pi-owner-auth-v1');

  if (url.pathname === '/api/owner/login') {
    if (request.method !== 'POST') return reply({ ok: false, error: 'method_not_allowed' }, 405, origin, allowedOrigin);
    if (!String(env.PI_OWNER_TOKEN || '')) return reply({ ok: false, error: 'owner_auth_not_configured' }, 503, origin, allowedOrigin);
    let payload;
    try { payload = await request.json(); } catch { return reply({ ok: false, error: 'invalid_json' }, 400, origin, allowedOrigin); }
    if (!(await secureEqual(payload?.secret, env.PI_OWNER_TOKEN))) return reply({ ok: false, error: 'unauthorized' }, 401, origin, allowedOrigin);
    const token = randomToken();
    const created = await internal(authStore, { action: 'owner_session_create', token });
    if (!created.body?.ok) return reply({ ok: false, error: 'owner_session_create_failed' }, 503, origin, allowedOrigin);
    return reply({ ok: true, authenticated: true, sessionToken: token, expiresAt: created.body.expiresAt }, 200, origin, allowedOrigin);
  }

  const token = bearerToken(request);
  const validation = await internal(authStore, { action: 'owner_session_validate', token });
  if (!validation.body?.authenticated) return reply({ ok: false, error: 'owner_session_invalid' }, 401, origin, allowedOrigin);

  if (url.pathname === '/api/owner/status') {
    if (!['GET','POST'].includes(request.method)) return reply({ ok: false, error: 'method_not_allowed' }, 405, origin, allowedOrigin);
    return reply({ ok: true, authenticated: true, ownerId: 'primary-owner', expiresAt: validation.body.expiresAt }, 200, origin, allowedOrigin);
  }
  if (url.pathname === '/api/owner/logout') {
    if (request.method !== 'POST') return reply({ ok: false, error: 'method_not_allowed' }, 405, origin, allowedOrigin);
    await internal(authStore, { action: 'owner_session_revoke', token });
    return reply({ ok: true }, 200, origin, allowedOrigin);
  }
  if (url.pathname === '/api/owner/workspace') {
    if (request.method !== 'POST') return reply({ ok: false, error: 'method_not_allowed' }, 405, origin, allowedOrigin);
    let payload;
    try { payload = await request.json(); } catch { return reply({ ok: false, error: 'invalid_json' }, 400, origin, allowedOrigin); }
    const actionMap = { load: 'workspace_load', save: 'workspace_save', clear: 'workspace_clear' };
    const action = actionMap[payload?.action];
    if (!action) return reply({ ok: false, error: 'workspace_action_invalid' }, 400, origin, allowedOrigin);
    const workspaceStore = storeStub(env, 'pi-owner-workspace-v1');
    const result = await internal(workspaceStore, {
      action,
      expectedRevision: payload.expectedRevision,
      conversation: payload.conversation,
      draft: payload.draft,
      preferences: payload.preferences,
      tasks: payload.tasks,
      artifacts: payload.artifacts
    });
    return reply(result.body, result.response.status, origin, allowedOrigin);
  }
  return reply({ ok: false, error: 'not_found' }, 404, origin, allowedOrigin);
}
