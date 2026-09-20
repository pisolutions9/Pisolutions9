import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { PISessionStore, handleOwnerRequest, handleSessionRequest } from './session-store.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = value => Buffer.from(value, 'binary').toString('base64');

const origin = 'https://pisolutions9.github.io';
class Storage {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key); }
  async put(key, value) { this.map.set(key, structuredClone(value)); }
  async delete(key) { this.map.delete(key); }
}
const objects = new Map();
const env = {
  PI_OWNER_TOKEN: 'owner-master-secret',
  PI_SESSION: {
    idFromName(name) { return name; },
    get(id) {
      if (!objects.has(id)) objects.set(id, new PISessionStore({ storage: new Storage() }));
      return { fetch: (...args) => objects.get(id).fetch(new Request(...args)) };
    }
  }
};
function ownerRequest(path, { method='POST', body, bearer } = {}) {
  const headers = { origin, 'content-type': 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return handleOwnerRequest(new Request(`https://worker.example${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }), env, origin);
}

let response = await ownerRequest('/api/owner/login', { body: { secret: 'wrong' } });
assert.equal(response.status, 401);

response = await ownerRequest('/api/owner/login', { body: { secret: env.PI_OWNER_TOKEN } });
assert.equal(response.status, 200);
let body = await response.json();
assert.equal(body.ok, true);
assert.equal(body.authenticated, true);
assert.match(body.sessionToken, /^[A-Za-z0-9_-]{43}$/);
assert.notEqual(body.sessionToken, env.PI_OWNER_TOKEN);
const sessionToken = body.sessionToken;

response = await ownerRequest('/api/owner/status', { method: 'GET', bearer: sessionToken });
body = await response.json();
assert.equal(response.status, 200);
assert.equal(body.authenticated, true);
assert.equal(body.ownerId, 'primary-owner');

response = await ownerRequest('/api/owner/workspace', { bearer: sessionToken, body: { action: 'load' } });
body = await response.json();
assert.equal(response.status, 200);
assert.equal(body.workspace, null);

response = await ownerRequest('/api/owner/workspace', {
  bearer: sessionToken,
  body: {
    action: 'save',
    expectedRevision: 0,
    conversation: [{ role:'user', content:'hello owner' }, { role:'assistant', content:'hello', artifacts:[{filename:'inventory.csv',mimeType:'text/csv;charset=utf-8',content:'item,quantity\\npen,1\\n'}] }],
    draft: 'next',
    preferences: { density: 'compact', notifications: true },
    tasks: [{ id:'t1', title:'Review release', status:'open' }],
    artifacts: [{filename:'inventory.csv',mimeType:'text/csv;charset=utf-8',content:'item,quantity\\npen,1\\n'}]
  }
});
body = await response.json();
assert.equal(response.status, 200);
assert.equal(body.workspace.revision, 1);
assert.equal(body.workspace.conversation[1].artifacts[0].filename, 'inventory.csv');
assert.equal(body.workspace.preferences.density, 'compact');
assert.equal(body.workspace.tasks[0].id, 't1');

response = await ownerRequest('/api/owner/workspace', {
  bearer: sessionToken,
  body: { action:'save', expectedRevision:0, conversation:[], draft:'' }
});
body = await response.json();
assert.equal(response.status, 409);
assert.equal(body.error, 'workspace_revision_conflict');
assert.equal(body.currentRevision, 1);

response = await ownerRequest('/api/owner/workspace', { bearer: sessionToken, body: { action: 'load' } });
body = await response.json();
assert.equal(body.workspace.revision, 1);
assert.equal(body.workspace.draft, 'next');

const publicToken = 'A'.repeat(43);
response = await handleSessionRequest(new Request('https://worker.example/api/session', {
  method:'POST', headers:{origin,'content-type':'application/json'},
  body:JSON.stringify({ action:'workspace_load', token:publicToken })
}), env, origin);
assert.equal(response.status, 400);

response = await ownerRequest('/api/owner/logout', { bearer: sessionToken, body:{} });
assert.equal(response.status, 200);
response = await ownerRequest('/api/owner/status', { method:'GET', bearer:sessionToken });
assert.equal(response.status, 401);

console.log('PI authenticated owner workspace tests passed.');
