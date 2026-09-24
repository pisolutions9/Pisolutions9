#!/usr/bin/env node

// Read-only V1.02 activation evidence check. This does not create a charge.
// Required env: PI_STRIPE_SECRET_KEY, PI_STRIPE_PRICE_ID, PI_CHECKOUT_URL.

const secret = process.env.PI_STRIPE_SECRET_KEY || '';
const expectedPrice = process.env.PI_STRIPE_PRICE_ID || '';
const checkoutUrl = process.env.PI_CHECKOUT_URL || '';

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!(secret.startsWith('sk_live_') || secret.startsWith('rk_live_'))) fail('PI_STRIPE_SECRET_KEY must be a live Stripe API key.');
if (!expectedPrice.startsWith('price_')) fail('PI_STRIPE_PRICE_ID is missing or invalid.');

let sessionId;
try {
  const url = new URL(checkoutUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') fail('Checkout URL must use https://checkout.stripe.com.');
  sessionId = url.pathname.split('/').find(part => part.startsWith('cs_live_'));
} catch {
  fail('PI_CHECKOUT_URL is not a valid URL.');
}
if (!sessionId) fail('Checkout URL does not contain a live Checkout Session id.');

const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items`, {
  headers: { authorization: `Bearer ${secret}` }
});
if (!response.ok) fail(`Stripe session retrieval failed with HTTP ${response.status}.`);

const session = await response.json();
if (session.livemode !== true) fail('Stripe Checkout Session is not live mode.');
if (session.id !== sessionId) fail('Stripe returned a different Checkout Session.');
if (session.mode !== 'subscription') fail(`Expected subscription mode, got ${JSON.stringify(session.mode)}.`);

const prices = (session.line_items?.data || []).map(item => item?.price?.id).filter(Boolean);
if (!prices.includes(expectedPrice)) fail('Checkout Session does not contain the owner-approved PI_STRIPE_PRICE_ID.');

console.log(JSON.stringify({
  ok: true,
  evidence: 'live-checkout-session',
  sessionIdPrefix: `${sessionId.slice(0, 12)}…`,
  livemode: true,
  mode: session.mode,
  approvedPricePresent: true
}));
