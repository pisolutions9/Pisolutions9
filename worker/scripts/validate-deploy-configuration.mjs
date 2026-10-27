import { pathToFileURL } from 'node:url';

// Offline checks that the post-deploy configuration steps would otherwise only reach after
// `wrangler deploy` has already replaced the production Worker. Messages name variables, never values.
const REQUIRED = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];
const FALLBACK = ['PI_FALLBACK_API_KEY', 'PI_FALLBACK_API_URL', 'PI_FALLBACK_MODEL'];
const STRIPE = ['PI_STRIPE_SECRET_KEY', 'PI_STRIPE_WEBHOOK_SECRET', 'PI_STRIPE_PRICE_ID'];

export function validateDeployConfiguration(env) {
  const errors = [];
  const present = names => names.filter(name => String(env?.[name] ?? '') !== '').length;
  for (const name of REQUIRED) {
    if (String(env?.[name] ?? '') === '') errors.push(`Required deployment variable ${name} is missing.`);
  }
  const fallback = present(FALLBACK);
  if (fallback !== 0 && fallback !== FALLBACK.length) {
    errors.push('Independent fallback provider configuration is partial; refusing an unsafe deployment.');
  }
  const stripe = present(STRIPE);
  if (stripe !== 0 && stripe !== STRIPE.length) {
    errors.push('Partial Stripe billing configuration detected; refusing unsafe deployment.');
  } else if (stripe === STRIPE.length) {
    if (!/^(sk|rk)_(test|live)_/.test(env.PI_STRIPE_SECRET_KEY)) errors.push('Stripe API key must be an sk_test_, sk_live_, rk_test_, or rk_live_ key.');
    if (!env.PI_STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) errors.push('Stripe webhook secret must start with whsec_.');
    if (!env.PI_STRIPE_PRICE_ID.startsWith('price_')) errors.push('Stripe price ID must start with price_.');
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = validateDeployConfiguration(process.env);
  if (errors.length) {
    for (const error of errors) console.error(error);
    console.error('Deployment configuration is invalid; the production Worker was not changed.');
    process.exitCode = 1;
  } else {
    console.log('Deployment configuration passed offline validation; post-deploy gates must still pass.');
  }
}
