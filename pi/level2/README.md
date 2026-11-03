# PI Level 2 Candidate — software-experiment agent handoffs

Status: **mock-tested only**. No real Claude/Codex API execution or production deployment.

Canonical base main: 13c0c943cf75ddbf61fc568971426610e61e1985.

## Flow
Krishna task contract -> isolated local queue -> bounded model handoff -> evidence reference -> independent review -> verified/rejected/blocked.

## Limits
Max 12 tasks, 2 attempts, delegation depth 2, default paid calls 0 and spend USD 0. No deploy, billing, Cloudflare, credentials, physical actuation, arbitrary shell execution or merge. `node pi/level2/orchestrator-test.mjs` runs mock proofs.

Queue is persistent only for a **single host**, protected by an exclusive lock file. It is not a distributed queue or GitHub Actions durable state. Hash-linked events are diagnostic only.

Verifier contract presently checks a string marker; it **does not establish independent identity**. A separate verifier process with identity and clean checkout is required before real model integrations.

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

This is an **end-to-end mock integration**, not real Claude or Codex provider execution. The fixed fixture and controlled output do not establish general sandboxing for untrusted generated code. The verifier is a separate process with an independently computed check, but it has no separate authenticated identity or operating-system security boundary. The SQLite queue is durable on one host; it is not a cross-run distributed service. No provider adapter is enabled because no Claude provider connection or paid-call authorization is present in this workflow. Zero paid calls is enforced by `Queue.reserve_paid_call` denying all calls.

## Structured handoffs

`handoff.py` defines one closed envelope schema, `pi.level2.handoff.v1`, for the three handoffs: `proposal` (claude), `implementation` (codex) and `verification` (verifier). Each envelope fixes its producer role, requires `mode=mock` and integer `paid_calls=0`, restricts file names to a single workspace basename, and has an exact payload key set with bounded field sizes. Envelopes are written as canonical JSON under `handoff/`, and the queue stores `handoff/<kind>.json#sha256=<hex>` as the task's `evidence_ref`.

Each downstream stage loads its upstream artifact through the hash the **queue** recorded, not whatever file is on disk. Codex refuses (non-zero exit, candidate untouched, no handoff advanced) if the approved proposal changed after approval. The verifier also checks the implementation's `upstream_sha256` against the queue-recorded proposal hash and the task-id links. Any mismatch becomes a recorded `passed=false` verification with a reason code, so the existing two-attempt queue rules apply. Envelopes carry no timestamps, so independent runs reproduce byte-identical hashes. `proof.json` lists them.

Limits: hashes detect changes to artifacts after the queue recorded them. They do not authenticate who wrote the queue row or the artifact. A process with write access to `queue.db` can still forge both. Producer labels remain unauthenticated. `level2_fixtures.py` provides isolated seeded workspaces for tests; `handoff-test.py` covers schema rejection, tampering at each stage, mislinked upstreams, wrong task links, determinism and queue integrity.

## Signed verifier boundary

`verifier_boundary.py` (broker) and `verifier_worker.py` (separate process, Ed25519 key, no queue access) replace label-only verification with signed, nonce-bound, replay-resistant attestations. The worker judges candidate outputs against its own oracle on held-out cases, inside a namespace-isolated harness that cannot see verifier secrets. Identity is **simulated** with local fixture keys on one OS account. `providers.py` prepares disabled-by-default Claude/Codex adapters behind deterministic gates. See `VERIFIER_BOUNDARY.md` for guarantees, three fixed queue defects, residual risks and owner-gated dependencies.

