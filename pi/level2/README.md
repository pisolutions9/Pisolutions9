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
