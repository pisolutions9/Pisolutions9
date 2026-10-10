# PI V1.02 release-candidate report

Date: 2026-10-10 (America/Chicago)

## Decision

**LOCAL CANDIDATE READY; PRODUCTION RELEASE BLOCKED**

The local candidate passes the complete repository-defined V1.02 release suite. This report does not authorize or claim a production deployment, live charging, certification, or independent review.

## Candidate identity

- Repository: `pi-v102`
- Branch: `fix/v102-provider-truth-20261009`
- Baseline commit: `9d5f539cad8eacb8ca9c767de500bfd46427fecd`
- Upstream relation at inspection: one commit ahead of `origin/main`
- Source files observed: 206
- Existing working-tree condition: `app.js` was reported modified before this audit, but `git diff` showed no content changes; Git reported only an LF-to-CRLF conversion warning. The file was preserved.
- Integrity record: `PI_V102_RELEASE_MANIFEST.json`

## Verification performed

The repository-defined `test:release:v1.02` graph was expanded and executed with the bundled Node.js runtime. It contains 74 test-script invocations and 71 unique test files.

Result: **PASS**

Covered suites include:

- V1 runtime, mission, recovery, evidence, state, routing, tooling, UI, cloud contract, and stress checks
- V1.02 commerce, customer journey, session persistence, provider fallback and budget, owner workspace, billing, completion, persistence, resume, execution-kernel, state-trace, Krishna, risk-policy, and owner-dashboard checks
- Customer reliability and UI behavior checks
- Payment-core checks
- Static secret-safety and browser-security policy checks

The first run was blocked by the Windows sandbox denying an atomic rename in its default temporary directory. The same suite was rerun with `TEMP` and `TMP` pointing to a writable directory inside the workspace. The atomic file-state test then passed, and the complete release gate exited successfully.

Provider-capacity and reviewer-timeout messages appeared in simulated fallback cases; their associated failover and fail-closed contract tests passed. These messages are test evidence for degraded-provider handling, not evidence that live providers are currently available.

## Release contract status

| Gate | Status | Evidence |
| --- | --- | --- |
| Local functional and regression suite | PASS | Complete `test:release:v1.02` execution |
| Stress/input matrix | PASS | 100/100 stress iterations and 5,000/5,000 input cases reported |
| Security policy/static secret checks | PASS | `security-static-test.mjs`, `browser-security-policy-test.mjs` |
| Deterministic capability and truth boundaries | PASS | V1.02 deterministic/provider contract suites |
| Owner workspace contract tests | PASS | Runtime and UI contract tests |
| Billing fail-closed behavior | PASS | Billing runtime, UI, and payment-core tests |
| Exact deployed candidate identity | BLOCKED | No deployment performed in this audit |
| Live browser end-to-end verification | BLOCKED | Requires an accessible deployed candidate |
| Production rollback rehearsal | BLOCKED | No production or staging deployment authorized |
| Independent reviewer sign-off | BLOCKED | Current work was reviewed by the same agent |
| Live charging | BLOCKED | Requires separate provider/webhook/entitlement evidence and owner authorization |

## Known boundaries

- Token/link-based private sync must not be described as authenticated ownership unless the deployed runtime proves server-controlled identity and authorization.
- A model review is not external factual proof or independent certification.
- Live research and external actions must fail closed when their configured providers or execution paths are unavailable.
- The existing deployment and live-browser claims in historical documents were not reverified during this local audit.
- Any source or configuration change after this report creates a new candidate and requires the complete gate to run again.

## Required owner-controlled release steps

1. Select the exact deployment target and confirm access to it.
2. Run the deployment gate against this exact candidate identity.
3. Perform live-browser tests on the deployed customer URL.
4. Exercise and record a rollback in the approved environment.
5. Obtain independent review of the candidate and its evidence.
6. Separately authorize any production publication or activation of live charging.

Until those steps are evidenced, PI V1.02 is a verified local candidate rather than an approved production release.

