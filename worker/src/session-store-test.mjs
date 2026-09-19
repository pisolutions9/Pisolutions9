import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { PISessionStore, handleSessionRequest } from './session-store.mjs';

globalThis.crypto = webcrypto;
const origin = 'https://pisolutions9.github.io';
const token = 'A'.repeat(43);

class Storage {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key); }
  async put(key, value) { this.map.set(key, value); }
  async delete(key) { this.map.delete(key); }
}
const objects = new Map();
const env = {
  PI_SESSION: {
    idFromName(name) { return name; },
    get(id) {
      if (!objects.has(id)) objects.set(id, new PISessionStore({ storage: new Storage() }));
      return { fetch: (...args) => objects.get(id).fetch(new Request(...args)) };
    }
  }
};
const call = body => handleSessionRequest(new Request('https://worker.example/api/session', {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify(body)
}), env, origin);

let response = await call({ action: 'save', token, conversation: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }], draft: 'next' });
assert.equal(response.status, 200);
assert.equal((await response.json()).ok, true);

response = await call({ action: 'load', token });
let body = await response.json();
assert.equal(response.status, 200);
assert.deepEqual(body.session.conversation, [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }]);
assert.equal(body.session.draft, 'next');

response = await call({ action: 'clear', token });
assert.equal(response.status, 200);
response = await call({ action: 'load', token });
body = await response.json();
assert.equal(body.session, null);

response = await call({ action: 'load', token: 'short' });
assert.equal(response.status, 400);
response = await handleSessionRequest(new Request('https://worker.example/api/session', {
  method: 'POST',
  headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'load', token })
}), env, origin);
assert.equal(response.status, 403);

console.log('PI private device sync store tests passed.');
