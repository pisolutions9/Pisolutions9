# PI V2 Release Contract

PI V2 is a release candidate only when all of the following pass on the same commit:

- the complete V1 regression suite;
- V2 mission-graph, bounded-parallelism, specialist-contract, policy, idempotency, runtime, independent-verification, and release-gate tests;
- customer UI safety and conversation tests;
- deterministic recovery tests without counting recovery as live-model success;
- deployment of the exact chat-worker candidate; and
- a genuine live model-backed customer smoke after deployment.

## V2 scope

V2 strengthens PI's orchestration foundation with bounded specialist execution, independent verification, evidence contracts, durable/idempotent runtime behavior, protected owner gates, recovery, and the approved minimal customer console.

## Truth boundary

A green local test suite proves code behavior only. Release evidence must be produced by the `PI V2 Release Gate` workflow for the exact candidate commit. An incomplete model answer, deterministic recovery response, stale deployment, or unrelated earlier green run cannot certify a V2 release.
