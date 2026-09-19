import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(html, /id=["']command["']/);
assert.match(html, /id=["']run["']/);
assert.match(app, /runCustomerChat\(/);
assert.match(app, /response\.message/);
assert.match(app, /answer\.textContent\s*=\s*response\.message/);
assert.match(app, /meta\.textContent\s*=\s*source/);
assert.match(app, /finally\s*\{\s*run\.disabled\s*=\s*false/s);
assert.match(app, /response\.ok/);
assert.match(app, /body\.error/);
assert.match(app, /if \(\(!text && !attachedFile\) \|\| run\.disabled\)/);
assert.match(app, /command\.value = ''/);
assert.doesNotMatch(app, /Build the next PI capability/);

// Customer-visible output and mission/task rendering must use text nodes, not HTML interpolation.
assert.match(app, /answer\.textContent\s*=\s*response\.message/);
assert.match(app, /title\.textContent\s*=\s*label/);
assert.match(app, /description\.textContent\s*=\s*detail/);
assert.doesNotMatch(app, /steps\.innerHTML\s*=/);
assert.doesNotMatch(app, /answer\.innerHTML\s*=/);

// Internal orchestration/debug scaffolding must not be customer copy.
for (const phrase of [
  'Classification:',
  'Plan:',
  'I recognized this as an informational question'
]) assert.equal(app.includes(phrase), false, `leaked customer copy: ${phrase}`);

console.log('PI V1 UI contract tests passed');
