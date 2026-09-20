# PI Security Boundary

## Owner runtime

The `/api/pi` write endpoint requires `PI_OWNER_TOKEN` and an `Authorization: Bearer <token>` header.

## Secret handling

- Never commit `PI_OWNER_TOKEN` or any API key.
- Never print secrets in logs, responses, tests, screenshots, or documentation.
- Provision or rotate secrets only through the hosting provider's secret manager.
- The browser owner console sends the token only as an authorization header for the active session.

## Truth boundary

PI must not claim an external action, deployment, test, persistence, customer, revenue result, or factual discovery unless verified evidence exists.

## High-impact actions

Credentials, paid activation, legal commitments, financial transfers, protected production changes, secret rotation, and irreversible production actions remain human-approval gates.


## Owner sign-in hardening

- Owner sign-in is rate-limited server-side before secret verification.
- Rate-limit keys are SHA-256 derived from the source address; raw source IPs are not persisted in the owner auth store.
- Owner master secrets are never returned to the browser or stored in browser persistence.
- Successful sign-in exchanges the master secret for a short-lived random bearer session.
