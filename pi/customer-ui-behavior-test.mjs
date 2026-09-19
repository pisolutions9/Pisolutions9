// Execute the actual UI handlers against a small DOM double. These tests prove
// event/state behavior, not browser rendering or cross-device authentication.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chatOutcome, transportOutcome } from './customer-response.mjs';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = app.replace(/^import \{ chatOutcome, transportOutcome \} from '\.\/pi\/customer-response\.mjs';\n/, '');
assert.notEqual(app, script, 'test must load the actual UI with only its import bound by the test');
assert.match(html, /type="module" src="app.js/);
assert.match(html, /This browser remembers recent conversation/);
assert.match(html, /Cross-device sync requires owner sign-in/);
assert.doesNotMatch(html, /id="systemStatus">Online/);
assert.match(html, /rel="canonical" href="https:\/\/pisolutions9.github.io\/Pisolutions9\/"/);

class Element {
  constructor() {
    this.children = []; this.dataset = {}; this.style = {}; this.value = ''; this.textContent = '';
    this.disabled = false; this.scrollHeight = 44; this.listeners = {}; this.attributes = {};
    const classes = new Set();
    this.classList = { add: x => classes.add(x), remove: x => classes.delete(x), toggle: (x, set) => set ? classes.add(x) : classes.delete(x) };
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren() { this.children = []; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
  closest() { return this.parent; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(event, handler) { this.listeners[event] = handler; }
  scrollIntoView() {}
  focus() {}
}

function harness({ fetcher, store = new Map(), sessionStore = new Map(), online = true, failStorage = false } = {}) {
  const nodes = Object.fromEntries(['command', 'mission', 'missionTitle', 'steps', 'confidence', 'run', 'ownerToken', 'systemStatus', 'clearChat', 'attachFile', 'fileInput', 'attachmentStatus', 'welcome', 'transcript'].map(id => [id, new Element()]));
  const status = new Element(); status.append(nodes.systemStatus);
  const events = {};
  const context = vm.createContext({
    document: { querySelector: selector => nodes[selector.slice(1)], querySelectorAll: () => [], createElement: () => new Element(), documentElement: { dataset: {} } },
    window: { addEventListener: (name, fn) => { events[name] = fn; } },
    navigator: { onLine: online },
    localStorage: {
      getItem: key => { if (failStorage) throw new Error('storage disabled'); return store.has(key) ? store.get(key) : null; },
      setItem: (key, value) => { if (failStorage) throw new Error('storage disabled'); store.set(key, value); },
      removeItem: key => { if (failStorage) throw new Error('storage disabled'); store.delete(key); },
    },
    sessionStorage: {
      getItem: key => { if (failStorage) throw new Error('storage disabled'); return sessionStore.has(key) ? sessionStore.get(key) : null; },
      setItem: (key, value) => { if (failStorage) throw new Error('storage disabled'); sessionStore.set(key, value); },
      removeItem: key => { if (failStorage) throw new Error('storage disabled'); sessionStore.delete(key); },
    },
    fetch: (...args) => fetcher(...args), AbortController, setTimeout, clearTimeout, URL, Blob, chatOutcome, transportOutcome,
  });
  vm.runInContext(script, context);
  return { nodes, status, store, sessionStore, events, context, run: text => vm.runInContext(`runCustomerChat(${JSON.stringify(text)})`, context) };
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const success = { ok: true, answer: 'Photosynthesis uses light to make food.', truth: 'model-response', status: 'answered' };

let h = harness({ fetcher: async () => response(success) });
assert.equal(h.nodes.systemStatus.textContent, 'Ready to ask');
assert.equal(h.status.dataset.state, 'idle');
assert.equal(await h.run('Explain photosynthesis.'), true);
assert.equal(h.nodes.systemStatus.textContent, 'Reply received');
assert.equal(h.nodes.run.disabled, false);
assert.equal(h.nodes.clearChat.disabled, false);
assert.equal(JSON.parse(h.store.get('pi-v1-conversation')).length, 2);
assert.equal(h.store.has('pi-v1-pending-question'), false);
assert.equal(h.nodes.transcript.children[0].children.length, 2, 'pending label is removed');

for (const error of ['live_data_connector_not_configured', 'hard_reasoning_not_verified']) {
  h = harness({ fetcher: async () => response({ ok: false, error }, 503) });
  assert.equal(await h.run('A question that is blocked.'), false);
  assert.equal(h.nodes.command.value, 'A question that is blocked.');
  assert.equal(h.store.get('pi-v1-draft'), 'A question that is blocked.');
  assert.equal(h.status.dataset.state, 'blocked');
  assert.equal(h.store.has('pi-v1-conversation'), false, 'failed requests do not poison model history');
  assert.equal(h.nodes.run.disabled, false);
}
h = harness({ fetcher: async () => { h.nodes.command.value = 'My next question'; throw new Error('network'); } });
assert.equal(await h.run('Original question'), false);
assert.equal(h.nodes.command.value, 'My next question', 'a failure must not overwrite newly typed input');

h = harness({ fetcher: async () => new Response('<html>proxy error</html>', { status: 502 }) });
assert.equal(await h.run('Keep this question'), false);
assert.equal(h.nodes.command.value, 'Keep this question');
h = harness({ fetcher: async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }); } });
assert.equal(await h.run('Timed out question'), false);
assert.equal(h.nodes.command.value, 'Timed out question');

h = harness({ fetcher: async () => response({ ...success, status: 'incomplete', ok: false }) });
assert.equal(await h.run('Long question'), false);
assert.equal(h.nodes.systemStatus.textContent, 'Answer incomplete');
assert.match(h.nodes.transcript.children[1].children[1].textContent, /incomplete/);

const legacySession = new Map([['pi-v1-pending-question', 'Question interrupted by refresh']]);
h = harness({ sessionStore: legacySession, fetcher: async () => response(success) });
assert.equal(h.nodes.command.value, 'Question interrupted by refresh');
assert.equal(h.store.get('pi-v1-pending-question'), 'Question interrupted by refresh', 'legacy tab state migrates to persistent browser storage');
assert.equal(h.sessionStore.has('pi-v1-pending-question'), false, 'legacy tab key is removed after migration');
h.nodes.command.value = 'Draft from this device'; h.nodes.command.listeners.input();
const reloaded = harness({ store: h.store, fetcher: async () => response(success) });
assert.equal(reloaded.nodes.command.value, 'Draft from this device');
const otherTabSameBrowser = harness({ store: h.store, fetcher: async () => response(success) });
assert.equal(otherTabSameBrowser.nodes.command.value, 'Draft from this device', 'same browser tabs share persistent draft state');
const otherDevice = harness({ fetcher: async () => response(success) });
assert.equal(otherDevice.nodes.command.value, '', 'guest sessions must not pretend to sync');
assert.equal(otherDevice.nodes.transcript.children.length, 0);
h = harness({ failStorage: true, fetcher: async () => response(success) });
assert.equal(await h.run('Still usable without storage'), true);
h = harness({ online: false, fetcher: async () => { throw new Error('offline'); } });
assert.equal(h.nodes.systemStatus.textContent, 'Offline');
assert.equal(await h.run('Offline question'), false);
assert.equal(h.nodes.command.value, 'Offline question');
const artifact = { filename: 'inventory.csv', mimeType: 'text/csv;charset=utf-8', content: 'item,quantity,unit_price,total\r\npen,1,2.00,2.00\r\nGrand total,,,2.00\r\n' };
h = harness({ fetcher: async () => response({ ok: true, answer: 'Created inventory.csv.', status: 'completed', truth: 'verified-calculation', artifacts: [null, artifact] }) });
assert.equal(await h.run('Create inventory CSV: pen,1,2.00'), true);
assert.equal(JSON.parse(h.store.get('pi-v1-conversation'))[1].artifacts[0].content, artifact.content);
let requestHistory;
const withSavedFile = harness({ store: h.store, fetcher: async (_url, init) => { requestHistory = JSON.parse(init.body).history; return response(success); } });
assert.equal(withSavedFile.nodes.transcript.children[1].children[2].download, 'inventory.csv');
assert.equal(await withSavedFile.run('What was the total?'), true);
assert.equal(requestHistory[1].artifacts, undefined, 'artifact metadata must not enter the model history contract');
assert.equal(requestHistory[1].role, 'assistant');
h.nodes.clearChat.listeners.click(); withSavedFile.nodes.clearChat.listeners.click();
assert.equal(withSavedFile.nodes.transcript.children.length, 0);
console.log('Actual UI handler tests passed: status, recovery, persistent browser continuity, migration, storage denial, partials, artifact restoration, and honest device isolation.');
