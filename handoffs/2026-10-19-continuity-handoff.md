# Handoff — 2026-10-19 — Continuity handoff builder (fork)

Session: Claude Code cloud container, fork `PrEM21032/Pisolutions9`, branch
`claude/practical-johnson-hy0vob` (started from fork main `13c0c94`, identical to upstream main).

## What was done
- Added `pi/continuity-handoff.mjs`: offline CLI/module that builds a next-session prompt from
  `handoffs/*.evidence.json` (rules in `docs/PI_CONTINUITY_HANDOFF.md`).
- Added `pi/continuity-handoff-test.mjs` (`npm run test:continuity`).
- Recorded this session's evidence in `2026-10-19-continuity-handoff.evidence.json` and the
  generated prompt in `2026-10-19-continuity-handoff.next-prompt.md` (the test fails if the
  committed prompt drifts from the evidence).

## What was observed (how)
- `git ls-remote https://github.com/pisolutions9/Pisolutions9`: main `13c0c94`,
  coordination/continuity-engine-v1 `8a99ee4`, PR heads #214 `821202d`, #215 `793c1ff`,
  #217 `9ec0def`. Diffs read locally with `git diff --stat`.
- Upstream GitHub API (issues #213/#216 text, PR draft flags, reviews, CI) **not readable**:
  the session is scoped to the fork, and attaching upstream was refused because both repos
  share a checkout directory name.

## Not done / blocked
- No draft PR to upstream (no upstream credentials in this session). Owner action needed:
  open a session with `pisolutions9/Pisolutions9` as its source (not alongside the fork), or
  open the PR manually from `PrEM21032:claude/practical-johnson-hy0vob` → `pisolutions9:main`.
- Timing instrumentation (#214/#215) untouched by design (Codex is comparing them).
- No live probes, no deploy, no secrets, no paid calls.

## Next prompt
See `2026-10-19-continuity-handoff.next-prompt.md`. It has NOT been dispatched.

---

# Cycle 2 — 2026-10-19 — false-verification fix (parallel with Codex)

Scope: `pi/continuity-handoff.mjs` and its tests only. City visuals (Codex) and timing
instrumentation (#214/#215) untouched.

## Observed
- `git ls-remote` upstream: main `13c0c94`; `refs/pull/218/head` = `6d8ee2f` (= fork branch head
  before this cycle). Draft flag, reviews and CI of #218 **not observed** (upstream API not
  enabled in this session). Codex's report of PR Core / PR Gate / V1.02 Gate green on `6d8ee2f`
  is recorded as relayed, unproven here.

## Risk found (reproduced on 6d8ee2f)
- `live_probe` / `session_probe` with only `ref: "trust me"` and a fresh `observed_at` →
  VERIFIED for `live_deployment` / `running_session`.
- `commit` evidence with any free-text ref (e.g. `"whatever"`) → VERIFIED for `source`.
- The new regression test fails on 6d8ee2f's module with `live_deployment_ref_only_probe_accepted`.

## Change
- Live/session scopes are attest-only: never VERIFIED DONE (plus a guard that throws if one
  ever reaches that bucket). A full-provenance probe (url, observed_at, observed_by, method,
  result) appears under UNPROVEN as "ATTESTED, NOT VERIFIED … unauthenticated: re-probe".
- Optional `artifact` + `sha256` checked offline; mismatch, missing file or path outside the
  repo drops the attestation. A match is labelled as integrity-only.
- Link shape per kind: commit = full 40-hex sha; pr/issue/doc/ci_run/probes = https URL.
- Prompt now has a "Trust limits" section and shows `supplied by <observed_by>` on every link.

## Limitations
- Still offline shape checks. A hand-written source/test/ci entry with correct shape is
  accepted; the prompt says the generator observed nothing and names the supplier.
- Commit sha format is checked, not existence.

---

# Cycle 3 — 2026-10-19 — CI-completion and future-timestamp fix

Scope: `pi/continuity-handoff.mjs`, its test, its doc and these handoff files. This is a fast-forward commit on
`claude/practical-johnson-hy0vob`, on top of `7663b38` (the #218 head at 14:40:11Z); the draft history is kept.

## Reproduced on 7663b38 (reported by Codex; its comment could not be read here, API 403)
- A `ci_run` with `conclusion: "action_required", jobs: 0` was classified VERIFIED.
- A `ci_run` with no status or conclusion was also VERIFIED.
- `observed_at: 2027-01-01` on a commit was classified fresh, so the item was VERIFIED.
- The new regression cases fail on 7663b38's module: `ci_action_required_no_jobs_verified`,
  `f1_future_observed_at_accepted`, `ci_or_time_trust_limit_hidden`.

## Fix
- A `ci_run` proves CI only with `status: completed`, `conclusion: success`, integer `jobs >= 1` and a
  full `head_sha`. Otherwise the reason lists what failed, e.g. `ci_run_not_completed_success(conclusion:action_required,jobs:0)`.
- A shared `freshness()` check rejects `observed_at` later than `--now` + 5 min skew (`future_observed_at`)
  for every proof kind and for probes.
- The Trust limits section states both rules and that the generator did not fetch any CI run.

## Local tests vs CI
- All tests below ran locally only. No CI observed for this commit in this session.

## Limitations
- CI fields are taken as supplied. A hand-copied record with the right fields still counts; the prompt says so.

---

# Cycle 4 — 2026-10-19 — artifact symlink escape

Scope: the builder, its test and doc, and these handoff files. This is a fast-forward commit on top of `53a7157`
(the #218 head at 14:55:04Z).

## Reproduced on 53a7157 (dummy file only)
- In a scratch "repo", `handoffs/probe.json` was a symlink to `outside/dummy.txt` (content `DUMMY-NOT-A-SECRET`).
  `checkArtifact({artifact:'handoffs/probe.json', sha256:<dummy hash>})` returned `artifact_sha256_matches`,
  which means the file outside the repo was read.
- Lexical escapes (`../x`, `handoffs/../../x`) were already rejected.
- The scratch repro directory was deleted.

## Fix
- The new `readRepoFile(p, root = cwd)` takes the real paths of the root and of the target. It throws
  `OUTSIDE_REPO` unless the target is inside the root, and `NOT_FILE` unless it is a regular file.
  `checkArtifact` maps these to `artifact_path_outside_repo` and `artifact_missing`.

## Regression (in the test file; temp dir created and removed in `finally`, removal asserted)
- The CLI runs with a temp repo as cwd. Results:
  - a file symlink out of the repo gives `artifact_path_outside_repo`, with no attestation;
  - a directory symlink out of the repo gives the same;
  - an ordinary artifact matches and is ATTESTED;
  - an in-repo symlink matches;
  - a directory gives `artifact_missing`;
  - the dummy content never appears in the prompt.
- It fails on 53a7157's module with `escape-file_symlink_escape_read`. No `pi-artifact-*` temp dirs remained.
- The offline check now also bans `node:tls`, `node:dns`, `node:dgram` and `WebSocket` in the builder source.

## Limitations
- The boundary is the CLI's cwd, not a detected git root.
- The real path is checked before the read, so a race that swaps in a symlink between the two is not prevented.
- All tests are local only; no CI was observed for this commit.
