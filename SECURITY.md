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

## Least-privilege agent boundary

PI treats agent capability and owner authority as separate controls.

- A consequential tool action must identify the acting principal and the principal must hold every scope required by that action.
- Owner approval does not grant a missing capability scope. Approval and capability checks must both pass.
- Read-only work can remain low privilege. External writes, production changes, financial transfers, credential use/rotation, destructive actions, and legal commitments require progressively narrower scopes.
- A specialist must not inherit broad access merely because Krishna can route work to it.
- Missing identity or missing capability fails closed for consequential external actions.
- Allowed and denied capability decisions are emitted to the runtime audit trail with principal ID and required/missing scopes; secrets themselves must never be logged.
- Recovery must not retry protected actions automatically.

Current canonical scope families are:

- `tool:read`
- `tool:write`
- `production:change`
- `production:destructive`
- `money:transfer`
- `secret:use`
- `secret:rotate`
- `legal:commit`

Production integrations should use separate provider/service credentials per trust domain wherever the provider supports it. Do not share a single browser profile, API token, or unrestricted service account across unrelated specialists when narrower identities can be used.

## Owner sign-in hardening

- Owner sign-in is rate-limited server-side before secret verification.
- Rate-limit keys are SHA-256 derived from the source address; raw source IPs are not persisted in the owner auth store.
- Owner master secrets are never returned to the browser or stored in browser persistence.
- Successful sign-in exchanges the master secret for a short-lived random bearer session.

## Automated release security checks

- V1.02 release regression scans the repository for high-confidence committed production secret patterns.
- V1.02 CI fails on high-severity production dependency vulnerabilities reported by npm audit.
- Test-only placeholder credentials must remain obviously non-production and must never reuse real provider values.
- V1.02 tool-risk tests verify that anonymous consequential writes are denied, under-scoped agents are denied, owner approval cannot bypass missing capability scope, and protected production/financial/secret actions remain gated.
