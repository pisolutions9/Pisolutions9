import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
assert.match(html,/id="ownerAccess"/);
assert.match(html,/id="ownerDialog"/);
assert.match(html,/type="password"/);
assert.match(app,/\/api\/owner\/login/);
assert.match(app,/\/api\/owner\/workspace/);
assert.match(app,/sessionStorage\.setItem\(OWNER_SESSION_KEY/);
assert.doesNotMatch(app,/localStorage\.setItem\(OWNER_SESSION_KEY/);
assert.match(app,/workspace_revision_conflict/);
assert.match(app,/Authenticated owner workspace is active/);
console.log('PI owner workspace UI contract tests passed.');
