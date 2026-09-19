// PI payment core: provider-neutral, fail-closed billing state helpers.
// Provider secrets and network calls belong in the edge adapter, never in client code.
export const ACTIVE_PAYMENT_STATES = new Set(['active','trialing']);

export function normalizePaymentEvent(event = {}) {
  if (!event || typeof event !== 'object') throw new Error('payment_event_invalid');
  const id = String(event.id || '').trim();
  const type = String(event.type || '').trim();
  if (!id || !type) throw new Error('payment_event_invalid');
  return { id, type, created: Number(event.created || 0), data: event.data ?? null };
}

export function createIdempotencyKey({ customerId='', action='', priceId='' } = {}) {
  const clean = value => String(value).trim().replace(/[^a-zA-Z0-9:_-]/g,'').slice(0,120);
  const parts = [clean(customerId), clean(action), clean(priceId)];
  if (parts.some(part => !part)) throw new Error('idempotency_input_invalid');
  return parts.join(':');
}

export function entitlementFromSubscription(subscription = {}) {
  const status = String(subscription.status || '').toLowerCase();
  const customerId = String(subscription.customer || subscription.customerId || '').trim();
  const subscriptionId = String(subscription.id || '').trim();
  if (!customerId || !subscriptionId) return { entitled:false, reason:'subscription_identity_missing' };
  if (!ACTIVE_PAYMENT_STATES.has(status)) return { entitled:false, customerId, subscriptionId, status, reason:'subscription_inactive' };
  return { entitled:true, customerId, subscriptionId, status };
}

export function shouldProcessEvent(eventId, processedIds = new Set()) {
  const id = String(eventId || '').trim();
  if (!id) throw new Error('payment_event_id_required');
  return !processedIds.has(id);
}
