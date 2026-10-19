import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateDeployConfiguration } from './validate-deploy-configuration.mjs';

const stripe = {PI_STRIPE_SECRET_KEY:'sk_test_canary', PI_STRIPE_WEBHOOK_SECRET:'whsec_canary', PI_STRIPE_PRICE_ID:'price_canary'};
const fallback = {PI_FALLBACK_API_KEY:'k', PI_FALLBACK_API_URL:'https://fallback.test', PI_FALLBACK_MODEL:'m'};
const cloudflare = {CLOUDFLARE_API_TOKEN:'cf-token-canary', CLOUDFLARE_ACCOUNT_ID:'cf-account-canary'};

// Absent optional providers and complete, well-formed sets are deployable.
assert.deepEqual(validateDeployConfiguration({...cloudflare}), []);
assert.deepEqual(validateDeployConfiguration({...cloudflare, ...stripe, ...fallback}), []);
assert.deepEqual(validateDeployConfiguration({...cloudflare, ...stripe, PI_STRIPE_SECRET_KEY:'rk_live_canary'}), []);
assert.deepEqual(validateDeployConfiguration({...cloudflare, PI_STRIPE_SECRET_KEY:'', PI_STRIPE_WEBHOOK_SECRET:'', PI_STRIPE_PRICE_ID:''}), []);

// Missing Cloudflare deploy credentials are refused by name only.
assert.deepEqual(validateDeployConfiguration({}), ['Required deployment variable CLOUDFLARE_API_TOKEN is missing.', 'Required deployment variable CLOUDFLARE_ACCOUNT_ID is missing.']);
assert.deepEqual(validateDeployConfiguration({CLOUDFLARE_API_TOKEN:'', CLOUDFLARE_ACCOUNT_ID:'cf-account-canary'}), ['Required deployment variable CLOUDFLARE_API_TOKEN is missing.']);

// Every refusal the post-deploy steps make offline is caught before deploy.
const refused = [
  {PI_STRIPE_SECRET_KEY:'sk_test_canary'},
  {...stripe, PI_STRIPE_PRICE_ID:''},
  {...stripe, PI_STRIPE_SECRET_KEY:'pk_live_canary'},
  {...stripe, PI_STRIPE_SECRET_KEY:'sensitive-canary-key'},
  {...stripe, PI_STRIPE_WEBHOOK_SECRET:'canary'},
  {...stripe, PI_STRIPE_PRICE_ID:'prod_canary'},
  {PI_FALLBACK_API_KEY:'k'},
  {...fallback, PI_FALLBACK_MODEL:''},
];
for (const env of refused) assert.ok(validateDeployConfiguration({...cloudflare, ...env}).length > 0, JSON.stringify(Object.keys(env)));

// CLI fails closed with a non-zero exit and never prints secret values.
const cli = fileURLToPath(new URL('./validate-deploy-configuration.mjs', import.meta.url));
const run = env => spawnSync(process.execPath, [cli], {env:{PATH:process.env.PATH, ...env}, encoding:'utf8'});
const bad = run({...cloudflare, ...stripe, PI_STRIPE_SECRET_KEY:'sensitive-canary-key'});
assert.equal(bad.status, 1);
assert.match(bad.stderr, /production Worker was not changed/);
assert.doesNotMatch(bad.stdout + bad.stderr, /canary/);
const missing = run({...stripe});
assert.equal(missing.status, 1);
assert.match(missing.stderr, /CLOUDFLARE_API_TOKEN is missing/);
assert.doesNotMatch(missing.stdout + missing.stderr, /canary/);
const good = run({...cloudflare, ...stripe, ...fallback});
assert.equal(good.status, 0);
assert.doesNotMatch(good.stdout + good.stderr, /canary/);

console.log('Pre-deploy configuration validation tests passed.');
