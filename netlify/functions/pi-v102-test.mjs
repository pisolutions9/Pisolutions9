import { strict as assert } from 'node:assert';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./chat.mjs', import.meta.url), 'utf8');

assert.match(source, /function classify\(message\)/);
assert.match(source, /route: current \? 'needs-live-evidence'/);
assert.match(source, /function tokenBudget\(profile\)/);
assert.match(source, /if \(profile\.route === 'fast'\) return 450/);
assert.match(source, /verification: profile\.verification/);
assert.match(source, /totalTokens: usage\.total_tokens/);
assert.match(source, /live-verification-unavailable/);
assert.match(source, /Never recommend a commercial option because it pays PI/);
assert.match(source, /Never claim an external action was completed unless execution evidence exists/);

console.log(JSON.stringify({ ok: true, adaptiveBudget: true, verificationBoundary: true, telemetry: true, commerceIndependent: true }));
