# PI Continuity — next-session prompt

> Generated 2026-10-19T14:56:29.000Z by `pi/continuity-handoff.mjs` from `handoffs/2026-10-19-continuity-handoff.evidence.json`.
> NOT DISPATCHED. This file is a ready-to-paste prompt; no session was started by generating it.
> Buckets are computed from the evidence entries only. Plans, CI and merged PRs never count as live deployment or a running session.

## Trust limits (read before relying on any bucket)
- This generator ran offline and observed nothing itself. Every entry below is supplied evidence; the supplier is shown next to each link.
- VERIFIED DONE means only: the supplied evidence is of the right kind for the claim, linked (full commit sha or https URL), and fresh (not older than the window, not later than generation time). It does not authenticate the evidence.
- A CI claim needs a supplied ci_run record saying status completed, conclusion success, at least one job, and the full head sha it ran on. The generator did not fetch that run; re-read it before relying on it.
- A CI claim must name its commit as a full subject_sha, and only runs whose head_sha equals it count; short shas, urls and claim text are never used to match.
- Any fresh failing test_run or completed non-success ci_run supplied for the same claim demotes it, even if another record passed.
- Live deployment and running-session claims are never VERIFIED DONE here. A supplied probe with full provenance is shown as ATTESTED, NOT VERIFIED under UNPROVEN / BLOCKED; re-probe before relying on it.
- An artifact sha256 match proves only that a saved file is unchanged since it was recorded, not that it came from the live system.

## Goal
Advance the PI Continuity Engine with one reversible, provider-free step per session, reporting only what fresh evidence proves.

## Repository / ref (re-fetch before acting)
- https://github.com/pisolutions9/Pisolutions9 @ `main` (observed sha `13c0c943cf75ddbf61fc568971426610e61e1985`)
- Work branch: `PrEM21032/Pisolutions9:claude/practical-johnson-hy0vob`

## VERIFIED DONE
- **canonical-main** — Canonical upstream main head is 13c0c94 (merge of #212); fork main is identical — [commit:13c0c943cf75ddbf61fc568971426610e61e1985](https://github.com/pisolutions9/Pisolutions9/commit/13c0c943cf75ddbf61fc568971426610e61e1985) (supplied by git ls-remote)
- **continuity-protocol-doc** — docs/PI_CONTINUITY_ENGINE.md exists on coordination/continuity-engine-v1 (proposal, not on main) — [commit:8a99ee4032bfda07d3c0b0856ea4008f93084817](https://github.com/pisolutions9/Pisolutions9/blob/coordination/continuity-engine-v1/docs/PI_CONTINUITY_ENGINE.md) (supplied by git fetch + git show)
- **continuity-handoff-builder-tests** — Handoff builder test passes locally incl. regressions: artifact symlink escape blocked (file and directory links) while ordinary and in-repo-symlink artifacts still match; ci_run completed/success; future observed_at rejected; live/session never VERIFIED — `test_run:node pi/continuity-handoff-test.mjs` (supplied by claude-code session (this container))
- **old-false-verification-risk** — False-verification risk existed in 6d8ee2f: a live_probe/session_probe with only ref:'trust me' (or a free-text commit ref) classified VERIFIED. Reproduced by running this cycle's tests against 6d8ee2f's module: failed with live_deployment_ref_only_probe_accepted (expected failure) — [commit:6d8ee2f5625377cb7f802ebfd3fff49bb804d770](https://github.com/PrEM21032/Pisolutions9/commit/6d8ee2f5625377cb7f802ebfd3fff49bb804d770) (supplied by claude-code session (this container))
- **ci-and-future-defects** — Defects in 7663b38 (reported by Codex, reproduced here): fresh linked ci_run with conclusion action_required and jobs 0, or with no conclusion, classified VERIFIED; observed_at in 2027 classified fresh. New regression cases fail on 7663b38's module (ci_action_required_no_jobs_verified, f1_future_observed_at_accepted) — [commit:7663b388480cac6c4e6a875d6b222b4f0ad946e4](https://github.com/PrEM21032/Pisolutions9/commit/7663b388480cac6c4e6a875d6b222b4f0ad946e4) (supplied by claude-code session (this container))
- **artifact-symlink-escape** — Defect in 53a7157: checkArtifact's lexical check let handoffs/<name> be a symlink to a file outside the repo; the default reader read and hashed it (artifact_sha256_matches). Reproduced with a temporary dummy file only; the new regression fails on 53a7157 with escape-file_symlink_escape_read — [commit:53a715737d47426887bbea076a733e08a12fa2c7](https://github.com/PrEM21032/Pisolutions9/commit/53a715737d47426887bbea076a733e08a12fa2c7) (supplied by claude-code session (this container))

## IN PROGRESS
- **pr-214-215-timing** — Chat stage timing instrumentation for #213 exists in two alternatives: #214 (head 821202d) and #215 (head 793c1ff). Codex owns the comparison. — [pr:#214@821202d](https://github.com/pisolutions9/Pisolutions9/pull/214) (supplied by claude-code session (this container)), [pr:#215@793c1ff](https://github.com/pisolutions9/Pisolutions9/pull/215) (supplied by claude-code session (this container))
- **pr-217-config-validation** — Offline deploy-configuration validator for #216 exists as PR #217 (head 9ec0def, +97 lines, 4 files) — [pr:#217@9ec0def](https://github.com/pisolutions9/Pisolutions9/pull/217) (supplied by claude-code session (this container))
- **continuity-handoff-builder** — Continuity handoff builder on fork branch claude/practical-johnson-hy0vob (draft PR #218, not merged). Cycle 4 adds the artifact symlink-escape fix on top of 53a7157 (fast-forward). — [branch:PrEM21032/Pisolutions9:claude/practical-johnson-hy0vob](https://github.com/PrEM21032/Pisolutions9/tree/claude/practical-johnson-hy0vob) (supplied by claude-code session (this container)), [pr:#218@53a7157 (head before this cycle's push)](https://github.com/pisolutions9/Pisolutions9/pull/218) (supplied by git ls-remote refs/pull/218/head)

## UNPROVEN / BLOCKED
- **issues-213-216-state** — Current text/state of issues #213 and #216 not read: upstream GitHub API is not enabled for this session — [issue:#213](https://github.com/pisolutions9/Pisolutions9/issues/213) (supplied by claude-code session (this container)), [issue:#216](https://github.com/pisolutions9/Pisolutions9/issues/216) (supplied by claude-code session (this container)) — reported_blocked
- **live-worker-deployment** — Production Worker / customer chat health — not probed in this session; no live evidence — _no source link_ — reported_unproven
- **agent-sessions-running** — Whether any Codex/ChatGPT/Claude session is currently running on this work — no session probe available; assume NOT running — _no source link_ — reported_unproven
- **pr-218-ci** — CI on #218: Codex reported PR Core / PR Gate / V1.02 Gate green on 6d8ee2f; no CI observed in this session for 7663b38, 53a7157 or this cycle's commit — [pr:#218](https://github.com/pisolutions9/Pisolutions9/pull/218) (supplied by Codex (relayed by owner)) — reported_unproven
- **pr-218-draft-state** — PR #218 draft flag/reviews not observed here (only its git head ref was) — _no source link_ — reported_blocked
- **codex-comment-218** — Codex's #218 comment 6269851482 not readable from this session (API 403); defect description taken from the owner's relay — [issue:#218 comment 6269851482](https://github.com/pisolutions9/Pisolutions9/pull/218#issuecomment-6269851482) (supplied by claude-code session (this container)) — reported_blocked

## ONE next action
With upstream API read access, record CI for #218 on its new head as ci_run entries (status, conclusion, jobs, head_sha, url, observed_at) and let the builder classify them. With owner approval, reply on #218 summarising cycles 3-4 (CI completion, future timestamps, artifact symlink escape) with commits and regression names.

### Acceptance criteria
- #218 head sha re-checked; each check run recorded with all ci_run fields, or marked BLOCKED
- Builder classifies an action_required/zero-job run as UNPROVEN and a completed/success run as VERIFIED on real records
- npm run test:continuity passes with the regenerated prompt committed

### Do not duplicate
- Do not touch #217, the F4 branch claude/pr217-f4-cli-guard, PI City (Codex), #214/#215 or workflow gates
- No pushes to other branches; no merge

## Safety boundaries
- No merge, deploy, secret read/write, billing/Stripe change, paid model/provider call, purchase or hardware motion without separate explicit owner approval
- Do not weaken or skip any gate or test
- A green suite or merged PR is not live success; live/session claims need a direct probe entry
- If an agent is not dispatched, say so; never describe a halted session as running

## Rollback
- Cycle 4 changes only pi/continuity-handoff.mjs, pi/continuity-handoff-test.mjs, docs/PI_CONTINUITY_HANDOFF.md and handoffs/2026-10-19-continuity-handoff.*
- Revert with: git revert <cycle 4 commit> on claude/practical-johnson-hy0vob (returns to 53a7157); nothing deployed or configured

## Next handoff must inspect
- git ls-remote https://github.com/pisolutions9/Pisolutions9 main refs/pull/218/head refs/pull/217/head — compare with shas above
- PR #218: check runs on its current head (all ci_run fields), draft flag, Codex's comment thread
- #217 and the F4 branch status (read-only), Codex's City work and #214 vs #215 outcome (do not duplicate)
