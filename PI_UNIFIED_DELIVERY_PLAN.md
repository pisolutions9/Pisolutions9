# PI unified delivery plan

Status: staged delivery, not a release-readiness certificate.

## One product, two responsibilities

PI is the customer/owner interface. Krishna is the internal coordinator. They
share one source repository and one production release; neither is a second app.
The canonical customer URL remains https://pisolutions9.github.io/Pisolutions9/.
Do not retire another deployment until its exact URL, repository and access have
been verified. Absence from the connected GitHub account does not prove absence.

## Current evidence (2026-09-20)

- Verified current release train includes runtime-grounded PI self-awareness, provider routing/fallback, hard-reasoning review, current-data research, weather, bounded inventory CSV execution, and private cross-device session sync.
- The canonical customer path uses the Cloudflare Worker. Live-model, launch, verification, Worker deploy, Pages, and live-browser V1.02 gates have passed on the current release train.
- Private cross-device continuity is token/link based. It is not an authenticated owner-account workspace; anyone with the private sync link/token must be treated as possessing access to that synced session.
- No authenticated owner identity, role-based workspace, or durable account-level owner store is claimed complete yet.
- Live web research is available only through configured live-research providers and must fail closed rather than present model memory as current evidence when those providers are unavailable.
- The Worker can execute only explicitly supported capabilities; it must not claim arbitrary website deployment, account actions, purchases, or other external side effects without an actual connected execution path and evidence.
- Hard-reasoning answers use an independent review path when available; model review is not treated as proof of external factual correctness.
- V1.02 release gating is independent from V2; V2 failures do not block V1.02.
- Live charging remains a separate fail-closed boundary until provider configuration, signed webhooks, entitlement behavior, and deployed end-to-end billing evidence are verified.

## Delivery order and completion evidence

| Stage | Deliverable | Evidence required before calling it complete |
| --- | --- | --- |
| 1 — Truthful interface | Canonical URL, clear tab-only history notice, meaningful failure states, preserved failed prompts/drafts, recent CSV downloads restored on tab refresh, honest partial/recovery labels | Behavioral UI tests plus real browser success, blocked-current-data, follow-up, and CSV checks; exact deployed assets |
| 2 — One owner workspace | Verified owner sign-in, server-owned conversations/messages/artifacts/tasks/preferences, responsive phone/laptop UI | Two independently signed-in devices see the same conversation; reverse-direction updates, logout, expired sessions, access isolation, concurrent edit conflicts and restart survival pass |
| 3 — One release path | A single deploy coordinator for frontend/backend, immutable release ID, smoke checks and rollback | Deliberately fail a gate and prove no release; verify exact candidate on both services and a successful rollback |
| 4 — Real tools | A small allowlisted set of research/file/workflow tools, with input validation and result verification | Each action has a request ID, durable status, output artifact/evidence and safe retry/replay test; unsupported actions say so |
| 5 — Reliable background work | Durable queue, bounded retries, time/cost limits, cancellation, restart recovery and an owner-visible task ledger | Restart midway without duplicate side effects; failure/retry/cancel/dead-letter scenarios pass |
| 6 — Paid release | Provider integration and persistent entitlements | All payment-release gates including signed webhooks and deployed end-to-end proof; separate approval for live charging |

No stage may be labelled done because its plan exists or its mocks pass.

## Owner continuity contract

Sign in to the same verified owner account on each device. Authorize using a
server-controlled role and exact owner identity; never grant ownership to the
first public signup, user-supplied metadata, URL parameters or a shared client key.
Do not expose an owner master token in browser JavaScript.

The server owns conversation IDs, ordered message IDs, task IDs and revisions.
Use optimistic concurrency for edits, idempotency for submissions, and strict
per-owner authorization on every read/write/download. Never overwrite the whole
workspace from a stale device snapshot. Show `Saving`, `Synced`, `Offline`,
`Conflict`, and `Sign in again` from actual outcomes, not UI timers.

Keep guest sessions local and labelled. Do not automatically upload pre-login
history from a shared device. Import only after explicit owner selection. Logout
must remove private browser caches; another user must never see the previous
owner's content. Provide export/delete controls and document retention/backup
recovery before storing private production history.

Store artifacts, evidence, settings and task states alongside messages, not just
the last 20 model-context turns. The model context can be bounded independently
of retained history. A refresh or device switch must not erase a completed file.

## Architecture/setup decision that blocks authenticated stage 2

The current private sync link/token provides cross-device continuity but not authenticated ownership. The remaining stage-2 blocker is a supported owner-authentication architecture with server-controlled identity/roles and durable account-level storage. Keep the existing Cloudflare Worker as the verified model/runtime path unless a migration is separately tested. Do not move the canonical URL before verification.

Owner must approve the exact existing project, enable invite-only Identity, and
complete the owner invite/sign-in through the provider's secure flow. Confirm
the account can deploy within the approved budget before provisioning storage.
No paid upgrade, public signup, guessed owner email, new account, secret extraction
from CI, or migration of old conversations is authorized by this plan.

If GitHub Pages must remain canonical, decide on a supported authentication
architecture before implementation. Do not hack the SDK's global origin or put
access/refresh tokens into URLs to bridge the two hosts.

## Krishna's execution contract

Understand goal and constraints → route to a supported capability → record a
durable task → execute within permission and budget → independently check the
result → return the deliverable/evidence or an exact blocker. Use specialists only
where useful. Planning, running, completed, verified, failed and awaiting approval
are distinct states. A model saying PASS is a model review, not proof of factual
correctness. A generated plan is never a deployed website or a finished action.

## Release boundaries

- Do not merge unrelated payment work or enable charging in this change.
- Do not claim phone/laptop history sync until the stage-2 production checks pass.
- Do not silently redirect/delete legacy sites or clear existing owner history.
- Do not claim continuous work without a real configured scheduler and queue.
- Keep each stage reversible, evidence-backed and small enough to diagnose.
