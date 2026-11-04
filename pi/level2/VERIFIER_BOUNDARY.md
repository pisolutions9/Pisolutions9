# Level 2 verifier boundary and provider adapters

Status: two lanes. **Simulated lane** (`verifier-boundary-test.py`): local fixture keys on one OS account, real signatures. **OS-user lane** (`verifier-identity-test.py`, Linux CI verified 2026-11-04): the verifier runs as a separate OS account that holds the only copy of its key. Both lanes use mock providers. No paid provider call occurs in CI.

The [verifier-identity CI job](https://github.com/pisolutions9/Pisolutions9/actions/runs/41747125431/job/126302836879) first failed as expected before provisioning (`verifier_or_candidate_user_missing`), then passed 33 adversarial assertions after provisioning. It reported `identity: os-user:pi-verifier`, `candidate_identity: os-user:pi-candidate`, `key_readable_by_broker: false`, and `harness_isolation: os-user`. The job used mock Claude/Codex stages and zero paid calls.

## Separate OS identity (os-user lane)

`verifier_provision.py` runs once as root on a **disposable** Linux runner, before any implementer or candidate code. It sets up:

| Piece | Owner / mode | Purpose |
|---|---|---|
| `pi-verifier` user | system user, no login shell | the only account that can read the signing key |
| `/var/lib/pi-level2-verifier/keys/verifier.key` | pi-verifier, 0600 in 0700 dir | Ed25519 key, generated *by* pi-verifier |
| `pi-candidate` user | system user | runs untrusted candidate code |
| `/opt/pi-level2-verifier/` | root, 0755/0644 | installed worker, harness, `run-candidate` wrapper; the broker cannot edit what pi-verifier runs |
| `/etc/pi-level2/trust.json` | root, 0644 | registry binding the public key to `{"mode": "os-user", "user": "pi-verifier"}` |
| `/etc/sudoers.d/pi-level2` | root, 0440 | broker → pi-verifier: only `python3 -I -S <installed worker> *`; pi-verifier → root: only `run-candidate` with no arguments |
| `--lockdown` | | moves the broker's own passwordless sudo grants aside and stops docker, so the broker cannot reach the key through root |

`run-candidate` runs the fixed harness as `pi-candidate`. It has no network and its own pid, mount, ipc and uts namespaces. Empty tmpfs mounts cover the verifier state dir, `/home`, `/tmp` and `/run`. It also sets CPU, memory, process and file limits, `no_new_privs`, and a 15 s hard kill. Source and inputs arrive on stdin. Every helper is called by absolute path with a pinned PATH.

The broker policy is `run_verification(..., boundary="os-user", require_identity="os-user")`. It accepts only attestations whose registry entry (root-provisioned) and signed fields both say `os-user`. Anything else gets `identity_not_separate`, including a same-account key that is registered as a verifier, or one that claims os-user in the attestation. A missing boundary gives `verifier_boundary_unavailable` and verifies nothing. There is no fallback to the same-account mode. `attested_pass` / `queue_next_task` apply the same requirement to durable records. `load_registry(..., require_protected=True)` refuses a registry that any non-root account can write (`registry_not_protected`).

The installed worker is always in os-user mode. It ignores caller-supplied `--key`/`--out`, refuses symlinked inputs (`O_NOFOLLOW`) and non-hex nonces, and never overwrites an earlier nonce's output. It exits 3 if any boundary precondition fails.

**Fail-closed tests.** `verifier-identity-test.py` first checks every precondition from the broker account. Each failure exits 1 and lists what is missing: a distinct uid, an unreadable key, a protected registry, root-owned code, no broker sudo, no docker socket, and no arbitrary command as the verifier. The only skip is `PI_VERIFIER_BOUNDARY=optional`, which CI never sets. CI runs the suite once **before** provisioning as a negative control that must fail. `verifier-boundary-test.py` now also fails when namespaces are unavailable, unless `PI_ALLOW_UNISOLATED_HARNESS=1` explicitly opts into the degraded simulated lane.

**What the os-user lane still does not establish:** the verifier code is installed from the same PR checkout it tests. The boundary holds only from provisioning onward, and a hostile PR could change the provisioner itself. Pinning the verifier code to `main` or a separate repository is the next step. The identity is an OS account on one ephemeral VM, not a hardware or externally issued key. Root on that VM can still read the key.

## Pinned verifier code and the real-subscription bridge (2026-11-04, CI result pending)

**Pin.** `verifier-pin.json` names `verifier_worker.py`, `handoff.py` and `verifier_provision.py` by git blob id and sha256, plus their combined `code_sha256`. Blob ids are content addresses, so the pin survives rebases and re-created commits. In CI, `pi-level2-verifier-identity.yml` reads the pin from the **base branch when the base has one**, and from the PR only as a bootstrap until then (`PI_PIN_SOURCE` records which). It rebuilds those files from git objects using only git, jq and sha256sum, and provisions from that copy, never from the PR working tree. The provisioner exits 2 (`verifier_code_not_pinned`) before changing anything if its code does not hash to the pin. The worker signs `verifier_code_sha256` into every attestation. Root writes the pinned hash into the registry, and `require_identity="os-user"` rejects any mismatch, including a registry entry with no pin. `verifier_pin.py check` fails the sqlite job when the PR's verifier files drift from the pin, so a verifier change needs a deliberate, reviewable re-pin.

Adversarial CI step: the workflow edits the PR working tree's `verifier_worker.py` to always return `ok`. Provisioning from that tree must be refused, and the pinned verifier must still sign a failure for real-labelled wrong code.

**Bridge.** `subscription_bridge.py` exports a real `subscription_experiment.py` run as a strict bundle: real-mode handoff envelopes, exact candidate bytes, call counts (1 Claude, 1 Codex), and CLI-reported provenance. `verify` imports the bundle into a fresh disposable queue (depth ≤ 2, attempts ≤ 2) and verifies it through the `pi-verifier` identity. It refuses tampered candidates, injected fields, paid or production claims, extra calls, raised limits, mock output relabelled as real, out-of-scope files, weakened acceptance, and broken upstream links.

**Real vs mock.** Handoff `mode` is `mock` or `real-subscription-cli`. The verifier signs `subject_mode` into its attestation, so a mock pipeline and a real bundle are distinguishable in signed evidence. Proofs separate `provider_calls_recorded` (the operator run) from `provider_calls_this_run` (always 0 in CI).

**Limits.** Provenance is operator-recorded CLI metadata, not a provider-signed receipt. The committed proof6 bundle predates metadata capture, so its session id, model and cost are `not_retained`; new runs record them. The workflow file is still PR-controlled. Only a repository ruleset (required workflow, or CODEOWNERS plus branch protection on `pi/level2/verifier-pin.json` and the workflow) makes the base-branch pin binding on a hostile PR. That is an owner setting, not code.

## What is enforced

| Property | Mechanism | Real or simulated |
|---|---|---|
| Separate execution | `verifier_worker.py` runs as its own process. On hosts that allow it, the process has no network (`unshare -rn`); otherwise it is a plain process (recorded as `isolation`). It also has its own HOME, an empty-env child for the candidate, and a 10 s test timeout. | Real process boundary. Same OS account. |
| Distinct identity | An Ed25519 key per verifier (system `openssl`). The broker trusts only public keys in a registry whose key ids are recomputed from the keys. Implementer keys cannot verify. | Real signatures. **The keys are local fixtures**: not bound to an OS user, hardware, or external identity provider. |
| Cannot silently modify the implementation | The worker gets no queue path, only a broker-made copy of its inputs, and tests a private copy of the candidate. Any workspace candidate change after the challenge is rejected (`candidate_changed`). | Detection, not prevention: a same-account process *can* write the workspace, but cannot get such a write accepted. |
| Exact evidence | Each challenge binds a nonce to the queue's current proposal and implementation refs, the candidate sha256, and the attempt number. | Real. |
| Reproduces, doesn't trust | The worker runs a fixed suite keyed by the broker-held contract. It covers 4 fixed cases plus 8 held-out cases derived from the challenge nonce, fresh per challenge and reproducible from the stored record. The candidate's child process only returns outputs, and the worker compares them with its own oracle. The child's exit code is never sufficient. Implementation claims are ignored. | Real for this fixture. |
| Candidate cannot reach verifier secrets | Candidate code runs under user+mount+pid+net namespaces. Empty tmpfs mounts cover the key directory, the challenge inputs and the output directory, and a fresh `/proc` hides other processes. The mode reached is signed into the attestation as `harness_isolation`. A pass from a harness that is not `ns-hidden` is rejected (`harness_not_isolated`) unless the caller passes `allow_unisolated=True`, which is recorded. | Real on hosts that allow unprivileged user namespaces. Elsewhere, explicit degraded mode only. |
| Ancestry | Proposal → implementation upstream hash, task ids, file scope, and before-hashes. | Real. |
| Rejects | Unregistered or implementer keys, forged or altered signatures, malformed or non-canonical (including duplicate-key) attestations, replay (same or another workspace), expired or superseded challenges, queue record changes, candidate changes, internally inconsistent passes, and handoff tampering before challenge. | Tested in `verifier-boundary-test.py`. |
| Durable result | The accepted attestation and signature are stored in `verifier_challenges`. `attested_pass` re-verifies them from the database plus the trust registry: canonical bytes, registered verifier key, signature, nonce, `passed`, the verifier child's link and status, and the implementation ref. Queue status flags alone are never trusted. | Real (single host SQLite). |
| Next bounded task | `queue_next_task` submits one fixed depth-0 task, and only when `attested_pass` succeeds. | Real. |

**Residual risk:** a verifier whose private key is stolen or compromised can sign a false pass that is internally consistent. The broker detects only inconsistent claims. Namespace isolation protects the key from *candidate code*, not from other processes under the same OS account. The fixture key file stays readable by that account, so a compromised implementer process that is *not* sandboxed can still read it. Closing that needs a separate OS user, or a hardware or managed key per verifier, on an owner-controlled runner. `exec` with empty builtins is not a sandbox. The namespaces are the security boundary.

## Queue defects found and fixed (each has a regression test)

1. A verifier task could be claimed while its implementation parent was requeued. The claim burned the verifier's attempt on a refused challenge. Fix: verifier claims now require the parent to be in `awaiting_review`.
2. An implementation re-entering review beside an already-terminal verifier child waited forever. Fix: `finish` blocks it with `verifier_child_terminal`.
3. `True`/`False` were accepted as integer `depth` and `lease_seconds`. Fix: exact `int` type checks. The same bug in the new adapter's timeout and depth checks was fixed before it landed.

## Defects found in independent review of this boundary (each has a regression test in sections 16–18)

4. **False-positive verification (critical).** The harness `exec`s candidate code with empty builtins, but the code can escape through `BuiltinImporter.load_module("posix")` and call `_exit(0)`. Pass/fail was decided by that exit code, so `def add(a, b): return 0` plus the escape got a *validly signed, accepted pass*, and the implementation was marked `verified`. Fix: the worker judges outputs against its own oracle on nonce-derived held-out inputs. Forged stdout transcripts and bool-for-int outputs are also rejected.
5. **Forged durable records unlocked the next task.** `queue_next_task` checked only that a challenge row had `used_at` set. With database write access, two inserted rows (no signature at all) queued the next task. A real signed *failure* with status flags flipped to `verified` also passed. Fix: `attested_pass` re-verifies the stored attestation against the trust registry.
6. **Verifier private key readable by candidate code.** After the escape, the candidate read the key path from the parent's `/proc/<pid>/cmdline` and copied the key (reproduced locally). With the key, a rogue implementer could sign later passes. Fix: namespace-isolated harness with secrets hidden, plus a fail-closed policy for unisolated hosts. On CI runners without unprivileged user namespaces, the suite runs in explicit degraded mode and prints a warning. **There, theft isolation is not exercised.**

## CI note: Ubuntu 24.04 runners

`ubuntu-latest` is Ubuntu 24.04, which restricts unprivileged user namespaces through AppArmor by default. Expect the CI log's PASS line to show `harness_isolation: "none"` and `key_theft_isolation_exercised: false` there. The suite still passes, in explicit degraded mode. Setting `PI_REQUIRE_HARNESS_ISOLATION=1` makes it fail instead. Getting real isolation in CI requires an **owner decision**. One option is a workflow step running `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` on the disposable runner, which widens kernel attack surface for untrusted candidate code. The other is a self-hosted or container runner that permits namespaces. Neither is enabled by this change.

## Provider adapters (`providers.py`)

Gate order is deterministic: bounded contract (role/action/depth ≤ 2/timeout ≤ 300 s) → restricted-scope check → broker-side runner command (never from the repo; default none → `provider_not_configured`) → `Queue.reserve_paid_call` (denies all in this candidate) → one concurrent call per provider. Output is accepted only as one `pi.level2.handoff.v1` envelope of the expected kind and task. Prose, injected fields, and self-reported paid calls are rejected. Credentials would come from the provider CLI's own login on an owner-controlled runner. None are in the repository.

Candidate interfaces are Claude Code headless mode and Codex CLI non-interactive exec. Their exact flags are **not** hard-coded and were **not verified here**, because neither CLI is installed in this environment.

## Owner-gated dependencies for real (non-simulated) independence

1. ~~A separate OS account for the verifier, holding its key~~: implemented and CI verified as the os-user lane on a disposable CI VM. Verifier code pinning is implemented as above (binding only after merge plus an owner ruleset). Still open: a separate runner/VM so that root on the implementer's machine cannot read the key.
2. A key bound to that identity (an environment secret or OIDC-issued signing), plus a registry change process the implementer cannot write to.
3. Provider runner configuration and an explicit spending authorization replacing the `reserve_paid_call` denial.


