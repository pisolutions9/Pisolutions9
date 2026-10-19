import { readFile, mkdir, rm } from 'node:fs/promises';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildPrompt, checkArtifact, classifyItem, validateEvidence } from './continuity-handoff.mjs';
const builderPath = fileURLToPath(new URL('./continuity-handoff.mjs', import.meta.url));

const now = Date.parse('2026-10-19T12:00:00Z');
const fresh = '2026-10-19T11:00:00Z';
const stale = '2026-10-10T00:00:00Z';
const expect = (cond, code) => { if (!cond) throw new Error(code); };
const bucket = (item) => classifyItem(item, { now }).bucket;
const SHA = '13c0c943cf75ddbf61fc568971426610e61e1985';

// Live deployment and running sessions can never be inferred from plans, CI, PRs or tests.
for (const kind of ['plan', 'ci_run', 'pr', 'test_run', 'commit', 'doc']) {
  const ev = { kind, url: 'https://github.com/x/y', observed_at: fresh, exit_code: 0 };
  expect(bucket({ id: 'd', claim: 'Worker live', status: 'verified', scope: 'live_deployment', evidence: [ev] }) === 'unproven', `live_inferred_from_${kind}`);
  expect(bucket({ id: 's', claim: 'Claude session running', status: 'verified', scope: 'running_session', evidence: [ev] }) === 'unproven', `session_inferred_from_${kind}`);
}

// Regression (found on 6d8ee2f): a hand-written probe or bare ref made live/session claims VERIFIED.
// Offline, a probe can at most be ATTESTED (shown under UNPROVEN), whatever provenance it carries.
const fullProbe = (kind) => ({ kind, url: 'https://example.invalid/health', observed_at: fresh, observed_by: 'operator', method: 'curl -sS https://example.invalid/health', result: 'HTTP 200' });
for (const [scope, kind] of [['live_deployment', 'live_probe'], ['running_session', 'session_probe']]) {
  const refOnly = classifyItem({ id: 'r', claim: 'c', status: 'verified', scope, evidence: [{ kind, ref: 'trust me', observed_at: fresh }] }, { now });
  expect(refOnly.bucket === 'unproven' && !refOnly.attested, `${scope}_ref_only_probe_accepted`);
  expect(refOnly.reasons.some((r) => r.startsWith('probe_missing_provenance(') && r.includes('url') && r.includes('observed_by')), `${scope}_missing_provenance_not_reported`);
  const full = classifyItem({ id: 'f', claim: 'c', status: 'verified', scope, evidence: [fullProbe(kind)] }, { now });
  expect(full.bucket === 'unproven' && full.attested === true, `${scope}_full_probe_not_attested_or_verified`);
  expect(full.reasons.some((r) => r.includes('ATTESTED by operator')) && full.reasons.includes('unauthenticated: re-probe before relying'), `${scope}_attestation_source_hidden`);
  const staleProbe = classifyItem({ id: 's', claim: 'c', status: 'verified', scope, evidence: [{ ...fullProbe(kind), observed_at: stale }] }, { now });
  expect(staleProbe.bucket === 'unproven' && !staleProbe.attested, `${scope}_stale_probe_attested`);
  const wrongKind = classifyItem({ id: 'w', claim: 'c', status: 'verified', scope, evidence: [{ ...fullProbe('ci_run') }] }, { now });
  expect(wrongKind.bucket === 'unproven' && !wrongKind.attested, `${scope}_ci_counted_as_probe`);
}

// Optional saved-response artifact: hash must match the file; even a match stays ATTESTED only.
const body = Buffer.from('{"ok":true}');
const hash = createHash('sha256').update(body).digest('hex');
// checkArtifact passes path.normalize(artifact) to the reader, which uses \\ on Windows.
const files = { [normalize('handoffs/probe.json')]: body };
const readArtifact = (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; };
expect(checkArtifact({ artifact: 'handoffs/probe.json', sha256: hash }, readArtifact) === 'artifact_sha256_matches', 'artifact_match_rejected');
expect(checkArtifact({ artifact: 'handoffs/probe.json', sha256: '0'.repeat(64) }, readArtifact) === 'artifact_sha256_mismatch', 'artifact_mismatch_accepted');
expect(checkArtifact({ artifact: '../etc/passwd', sha256: hash }, readArtifact) === 'artifact_path_outside_repo', 'artifact_escape_allowed');
expect(checkArtifact({ artifact: '/etc/passwd', sha256: hash }, readArtifact) === 'artifact_path_outside_repo', 'artifact_absolute_allowed');
expect(checkArtifact({ artifact: 'handoffs/missing.json', sha256: hash }, readArtifact) === 'artifact_missing', 'artifact_missing_accepted');
expect(checkArtifact({ sha256: hash }, readArtifact) === 'artifact_and_sha256_must_be_given_together', 'sha_without_artifact_accepted');
const tampered = classifyItem({ id: 't', claim: 'c', status: 'verified', scope: 'live_deployment', evidence: [{ ...fullProbe('live_probe'), artifact: 'handoffs/probe.json', sha256: '0'.repeat(64) }] }, { now, readArtifact });
expect(!tampered.attested && tampered.reasons.includes('artifact_sha256_mismatch'), 'tampered_artifact_attested');
const matched = classifyItem({ id: 'm', claim: 'c', status: 'verified', scope: 'live_deployment', evidence: [{ ...fullProbe('live_probe'), artifact: 'handoffs/probe.json', sha256: hash }] }, { now, readArtifact });
expect(matched.bucket === 'unproven' && matched.attested && matched.reasons.includes('artifact_sha256_matches'), 'matched_artifact_promoted_or_hidden');

// Regression (found on 53a7157): the default reader followed a repo symlink to a file outside the repo.
// Uses only a throwaway dummy file in a temp dir; the CLI runs with that temp "repo" as its cwd.
const sandbox = mkdtempSync(join(tmpdir(), 'pi-artifact-'));
try {
  const repo = join(sandbox, 'repo');
  const outside = join(sandbox, 'outside');
  mkdirSync(join(repo, 'handoffs'), { recursive: true });
  mkdirSync(outside);
  const dummy = Buffer.from('DUMMY-NOT-A-SECRET');
  const dummyHash = createHash('sha256').update(dummy).digest('hex');
  writeFileSync(join(outside, 'dummy.txt'), dummy);
  writeFileSync(join(repo, 'handoffs', 'ok.json'), body);
  symlinkSync(join(outside, 'dummy.txt'), join(repo, 'handoffs', 'escape.json'));
  symlinkSync(outside, join(repo, 'linkdir'));
  symlinkSync(join(repo, 'handoffs', 'ok.json'), join(repo, 'handoffs', 'inside-link.json'));
  const probe = (artifact, sha256) => ({ ...fullProbe('live_probe'), artifact, sha256 });
  const evidence = { goal: 'g', repo: { name: 'r', ref: 'main' }, next_action: { task: 't' }, items: [
    { id: 'escape-file', claim: 'c', status: 'verified', scope: 'live_deployment', evidence: [probe('handoffs/escape.json', dummyHash)] },
    { id: 'escape-dir', claim: 'c', status: 'verified', scope: 'live_deployment', evidence: [probe('linkdir/dummy.txt', dummyHash)] },
    { id: 'ordinary', claim: 'c', status: 'verified', scope: 'live_deployment', evidence: [probe('handoffs/ok.json', hash)] },
    { id: 'inside-link', claim: 'c', status: 'verified', scope: 'live_deployment', evidence: [probe('handoffs/inside-link.json', hash)] },
    { id: 'directory', claim: 'c', status: 'verified', scope: 'live_deployment', evidence: [probe('handoffs', hash)] }
  ] };
  writeFileSync(join(repo, 'evidence.json'), JSON.stringify(evidence));
  execFileSync('node', [builderPath, '--evidence', 'evidence.json', '--now', new Date(now).toISOString(), '--out', 'p.md'], { cwd: repo });
  const out = await readFile(join(repo, 'p.md'), 'utf8');
  const line = (id) => out.split('\n').find((l) => l.startsWith(`- **${id}**`)) || '';
  for (const id of ['escape-file', 'escape-dir']) {
    expect(line(id).includes('artifact_path_outside_repo') && !line(id).includes('ATTESTED, NOT VERIFIED'), `${id}_symlink_escape_read`);
  }
  expect(line('ordinary').includes('artifact_sha256_matches') && line('ordinary').includes('ATTESTED, NOT VERIFIED'), 'ordinary_repo_artifact_broken');
  expect(line('inside-link').includes('artifact_sha256_matches'), 'in_repo_symlink_rejected');
  expect(line('directory').includes('artifact_missing'), 'directory_artifact_accepted');
  expect(!out.includes('DUMMY-NOT-A-SECRET'), 'artifact_content_leaked');
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
expect(!existsSync(sandbox), 'artifact_sandbox_not_cleaned');

// Regression (Codex, Windows; reproduced on Linux for spaces/symlinks on 1cf9229): the entry check compared
// import.meta.url with `file://${argv[1]}`, so a direct CLI run exited 0 without writing the prompt.
const cliBox = mkdtempSync(join(tmpdir(), 'pi-cli entry-'));
try {
  const evidenceFile = join(cliBox, 'evidence.json');
  writeFileSync(evidenceFile, JSON.stringify({ goal: 'g', repo: { name: 'r', ref: 'main' }, next_action: { task: 't' }, items: [] }));
  const runCli = (entry, out) => {
    execFileSync('node', [entry, '--evidence', evidenceFile, '--now', new Date(now).toISOString(), '--out', out]);
    return existsSync(out) ? readFileSync(out, 'utf8') : null;
  };
  const spaced = join(cliBox, 'dir with space');
  mkdirSync(spaced);
  copyFileSync(builderPath, join(spaced, 'continuity-handoff.mjs'));
  const viaSpace = runCli(join(spaced, 'continuity-handoff.mjs'), join(cliBox, 'space.md'));
  expect(viaSpace !== null && viaSpace.includes('## VERIFIED DONE'), 'direct_cli_did_not_write_prompt');
  symlinkSync(builderPath, join(cliBox, 'entry-link.mjs'));
  const viaLink = runCli(join(cliBox, 'entry-link.mjs'), join(cliBox, 'link.md'));
  expect(viaLink !== null && viaLink === viaSpace, 'symlinked_cli_did_not_write_prompt');
  // Importing the module must stay inert: no output, no prompt written.
  const importer = join(cliBox, 'importer.mjs');
  writeFileSync(importer, `import ${JSON.stringify(new URL('./continuity-handoff.mjs', import.meta.url).href)};\n`);
  const imported = execFileSync('node', [importer, '--evidence', evidenceFile, '--out', join(cliBox, 'import.md')], { encoding: 'utf8' });
  expect(imported === '' && !existsSync(join(cliBox, 'import.md')), 'import_ran_cli');
} finally {
  rmSync(cliBox, { recursive: true, force: true });
}
expect(!existsSync(cliBox), 'cli_sandbox_not_cleaned');

// The rendered prompt never lists a live/session claim under VERIFIED DONE, and shows the trust limits.
const probeDoc = { goal: 'g', repo: { name: 'r', ref: 'main' }, next_action: { task: 't' }, items: [
  { id: 'live-claim', claim: 'Worker live', status: 'verified', scope: 'live_deployment', evidence: [fullProbe('live_probe')] },
  { id: 'session-claim', claim: 'Codex running', status: 'verified', scope: 'running_session', evidence: [{ kind: 'session_probe', ref: 'x', observed_at: fresh }] }
] };
const probePrompt = buildPrompt(probeDoc, { now });
const verifiedSection = probePrompt.split('## VERIFIED DONE')[1].split('## IN PROGRESS')[0];
expect(!verifiedSection.includes('live-claim') && !verifiedSection.includes('session-claim'), 'live_or_session_rendered_as_verified');
expect(probePrompt.includes('ATTESTED, NOT VERIFIED') && probePrompt.includes('## Trust limits') && probePrompt.includes('observed nothing itself'), 'trust_limits_not_visible');
expect(probePrompt.includes('demotes it, even if another record passed'), 'conflict_trust_limit_hidden');
expect(probePrompt.includes('full subject_sha') && probePrompt.includes('never used to match'), 'subject_sha_trust_limit_hidden');
expect(probePrompt.includes('status completed, conclusion success, at least one job') && probePrompt.includes('not later than generation time'), 'ci_or_time_trust_limit_hidden');
expect(probePrompt.includes('(supplied by operator)'), 'supplier_not_visible');

// Verified requires a source link, fresh observation and (for tests) exit code 0.
expect(bucket({ id: 'a', claim: 'c', status: 'verified', scope: 'source', evidence: [{ kind: 'commit', observed_at: fresh }] }) === 'unproven', 'unlinked_proof_accepted');
expect(bucket({ id: 'a', claim: 'c', status: 'verified', scope: 'source', evidence: [{ kind: 'commit', ref: SHA, observed_at: stale }] }) === 'unproven', 'stale_proof_accepted');
expect(bucket({ id: 'a', claim: 'c', status: 'verified', scope: 'source', evidence: [{ kind: 'commit', ref: SHA }] }) === 'unproven', 'undated_proof_accepted');
expect(bucket({ id: 'a', claim: 'c', status: 'verified', scope: 'source', evidence: [{ kind: 'commit', ref: SHA, observed_at: fresh }] }) === 'verified', 'linked_fresh_commit_rejected');
// A commit ref must be a full 40-hex sha; PR/doc proofs need an https URL, not a free-text ref.
for (const ref of ['abc123', 'whatever', 'main', SHA.slice(0, 7)]) {
  expect(bucket({ id: 'a', claim: 'c', status: 'verified', scope: 'source', evidence: [{ kind: 'commit', ref, observed_at: fresh }] }) === 'unproven', `short_or_free_commit_ref_accepted_${ref}`);
}
expect(bucket({ id: 'a', claim: 'c', status: 'verified', scope: 'source', evidence: [{ kind: 'pr', ref: '#999', observed_at: fresh }] }) === 'unproven', 'pr_ref_without_url_accepted');
expect(bucket({ id: 'c', claim: 'c', status: 'verified', scope: 'ci', subject_sha: SHA, evidence: [{ kind: 'ci_run', ref: 'green', observed_at: fresh }] }) === 'unproven', 'ci_ref_without_url_accepted');

// Regression (found by Codex on 7663b38): any fresh linked ci_run was VERIFIED, even action_required with no jobs.
const ciRun = { kind: 'ci_run', url: 'https://github.com/x/y/actions/runs/1', observed_at: fresh, status: 'completed', conclusion: 'success', jobs: 3, head_sha: SHA };
const ciBucket = (ev) => classifyItem({ id: 'ci', claim: 'CI green', status: 'verified', scope: 'ci', subject_sha: SHA, evidence: [ev] }, { now });
expect(ciBucket(ciRun).bucket === 'verified', 'completed_success_ci_rejected');
for (const [name, ev] of [
  ['action_required_no_jobs', { ...ciRun, conclusion: 'action_required', jobs: 0 }],
  ['no_status_or_conclusion', { kind: 'ci_run', url: ciRun.url, observed_at: fresh }],
  ['in_progress', { ...ciRun, status: 'in_progress', conclusion: null }],
  ['failure', { ...ciRun, conclusion: 'failure' }],
  ['skipped', { ...ciRun, conclusion: 'skipped' }],
  ['neutral', { ...ciRun, conclusion: 'neutral' }],
  ['zero_jobs', { ...ciRun, jobs: 0 }],
  ['jobs_missing', { ...ciRun, jobs: undefined }],
  ['jobs_string', { ...ciRun, jobs: '3' }],
  ['short_head_sha', { ...ciRun, head_sha: SHA.slice(0, 7) }],
  ['head_sha_missing', { ...ciRun, head_sha: undefined }]
]) {
  const r = ciBucket(ev);
  expect(r.bucket === 'unproven' && r.reasons.some((x) => x.startsWith('ci_run_not_completed_success(')), `ci_${name}_verified`);
}
expect(ciBucket({ ...ciRun, conclusion: 'action_required', jobs: 0 }).reasons[0].includes('conclusion:action_required') && ciBucket({ ...ciRun, conclusion: 'action_required', jobs: 0 }).reasons[0].includes('jobs:0'), 'ci_failure_reason_hidden');
// Tightened (was expected VERIFIED on 53a7157..13d5c8a): a non-success run beside a success no longer passes.
expect(classifyItem({ id: 'ci', claim: 'c', status: 'verified', scope: 'ci', subject_sha: SHA, evidence: [{ ...ciRun, conclusion: 'action_required', jobs: 0 }, ciRun] }, { now }).bucket === 'unproven', 'action_required_beside_success_verified');
expect(classifyItem({ id: 'ci', claim: 'c', status: 'verified', scope: 'ci', subject_sha: SHA, evidence: [ciRun, { ...ciRun, url: 'https://github.com/x/y/actions/runs/2' }] }, { now }).bucket === 'verified', 'two_success_runs_rejected');

// Regression (found on 6ca8125): a CI run on one commit verified a claim about another; nothing tied them.
const OTHER = '6ca81257262418417bf4e172e25209f9e14da8a5';
const ciClaim = (extra, evidence) => classifyItem({ id: 'cs', claim: `CI green on ${OTHER}`, status: 'verified', scope: 'ci', ...extra, evidence }, { now });
for (const [name, r, reason] of [
  ['run_on_other_commit', ciClaim({ subject_sha: OTHER }, [ciRun]), 'ci_run_head_sha_mismatch(subject:6ca8125,runs:13c0c94)'],
  ['url_names_subject_but_head_sha_differs', ciClaim({ subject_sha: OTHER }, [{ ...ciRun, url: `https://github.com/x/y/commit/${OTHER}/checks` }]), 'ci_run_head_sha_mismatch('],
  ['no_subject_sha', ciClaim({}, [ciRun]), 'ci_claim_missing_full_subject_sha'],
  ['short_subject_sha', ciClaim({ subject_sha: SHA.slice(0, 7) }, [ciRun]), 'ci_claim_missing_full_subject_sha'],
  ['uppercase_subject_sha', ciClaim({ subject_sha: SHA.toUpperCase() }, [ciRun]), 'ci_claim_missing_full_subject_sha'],
  ['short_head_sha_prefix_of_subject', ciClaim({ subject_sha: SHA }, [{ ...ciRun, head_sha: SHA.slice(0, 7) }]), 'ci_run_not_completed_success(head_sha:not_full_sha']
]) {
  expect(r.bucket === 'unproven' && r.reasons.some((x) => x.startsWith(reason)), `ci_subject_${name}_verified`);
}
expect(ciClaim({ subject_sha: SHA }, [ciRun]).bucket === 'verified', 'ci_subject_matching_run_rejected');
expect(ciClaim({ subject_sha: SHA }, [ciRun, { ...ciRun, head_sha: OTHER, conclusion: 'failure', url: 'https://github.com/x/y/actions/runs/9' }]).bucket === 'verified', 'ci_failure_on_other_commit_blocked_subject');
expect(ciClaim({ subject_sha: SHA }, [{ ...ciRun, head_sha: OTHER }, ciRun]).bucket === 'verified', 'ci_matching_run_beside_other_commit_rejected');
const unplaced = ciClaim({ subject_sha: SHA }, [ciRun, { kind: 'ci_run', status: 'completed', conclusion: 'failure', observed_at: fresh }]);
expect(unplaced.bucket === 'unproven' && unplaced.reasons[0].startsWith('conflicting_fresh_evidence('), 'ci_failure_without_head_sha_ignored');
// subject_sha does not change source/test classification.
expect(classifyItem({ id: 'st', claim: 'c', status: 'verified', scope: 'test', subject_sha: OTHER, evidence: [{ kind: 'test_run', ref: 'npm test', observed_at: fresh, exit_code: 0 }] }, { now }).bucket === 'verified', 'subject_sha_changed_test_scope');
expect(classifyItem({ id: 'ss', claim: 'c', status: 'verified', scope: 'source', subject_sha: OTHER, evidence: [{ kind: 'commit', ref: SHA, observed_at: fresh }] }, { now }).bucket === 'verified', 'subject_sha_changed_source_scope');

// Regression (found on 13d5c8a): one passing proof outweighed fresh failing ones for the same claim.
const passRun = { kind: 'test_run', ref: 'npm test', observed_at: '2026-10-19T10:00:00Z', exit_code: 0 };
for (const [name, items, scope] of [
  ['test_later_failure', [passRun, { ...passRun, observed_at: fresh, exit_code: 1 }], 'test'],
  ['test_unlinked_failure', [passRun, { kind: 'test_run', observed_at: fresh, exit_code: 2 }], 'test'],
  ['ci_other_workflow_failure', [ciRun, { ...ciRun, url: 'https://github.com/x/y/actions/runs/2', conclusion: 'failure' }], 'ci'],
  ['ci_cancelled', [ciRun, { ...ciRun, conclusion: 'cancelled' }], 'ci'],
  ['ci_timed_out_unlinked', [ciRun, { kind: 'ci_run', status: 'completed', conclusion: 'timed_out', observed_at: fresh }], 'ci']
]) {
  const r = classifyItem({ id: name, claim: 'c', status: 'verified', scope, subject_sha: SHA, evidence: items }, { now });
  expect(r.bucket === 'unproven' && r.reasons.some((x) => x.startsWith('conflicting_fresh_evidence(')), `${name}_verified`);
}
// Stale failures and still-running CI do not contradict; a lone pass still verifies.
expect(classifyItem({ id: 's', claim: 'c', status: 'verified', scope: 'test', evidence: [{ ...passRun, observed_at: fresh }, { ...passRun, observed_at: stale, exit_code: 1 }] }, { now }).bucket === 'verified', 'stale_failure_blocked_fresh_pass');
expect(classifyItem({ id: 'r', claim: 'c', status: 'verified', scope: 'ci', subject_sha: SHA, evidence: [ciRun, { ...ciRun, status: 'in_progress', conclusion: null }] }, { now }).bucket === 'verified', 'in_progress_run_counted_as_failure');
expect(classifyItem({ id: 'p', claim: 'c', status: 'verified', scope: 'test', evidence: [passRun] }, { now }).bucket === 'verified', 'lone_pass_rejected');

// Regression (found by Codex on 7663b38): observed_at in the future was accepted as fresh.
const future = '2026-10-19T12:30:00Z';
const skew = '2026-10-19T12:04:00Z';
const futureCases = [
  { id: 'f1', claim: 'c', status: 'verified', scope: 'source', evidence: [{ kind: 'commit', ref: SHA, observed_at: future }] },
  { id: 'f2', claim: 'c', status: 'verified', scope: 'test', evidence: [{ kind: 'test_run', ref: 'node x', observed_at: future, exit_code: 0 }] },
  { id: 'f3', claim: 'c', status: 'verified', scope: 'ci', subject_sha: SHA, evidence: [{ ...ciRun, observed_at: future }] },
  { id: 'f4', claim: 'c', status: 'verified', scope: 'source', evidence: [{ kind: 'commit', ref: SHA, observed_at: '2027-01-01T00:00:00Z' }] }
];
for (const item of futureCases) {
  const r = classifyItem(item, { now });
  expect(r.bucket === 'unproven' && r.reasons.includes('future_observed_at'), `${item.id}_future_observed_at_accepted`);
}
const futureProbe = classifyItem({ id: 'fp', claim: 'c', status: 'verified', scope: 'live_deployment', evidence: [{ kind: 'live_probe', url: 'https://example.invalid/health', observed_at: future, observed_by: 'operator', method: 'curl', result: 'HTTP 200' }] }, { now });
expect(!futureProbe.attested && futureProbe.reasons.includes('future_observed_at'), 'future_probe_attested');
expect(bucket({ id: 'sk', claim: 'c', status: 'verified', scope: 'source', evidence: [{ kind: 'commit', ref: SHA, observed_at: skew }] }) === 'verified', 'small_clock_skew_rejected');
expect(bucket({ id: 't', claim: 'c', status: 'verified', scope: 'test', evidence: [{ kind: 'test_run', ref: 'node x', observed_at: fresh, exit_code: 1 }] }) === 'unproven', 'failing_test_accepted');
expect(bucket({ id: 't', claim: 'c', status: 'verified', scope: 'test', evidence: [{ kind: 'test_run', ref: 'node x', observed_at: fresh, exit_code: 0 }] }) === 'verified', 'passing_test_rejected');
expect(bucket({ id: 'c', claim: 'c', status: 'verified', scope: 'ci', subject_sha: SHA, evidence: [{ kind: 'test_run', ref: 'local', observed_at: fresh, exit_code: 0 }] }) === 'unproven', 'local_test_counted_as_ci');

// In progress needs a branch/PR/issue link; blocked stays blocked.
expect(bucket({ id: 'p', claim: 'c', status: 'in_progress', evidence: [{ kind: 'plan', ref: 'doc' }] }) === 'unproven', 'in_progress_without_pr_accepted');
expect(bucket({ id: 'p', claim: 'c', status: 'in_progress', evidence: [{ kind: 'pr', url: 'https://github.com/x/y/pull/1' }] }) === 'in_progress', 'in_progress_with_pr_rejected');
expect(bucket({ id: 'b', claim: 'c', status: 'blocked', evidence: [{ kind: 'commit', ref: SHA, observed_at: fresh }] }) === 'unproven', 'blocked_promoted');

// Validation rejects malformed input instead of guessing.
expect(validateEvidence({}).length > 0, 'empty_doc_accepted');
expect(validateEvidence({ goal: 'g', repo: { name: 'r', ref: 'main' }, next_action: { task: 't' }, items: [{ id: 'x', claim: 'c', status: 'done' }] }).includes('item_x_bad_status'), 'bad_status_accepted');

// The committed handoff evidence renders deterministically and matches the committed prompt.
const evidencePath = 'handoffs/2026-10-19-continuity-handoff.evidence.json';
const doc = JSON.parse(await readFile(evidencePath, 'utf8'));
doc.source_file = evidencePath;
const prompt = buildPrompt(doc, { now: Date.parse(doc.generated_at) });
for (const heading of ['## VERIFIED DONE', '## IN PROGRESS', '## UNPROVEN / BLOCKED', '## ONE next action', '## Safety boundaries', '## Rollback', '## Next handoff must inspect', 'NOT DISPATCHED']) {
  expect(prompt.includes(heading), `missing_${heading}`);
}
expect(prompt === buildPrompt(doc, { now: Date.parse(doc.generated_at) }), 'non_deterministic_output');
const committed = await readFile('handoffs/2026-10-19-continuity-handoff.next-prompt.md', 'utf8');
expect(committed === prompt, 'committed_prompt_out_of_date (regenerate with the CLI command in docs/PI_CONTINUITY_HANDOFF.md)');

// CLI round trip writes the same output.
const dir = '.pi-test-continuity';
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
execFileSync('node', ['pi/continuity-handoff.mjs', '--evidence', evidencePath, '--now', doc.generated_at, '--out', `${dir}/p.md`]);
expect((await readFile(`${dir}/p.md`, 'utf8')) === prompt, 'cli_output_mismatch');
await rm(dir, { recursive: true, force: true });

// Provider-free: the builder must not open network connections or spawn processes.
const src = await readFile('pi/continuity-handoff.mjs', 'utf8');
for (const banned of ['fetch(', "'node:http", "'node:https", "'node:net", "'node:tls", "'node:dns", "'node:dgram", 'child_process', 'process.env', 'WebSocket']) {
  expect(!src.includes(banned), `provider_free_violation_${banned}`);
}

console.log(JSON.stringify({ ok: true, liveNeverVerified: true, sessionNeverVerified: true, probesAttestedOnly: true, artifactIntegrityChecked: true, fullShaRequired: true, ciNeedsCompletedSuccess: true, artifactSymlinkEscapeBlocked: true, crossPlatformCliEntry: true, conflictingEvidenceDemotes: true, ciTiedToSubjectSha: true, futureTimestampsRejected: true, linksRequired: true, freshnessEnforced: true, committedPromptCurrent: true, providerFree: true }));
