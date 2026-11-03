# PI Autonomous Physical Lab — Level 3 candidate (simulation only)

**Status:** Candidate design + executable simulation tests. No physical hardware tested or authorized.

## Boundary
The canonical production PI Worker, Stripe, Cloudflare, existing 15-minute autonomous jobs and external credentials are not changed. This gate has read-only repo permissions. The controller does not import a physical GPIO/network adapter. Actuation names explicitly start with `simulate_`.

## Data flow
Owner constraints -> Krishna task contract -> bounded queue -> deterministic safety check -> simulation adapter -> evidence log -> independent test gate -> review. Claude/Codex are *future* adapters: this prototype does not call them, and their generated instructions must never be executed as hardware commands.

## Current candidate constraints
- Max 8 submitted tasks per simulation, 2 attempts per task, delegation depth 2.
- 0 paid model calls, $0 API spend; 30-second intended wall-time ceiling (must be enforced by external supervisor for real integrations).
- Allowlist: observe / simulate_led_on / simulate_led_off only.
- Interlock and emergency stop required; default hardware-connected mode rejected.
- Sensor data older than 5s rejected; no automatic retry of blocked actuation.
- Duplicate task IDs rejected; SHA256 evidence chain for *simulation audit*, not tamper-proof trusted persistence.

## Hardware gate — not implemented
Before any device can be attached: provision a dedicated local non-production computer, physically independent normally-open relay/enable circuit and hardwired emergency stop; per-device voltage/current/temperature bounds; watchdog with safe-off default; vetted firmware; signed command envelopes, monotonic sequence, expiry, authenticated least-privilege local transport, local append-only durable storage, human approval and a commissioning checklist. AI code must never gain direct GPIO/relay or shell authority. Cameras/microphones require household consent and privacy limits.

## Durable shared queue — next milestone
GitHub Issues/PRs can hold agent proposals and reviews, but **not** the authoritative real-time command queue. A local SQLite WAL task database with unique idempotency keys, atomic leases, heartbeats, evidence IDs, retry counters and transactional recovery should be implemented and tested prior to device connection. GitHub Actions are not real-time safety controllers.

## Model handoff
`pi.lab.handoff.v1` contains parent goal, findings, evidence hash, next action, allowed actions, and mandatory orchestrator review. Provider adapters must be explicitly authorized and budgeted in a later PR.

## Run proof
`node lab/controller-test.mjs`
Tests cover action allowlist, hardware-deny, emergency stop, paid budget, recursion/retries, production-token rejection, no fresh sensor, stale sensor, idempotency and evidence chain.

No physical readiness or cross-provider autonomy is claimed.
