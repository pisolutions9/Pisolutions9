# PI Continuity Handoff Builder

Provider-free, local tool implementing steps 2, 4 and 6 of the PI Continuity Engine protocol
(`docs/PI_CONTINUITY_ENGINE.md` on `coordination/continuity-engine-v1`). It turns an explicit
evidence file into a ready-to-paste next-session prompt with three buckets:
**VERIFIED DONE**, **IN PROGRESS**, **UNPROVEN / BLOCKED**.

It makes no network calls, reads no environment variables or secrets, and starts no session.
Every generated prompt says `NOT DISPATCHED`.

## Usage

```sh
node pi/continuity-handoff.mjs --evidence handoffs/<date>-<topic>.evidence.json \
  --now <ISO time the evidence was gathered> \
  --out handoffs/<date>-<topic>.next-prompt.md
npm run test:continuity
```

`--now` makes output deterministic; `--max-age-hours` (default 24) sets freshness.

## Evidence file

Top level: `generated_at`, `goal`, `repo {name, ref, sha?, work_branch?}`, `items[]`,
`next_action {task, acceptance[], avoid[]}`, `safety[]`, `rollback[]`, `next_inspect[]`.

Each item: `id`, `claim`, `status` (`verified | in_progress | unproven | blocked`), `scope`
(required when verified: `source | test | ci | live_deployment | running_session`) and
`evidence[]` entries `{kind, ref?, url?, observed_at?, exit_code?, observed_by?, method?, result?, artifact?, sha256?}`.
`observed_by` is printed next to every link so the reader can see who supplied each piece.

## Classification rules (enforced, not trusted)

A `verified` claim in scope `source`, `test` or `ci` lands in VERIFIED DONE only when it has at
least one evidence entry that:

1. is of a kind allowed for its scope:
   | scope | accepted proof kinds |
   |---|---|
   | source | commit, pr, doc |
   | test | test_run with `exit_code: 0` |
   | ci | ci_run with `status: "completed"`, `conclusion: "success"`, integer `jobs >= 1` and a full 40-hex `head_sha` equal to the item's `subject_sha` |
2. carries a source link of the right shape: `commit` needs a full 40-hex sha in `ref`;
   `pr`, `issue`, `doc`, `ci_run` and probes need an `https://` `url` (a free-text `ref` is not
   enough); other kinds accept either, and
3. has `observed_at` within the freshness window and not later than the generation time
   (`--now`) plus 5 minutes of clock skew. Future timestamps are rejected as `future_observed_at`.

A `ci` item must also carry `subject_sha`: the full, lowercase 40-hex sha of the commit the claim is about.
Only passing runs whose `head_sha` equals it count. Short shas, urls and claim text are never used to match.
A completed non-success run on the same sha (or with no usable `head_sha`) demotes the claim; a failing run on
a different full sha does not.

Otherwise it is demoted to UNPROVEN with the reason printed.

### Live deployment and running sessions: attest-only

`live_deployment` and `running_session` claims are **never** placed in VERIFIED DONE. The
generator runs offline and observes nothing, so it cannot verify either. A plan, CI run, PR or
test is never accepted for them. A matching `live_probe` / `session_probe` is shown under
UNPROVEN / BLOCKED as **ATTESTED, NOT VERIFIED** only when it carries full provenance
(`url`, `observed_at` within the window, `observed_by`, `method`, `result`); otherwise the missing
fields are listed. A probe may also name a saved response `artifact` (repo-relative path) and
its `sha256`; the generator checks the hash locally and drops the attestation on mismatch.
The path is resolved against the working directory the CLI runs from (run it from the repo root).
Every symlink is followed to its real path, and the file is read only if that real path stays
inside that directory and is a regular file. Otherwise the result is `artifact_path_outside_repo` or `artifact_missing`.
A match proves only that the saved file is unchanged since recording, not that it came from
the live system. No offline parser can authenticate a probe; re-probe before relying on one.

(Found on `6ca8125`: a passing CI run for one commit verified a claim about another, because nothing tied the
claim to a commit. `subject_sha` is now required for `ci` claims.)

(Found on `53a7157`: `handoffs/x.json` could be a symlink to a file outside the repo, and its content
was read and hashed. Covered by a regression that uses only a temporary dummy file.)

(Found by Codex on `7663b38`: a fresh linked `ci_run` was VERIFIED with no completion check, so an
`action_required` run with zero jobs passed; and future `observed_at` values counted as fresh.
Both are covered by regression tests.)

(Found on `6d8ee2f`: a hand-written probe with only `ref: "trust me"`, or a free-text commit
ref, was classified VERIFIED. Regression tests in `pi/continuity-handoff-test.mjs` cover it.)
`in_progress` needs a pr/branch/commit/issue link or it is demoted too. `blocked` and
`unproven` are never promoted.

## Limitations

- It checks the shape of evidence, not its truth. For source/test/ci a hand-written entry
  with the right shape is still accepted as VERIFIED DONE (the prompt says so in its Trust
  limits section and names the supplier). Gather evidence with real commands.
- A full commit sha is checked for format only, not that the commit exists.
- The artifact boundary is the CLI's working directory, not a detected git root. The real path is
  checked before the read, so a symlink swapped in between those two steps (a race) is not prevented.
- CI fields (`status`, `conclusion`, `jobs`, `head_sha`) are taken as supplied. The generator does not fetch
  the run, so it cannot tell whether the record was copied from GitHub correctly.
- It does not fetch GitHub state itself (by design, so it stays provider-free and offline).
- Freshness is relative to `--now`; the committed prompt is a snapshot, not current state.

## Rollback

Revert the cycle's commit to return to the previous behaviour. Files: `pi/continuity-handoff.mjs`, `pi/continuity-handoff-test.mjs`, this doc,
`handoffs/`, and the `test:continuity` script line in `package.json`. Revert the commit or
delete the branch. Nothing is wired into deploy or gate workflows.
