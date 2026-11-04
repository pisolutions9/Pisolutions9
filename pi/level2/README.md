# PI Level 2 Candidate — software-experiment agent handoffs

Status: **draft, unmerged**. The bounded operator-machine experiment recorded one real Claude Code subscription CLI proposal and one real Codex subscription CLI implementation. CI replays those recorded bytes with zero provider calls; its other agent stages use mocks. No production deployment.

The verifier lane is pinned to content-addressed git objects, but its pin is still supplied by this PR until the reviewed pin reaches `main`. It does not yet protect against a malicious PR changing both the workflow and pin. See `SUBSCRIPTION_PROOF.md` and `VERIFIER_BOUNDARY.md` for the proof and trust boundary.

Canonical base main: 13c0c943cf75ddbf61fc568971426610e61e1985.

## Flow
Krishna task contract -> isolated local queue -> bounded model handoff -> evidence reference -> independent review -> verified/rejected/blocked.

## Limits
Max 12 tasks, 2 attempts, delegation depth 2, default paid calls 0 and spend USD 0. No deploy, billing, Cloudflare, credentials, physical actuation, arbitrary shell execution or merge. `node pi/level2/orchestrator-test.mjs` runs mock proofs.

Queue is persistent only for a **single host**, protected by an exclusive lock file. It is not a distributed queue or GitHub Actions durable state. Hash-linked events are diagnostic only.

The original mock verifier contract checks a string marker and does not establish identity. The later Linux CI lane provisions a separate verifier OS account and pins its decision code; the pin remains PR-controlled until it reaches a protected base branch.

## Next integration gates
1. Transactional persistent shared queue (SQLite/DB), leases/heartbeats/crash and concurrency tests; mirror tasks to GitHub Issues for collaboration.
2. Authenticated Claude/Codex adapters with *pre-call* dollar/token reservations and provider hard limits. Default remains off.
3. Sandboxed execution on disposable runners with no production credentials and no deployment authority.
4. Independent verifier with separate token/identity and repeatable source+test artifacts.
5. Explicit owner approval before enabling scheduled provider runs or paid use.

Existing `pi-autonomous.yml`, `pi-team-24x7.yml`, `pi/runner.mjs`, production paths and Level 3 physical prototype remain untouched.

## End-to-end proof lane

`python3 pi/level2/experiment.py run /path/to/empty/disposable/workspace` drives three stages through the SQLite queue without owner input between stages. A mock Claude process emits a bounded proposal, a mock Codex process changes one fixed arithmetic fixture, and a separate verifier process recomputes the source hash and checks acceptance behavior. `proof.json` records stage statuses, attempts, and zero paid calls. CI runs `experiment-test.py`.

The queue enforces parent depth and readiness before accepting a child task. It retains the completing worker label and rejects review under that same label. This improves state integrity but does not authenticate either label.

`Queue.reap_expired()` atomically moves a task with an expired final lease to the existing `blocked` state with `failure_reason=lease_expired_max_attempts`, clears ownership, and records one event. A claim also runs this sweep. A single-host runner must poll or call the reaper for expiry to become visible; this draft does not install a production scheduler.

If a depth-two verifier child reaches `blocked`, the queue blocks its `awaiting_review` implementation parent in the same transaction and records `failure_reason=verifier_child_terminal`. A `codex` `write_patch` task cannot become `verified` until a depth-two verifier child is verified. This is a queue state rule, not proof of authenticated reviewer identity.

This command is an **end-to-end mock integration**. Its verifier is a separate process under the same OS account. The fixed fixture does not establish general sandboxing for arbitrary generated code. The SQLite queue is durable on one host, not a cross-run distributed service. The provider adapters in this workflow are disabled by default, and `Queue.reserve_paid_call` denies paid calls.

## One-run subscription CLI proof

`subscription_experiment.py` is a separate, opt-in experiment for the same disposable arithmetic fixture. It requires a Claude Code `claude.ai` subscription login, a Codex ChatGPT login, and an explicit `--subscription-credit-off-confirmed` flag after checking Claude's extra usage credits are off. It rejects API keys and third-party provider environment settings. The script accepts an empty workspace only under its sibling `level2-runs` directory, and it never runs on a schedule. Claude gets one no-tools turn; Codex gets a read-only turn to return replacement source. The broker applies that source only if it exactly matches the fixed approved change. A separate Python process checks the result. The SQLite queue enforces two attempts and depth two. Both CLI calls have 120-second timeouts. Each run writes `proof.json` with real provider labels and exact statuses.

This path uses existing subscriptions, not paid APIs; it cannot query the account's extra-credit switch, so the flag is a human-verified prerequisite and zero incremental charge is not a provider-enforced CLI budget. The operator-machine run used a same-account verifier. CI replays the recorded output through a separate verifier OS identity with zero new provider calls; other CI stages use mocks.

## Structured handoffs

`handoff.py` defines one closed envelope schema, `pi.level2.handoff.v1`, for the three handoffs: `proposal` (claude), `implementation` (codex) and `verification` (verifier). Each envelope fixes its producer role, requires integer `paid_calls=0`, restricts file names to a single workspace basename, and has an exact payload key set with bounded field sizes. The mode distinguishes `mock` from `real-subscription-cli`. Envelopes are written as canonical JSON under `handoff/`, and the queue stores `handoff/<kind>.json#sha256=<hex>` as the task's `evidence_ref`.

Each downstream stage loads its upstream artifact through the hash the **queue** recorded, not whatever file is on disk. Codex refuses (non-zero exit, candidate untouched, no handoff advanced) if the approved proposal changed after approval. The verifier also checks the implementation's `upstream_sha256` against the queue-recorded proposal hash and the task-id links. Any mismatch becomes a recorded `passed=false` verification with a reason code, so the existing two-attempt queue rules apply. Envelopes carry no timestamps, so independent runs reproduce byte-identical hashes. `proof.json` lists them.

Limits: hashes detect changes to artifacts after the queue recorded them. They do not authenticate who wrote the queue row or the artifact. A process with write access to `queue.db` can still forge both. Producer labels remain unauthenticated. `level2_fixtures.py` provides isolated seeded workspaces for tests; `handoff-test.py` covers schema rejection, tampering at each stage, mislinked upstreams, wrong task links, determinism and queue integrity.

## Signed verifier boundary

`verifier_boundary.py` (broker) and `verifier_worker.py` (separate process, Ed25519 key, no queue access) replace label-only verification with signed, nonce-bound, replay-resistant attestations. The worker judges candidate outputs against its own oracle on held-out cases, inside a namespace-isolated harness that cannot see verifier secrets. In the simulated lane, identity is local fixture keys on one OS account. In the os-user lane (`verifier_provision.py`, `verifier-identity-test.py`, CI workflow `pi-level2-verifier-identity.yml`), the verifier runs as a separate OS account that alone holds its key, and candidate code runs as a third account. That suite fails when the boundary is missing. `providers.py` prepares disabled-by-default Claude/Codex adapters behind deterministic gates. See `VERIFIER_BOUNDARY.md` for guarantees, three fixed queue defects, residual risks and owner-gated dependencies.

