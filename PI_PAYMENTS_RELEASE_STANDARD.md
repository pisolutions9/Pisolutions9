# PI Payments Release Standard

Status: STRIPE RUNTIME IMPLEMENTED — LIVE BILLING DISABLED UNTIL SECRETS + PRODUCTION PAYMENT SMOKE

PI may only declare live payments release-ready when all gates below are verified in production:

1. Server-side checkout/session creation uses a configured payment provider secret; no secret is exposed to browser code.
2. Webhooks are cryptographically verified against the provider signing secret before parsing or mutating entitlement state.
3. Every provider event ID is persisted and processed idempotently; duplicate delivery cannot duplicate credits, subscriptions, or side effects.
4. Entitlement is fail-closed. Missing identity, invalid signature, cancelled, unpaid, incomplete, or past-due state does not grant paid access.
5. Price/product identifiers are server allowlisted. Client-supplied amount/currency is never trusted.
6. Checkout creation has a stable idempotency key and authenticated customer identity.
7. Refund, cancellation, chargeback/dispute, subscription update, and payment failure events remove or reconcile entitlement as appropriate.
8. Payment logs redact secrets and payment data. PI never stores raw card numbers, CVC, or equivalent sensitive authentication data.
9. Sandbox tests prove success, decline/failure, duplicate webhook, invalid signature, cancellation, refund/dispute, and replay behavior.
10. A production smoke verifies checkout -> signed webhook -> persisted entitlement -> customer access using the exact deployed candidate.

Until all ten gates pass, UI must not claim that PI can accept live payments.


## V1.02 implementation
The Worker implements a fail-closed Stripe Checkout subscription path with a server-allowlisted price, stable Stripe idempotency key, signed-webhook verification, persistent duplicate-event protection, bearer customer identity, persistent entitlement state, payment-failure revocation, and a billing configuration/status surface. The billing UI and production deployment must remain hidden/disabled unless the required provider configuration is present. A green local/CI test is not a substitute for the final real payment production smoke.
