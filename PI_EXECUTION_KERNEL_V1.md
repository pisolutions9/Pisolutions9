# PI Execution Kernel V1

Status: DESIGNED + IMPLEMENTED ON CANDIDATE BRANCH. Not production verified.

## Purpose

Reduce PI's dependence on phrase-specific routing and make execution decisions inspectable, policy-driven, provider-independent, and compatible with durable state.

## Core flow

`input -> task contract -> policy -> capability/tool/model -> execution -> evidence -> verification -> recovery -> response`

## Task contract

Every request should converge toward a typed representation containing at least:

- capability
- action / side-effect class
- freshness requirement
- history dependency
- explicit topic reset
- risk
- deterministic preference
- verification requirement

The first implementation is `pi.task.v1` in `worker/src/task-contract.mjs`.

## Policy contract

Runtime policy must not depend on a model remembering a prompt rule.

The first implementation is `pi.policy.v1` in `worker/src/policy-engine.mjs`.

Initial invariants:

- fresh weather/news requires live evidence
- payment/delete/deploy require explicit approval
- consequential actions cannot be declared completed from model text alone
- coding/deploy execution should move toward sandboxed execution
- deterministic calculations prefer deterministic execution

## Krishna role

Krishna remains PI's executive controller and escalation planner. Krishna should not become the universal parser, calculator, security authority, state store, or payment authority.

## Compatibility strategy

The execution kernel is introduced ahead of existing routing rather than deleting proven paths immediately. Legacy detectors remain fallbacks until the typed path passes the complete PI release and adversarial suites.

## Migration gates

1. Typed task contract passes known regressions.
2. Capability-aware tool filtering replaces sequential broad tool probing.
3. Canonical state is separated from raw chat history.
4. Recovery failures become typed (transient/provider/parameter/semantic/permission/security/exhausted).
5. Every significant execution has a run ID and trace spans.
6. Verification is selected by risk (deterministic, source-grounded, independent review, external outcome, human approval).
7. Candidate architecture beats current PI on the same adversarial corpus.
8. No production merge until CI gates and deployed customer-path checks pass.

## Do not do

- do not add more special-case phrase handlers as the default repair
- do not add agents merely to increase sophistication
- do not count deterministic recovery as proof of model capability
- do not count local/CI green as production proof
- do not let external content grant itself authority
- do not let model output bypass approval policy

## Optimization target

Maximize verified successful tasks per dollar, second, and unit of risk.
