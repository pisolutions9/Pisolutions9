# PI Continuity Engine — Working Protocol v1
Created: 2026-10-19. Status: proposal on isolated non-production branch. NOT production-deployed.

## Mission
Use the existing PI, Claude City, ChatGPT/Codex, and X1 Forge assets to build a visually understandable, evidence-linked, capability-compounding engineering organization. City/game is the owner's interactive window into present verified reality and possible future states, not a substitute for real execution.

## Mandatory autonomous handoff at each session
1. Fetch fresh canonical source: pisolutions9/Pisolutions9, main. Inspect open issues, open/draft PRs, workflow gate states, last known deployment evidence. Read this file plus relevant task/PR evidence.
2. Summarize in exactly three buckets: VERIFIED DONE (with concrete links/tests), IN PROGRESS (with branch/PR), and UNPROVEN/BLOCKED. Do not promote a test, animation, plan, or merged PR to live success.
3. Select ONE smallest next action with highest measurable capability gain, favoring the existing reliability/configuration work over city aesthetics. Do not duplicate active PRs.
4. Produce a fresh continuation prompt containing: goal, exact repo/ref, input evidence/URLs, specific action, tests/acceptance criteria, safety boundaries, rollback, and what the NEXT handoff should inspect.
5. If an authorized execution tool is available, perform only reversible, provider-free work in isolated branches, run tests and save evidence. If Claude cannot be invoked, output a *ready-to-paste* Claude prompt and explicitly state it has NOT been dispatched.
6. At every session end, write a durable handoff in a safe branch or GitHub issue if accessible. Never allow an absent/halted model session to be misrepresented as running.
7. If a step needs owner action, record the exact minimum approval needed and independently proceed with other reversible, safe tasks.

## Current source-of-truth pointers (reinspect before using)
- Canonical production source ONLY: https://github.com/pisolutions9/Pisolutions9
- #213 Claude/Codex pilot: https://github.com/pisolutions9/Pisolutions9/issues/213
- #216 offline config validation: https://github.com/pisolutions9/Pisolutions9/issues/216
- PR #214 timing instrumentation DRAFT: https://github.com/pisolutions9/Pisolutions9/pull/214
- PR #215 alternate recovered timing implementation: https://github.com/pisolutions9/Pisolutions9/pull/215 — avoid duplicating/conflicting changes.
- PR #217 configuration validation DRAFT: https://github.com/pisolutions9/Pisolutions9/pull/217
- Historical production incident: fork workflows unexpectedly deployed a shared Worker and changed secrets. Reconcile variable *names* without reading values before any approved recovery action.
- Claude-connected fork PrEM21032/Pisolutions9 may be read-only from current integration (403); do not assume write or dispatch capabilities.

## Evidence and safety contract
- No deploy, merge, production secrets, Stripe/paid billing changes, paid model calls, purchases, hardware motion, or weakening gates without separate, explicit approval.
- Never exfiltrate credentials, log private messages, or fabricate verification.
- A green PR suite != deployed customer success; distinguish source, CI, live response, and physical evidence.
- Keep a minimal capability register: capability; baseline; evidence; reproducible test; dependency; owner approval; last verified; limitations.
- City should show REAL, PROPOSED, SIMULATED, and FAILED/BLOCKED states distinctly.

## Immediate work queue
A. Compare PR #214 and #215, check review and CI, identify safe deduplication strategy without merge.
B. Review PR #217's offline configuration validator against issue #216; flag limitations.
C. Produce a provider-free proposed first real City task linked to actual GitHub issue creation and independent confirmation, without claiming it already runs.
D. Define one measurable capability-gain experiment (baseline, new tool/skill, unseen transfer test, evidence).
E. Generate updated prompts for Claude and ChatGPT and update this handoff after each cycle.

## Claude continuation prompt template
You are Claude Code, implementation lead for the PI Capability Engine. Start by reading the canonical repository and PI Continuity Engine protocol, re-check issue #213, #216 and PRs #214/#215/#217 for CURRENT facts. Do not assume previous session state or access. Choose one reversible provider-free next task; inspect before coding; maintain existing tests, safety thresholds and deployment boundaries; implement only on an isolated branch when authorized access exists. Include commands, evidence, exact diff, rollback, blockers, and a next-session continuation prompt. Do not claim background operation or successful deployment without proof. In particular, never push/merge/deploy production. If repo access is denied, explain and supply portable patch/evidence, not fictitious completion.

## ChatGPT continuation prompt template
Audit PI continuity from fresh GitHub evidence. Separate verified from proposed, check priority of #213/#216 PR #214/#215/#217, perform one safe reversible improvement if authorized, and write the next Claude prompt plus status and evidence. Maintain owner gates and ensure City is a truthful visualization, not a simulated completion dashboard.
