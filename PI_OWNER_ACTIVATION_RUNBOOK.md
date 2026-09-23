# PI V1.02 Owner Activation Runbook

Status: PREPARED — production charging remains disabled until every required proof below passes.

This runbook turns issue #112 into one controlled owner session. Never paste secrets into issues, commits, chat, screenshots, or logs.

## Owner-only inputs

Configure these as GitHub Actions secrets for the canonical repository:

- `PI_OWNER_TOKEN`
- `PI_STRIPE_SECRET_KEY` — intended Stripe **live-mode** secret key
- `PI_STRIPE_WEBHOOK_SECRET` — signing secret for the production PI webhook endpoint
- `PI_STRIPE_PRICE_ID` — owner-approved live subscription Price ID

Repository Actions secrets page:
`https://github.com/pisolutions9/Pisolutions9/settings/secrets/actions`

Stripe dashboard:
`https://dashboard.stripe.com/`

Activation issue / source of truth:
`https://github.com/pisolutions9/Pisolutions9/issues/112`

## Activation order

1. Confirm the four owner-controlled secrets above are configured. Do not expose their values.
2. Run **PI V1.02 Activation Gate** from GitHub Actions.
3. Require the deployed owner lifecycle smoke to prove login -> authenticated status -> logout -> revoked-token rejection.
4. Require deployed `/api/billing/config` evidence to report Stripe live mode and `liveBillingReady=true` with checkout/webhook configuration present.
5. Run the owner-controlled non-charging live Checkout verification workflow. It may create a Checkout Session but must not submit payment. Require independent Stripe verification that the exact session is live, subscription-mode, and contains the approved Price ID.
6. Only after steps 1–5 are green, authorize one deliberately low-risk real transaction in the intended live Stripe mode. This step spends real money and must remain owner-controlled.
7. Require the signed Stripe webhook to be accepted and the resulting entitlement to persist.
8. Confirm PI recognizes the paid entitlement through the customer access path.
9. Replay/duplicate the same webhook event through the approved test mechanism and prove it does not duplicate entitlement or side effects.
10. Exercise the supported payment-failure/revocation path and prove paid access is removed or downgraded as designed.
11. Review evidence. Only after every item is green may customer charging / paid-plan messaging be enabled.

## Evidence checklist

- [ ] Owner login succeeds with configured owner credential.
- [ ] Authenticated owner status succeeds.
- [ ] Logout revokes the session.
- [ ] Revoked token is rejected.
- [ ] Billing config reports live Stripe mode.
- [ ] Billing config reports `liveBillingReady=true`.
- [ ] Checkout and webhook configuration are present without revealing secrets.
- [ ] Exact Checkout Session independently verifies as live.
- [ ] Checkout Session is subscription mode.
- [ ] Checkout Session contains the approved Price ID.
- [ ] One owner-authorized real low-risk payment succeeds.
- [ ] Signed webhook is verified.
- [ ] Entitlement persists.
- [ ] Customer paid-access recognition succeeds.
- [ ] Duplicate webhook produces no duplicate entitlement/action.
- [ ] Payment failure/revocation removes or downgrades access correctly.
- [ ] No secret appears in logs, screenshots, issues, commits, or artifacts.
- [ ] Customer charging remains disabled until all required evidence is green.

## Stop conditions

Stop immediately and keep charging disabled if any gate is red, Stripe reports test mode where live mode is required, the approved Price ID does not match, webhook signature verification fails, entitlement state is ambiguous, duplicate processing causes a side effect, revocation fails, or any secret is exposed.

Do not lower a gate, edit evidence to appear green, or substitute a local/CI result for required production evidence. Diagnose, fix safely, rerun, and preserve the failed evidence.

## Completion rule

Issue #112 can be closed only when the production evidence above is complete. A configured secret, a green core-runtime test, or a generated `checkout.stripe.com` URL alone is not proof that customer charging is production-ready.
