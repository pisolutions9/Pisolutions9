# PI Labs — Agent Systems Reverse-Engineering Synthesis

Date: 2026-10-08
Status: research synthesis; not production-readiness evidence

## Objective

Extract reusable engineering patterns from leading publicly documented agent runtimes, multi-agent frameworks, coding agents, browser agents, memory systems, interoperability protocols, and orchestration research. Compare those patterns against PI's current architecture and identify the safest high-value changes for PI.

This work intentionally studies architecture and observable engineering patterns, not proprietary code, private implementations, or trade secrets.

## Systems and families studied

The survey covered the strongest publicly documented patterns available across:

- OpenAI Agents SDK and Responses/agent orchestration patterns
- Anthropic Claude Code / agentic coding patterns and permission modes
- Google Agent Development Kit (ADK)
- LangGraph / Deep Agents
- Microsoft AutoGen / Magentic-One / Semantic Kernel orchestration
- CrewAI Crews + Flows
- AWS Strands Agents
- Mastra
- Letta
- GitHub Copilot agents
- LlamaIndex agent/workflow patterns
- PydanticAI-style typed agent/tool patterns
- n8n, Dify, Langflow, Flowise-style visual/automation agent systems
- browser-use / browser-agent patterns
- MCP (Model Context Protocol)
- A2A (Agent2Agent Protocol)

The recurring lesson is that elite systems are not strong because they have many named agents. They are strong because they constrain coordination, state, tool use, verification, permissions, and recovery.

## The strongest recurring patterns

### 1. A small orchestration kernel beats unrestricted agent-to-agent conversation

Strong systems converge on one of a few patterns:

- supervisor/orchestrator delegates bounded subtasks;
- deterministic workflow controls the skeleton while models operate inside selected steps;
- handoffs are explicit and typed;
- agents-as-tools are preferred over unconstrained group chat when the task structure is known;
- multi-agent collaboration is used only when it adds measurable value.

Implication for PI: Krishna should remain the only cross-system orchestrator. Specialists should not form an unrestricted peer society. PI's manifest already states this correctly.

### 2. Separate planning from execution and progress tracking

Magentic-One's Orchestrator uses a task ledger plus a progress ledger and replans when progress stalls. Coding agents similarly separate plan mode from execution. Durable runtimes separate task state from model context.

Implication for PI: every mission should have distinct durable objects for:

- objective and constraints;
- plan/graph;
- current assignments;
- observations/evidence;
- progress/stall counters;
- permissions;
- cost/time budgets;
- completion criteria;
- recovery state.

Do not treat chat history as mission state.

### 3. Deterministic shell + agentic islands

LangGraph, CrewAI Flows, Mastra workflows, and enterprise orchestration patterns all converge on this: use deterministic code for invariants, authorization, sequencing, retries, schemas, and side-effect boundaries; use models for ambiguity, planning, synthesis, and adaptive reasoning.

Implication for PI: keep policy, permissions, idempotency, payment boundaries, state transitions, release gates, and evidence contracts deterministic. Use models only where uncertainty requires them.

### 4. Durable execution is a first-class capability

Elite runtimes persist checkpoints, task state, memory, and resumable execution. They support recovery after process death, interruption, or human approval.

Implication for PI: the current in-memory queue is insufficient for serious autonomous operation. The queue abstraction should persist queued/running/blocked/dead-letter state transactionally so restart does not lose work or duplicate side effects.

### 5. Memory must be layered, not one giant conversation

Letta strongly emphasizes persistent agent memory; LangGraph separates thread checkpoints from long-term stores; AutoGen exposes explicit memory protocols; Copilot has repository memory.

PI should distinguish:

- working context: current mission only;
- episodic history: prior runs and outcomes;
- semantic memory: stable learned facts/preferences;
- procedural memory: verified reusable skills/workflows;
- evidence/provenance store: claims and source records;
- audit memory: actions, approvals, failures and fixes.

Memory writes must be governed. A model should not silently convert guesses into durable truth.

### 6. Tools need contracts, identity, schemas, and evidence

OpenAI, MCP, Pydantic-style typed tools, AutoGen Workbench, and production frameworks all push toward explicit tool schemas. MCP additionally separates tools, resources, and prompts and supports structured outputs.

PI tool contract should require:

- stable tool ID and version;
- declared capability;
- input/output schema;
- side-effect classification;
- required permissions;
- timeout and retry semantics;
- idempotency support;
- cost estimate/budget class;
- evidence/provenance format;
- verification method;
- rollback/compensation behavior where possible.

### 7. Agent capability discovery should replace regex-only routing

Modern systems use structured descriptions, typed tool/agent metadata, capability discovery, model-assisted selection, or explicit workflow nodes. A2A formalizes discoverable capabilities for remote agents.

PI's current specialist router is regex-based and sequential. That is acceptable as a simple fallback, but it should not be the primary intelligence layer.

Recommended routing stack:

1. deterministic hard rules for security/current-data/payment/high-risk boundaries;
2. capability filter using typed specialist manifests;
3. planner/router selects the smallest sufficient team;
4. independent validator checks the route against objective, constraints and permissions;
5. cheap fallback route if planner confidence is low or provider unavailable.

### 8. Parallelism must be controlled by dependency graphs

AutoGen warns about state conflicts with parallel agent tools; workflow frameworks explicitly model concurrent branches; Magentic-style systems delegate selectively.

PI should parallelize only independent read-only or isolated work. Side effects against shared state should be serialized or protected by leases/transactions.

### 9. Verification must be heterogeneous

The strongest systems do not equate a second LLM opinion with truth. Verification methods should differ by claim/action type.

Examples:

- calculations -> deterministic recomputation;
- code -> tests/static checks/sandbox execution;
- web/current claims -> source/evidence checks;
- file mutation -> read-back/hash/state verification;
- payments -> provider-signed events + entitlement state;
- deployment -> live endpoint/browser behavior;
- agent output -> schema, consistency, and independent critique as secondary checks.

PI already has a strong principle here. The next step is capability-specific verification contracts.

### 10. Human approval must be a state transition, not an interrupting chat convention

OpenAI human review, Claude permission modes, LangGraph interrupts, Magentic-UI, and enterprise agent systems treat human intervention as a durable runtime state.

PI should persist `awaiting_approval` with:

- requested action;
- exact side effect;
- reason approval is needed;
- evidence collected so far;
- expiration/invalidating conditions;
- what resumes after approval.

Approval must apply to a specific action/version, not a vague mission-wide blanket.

### 11. Observability and evaluation are part of the runtime

OpenAI tracing, AutoGen events, LangSmith-style traces/evals, Copilot session control, Mastra eval loops, and AutoGenBench all show the same lesson: production agent quality requires inspectable trajectories and repeatable evaluation.

PI should capture per mission:

- route chosen and alternatives rejected;
- model/provider selected and why;
- tool calls;
- latency;
- cost;
- retries;
- evidence;
- verification results;
- owner approvals;
- stall/replan events;
- final outcome.

Then run regression suites over representative missions rather than judging quality from anecdotes.

### 12. More tools can reduce performance

Microsoft Research's tool-space interference work is especially relevant to PI. Adding overlapping browser, CLI, MCP, and API paths can confuse state and authorization. More capabilities can create worse routing and divergent state.

PI rule: a new tool/agent is admitted only if it has a clearly separated capability boundary or measurably improves success/cost/latency on a benchmark. Overlapping tools need an explicit precedence rule and canonical state owner.

### 13. Interoperability should be protocol-based

MCP is emerging as a standard agent-to-tool interface; A2A is designed for agent-to-agent interoperability across frameworks/vendors.

PI should avoid hard-binding Krishna to every provider or external agent. Instead:

- MCP-compatible tool adapter layer where appropriate;
- A2A-compatible boundary for external/remote agents when that produces real value;
- internal PI contracts remain provider/framework independent.

### 14. Model selection should be capability- and economics-aware

Strong frameworks support provider abstraction. The important pattern is not merely fallback; it is selecting models based on task requirements.

PI router should consider:

- tool-use reliability;
- reasoning difficulty;
- multimodality;
- context needs;
- latency ceiling;
- privacy/data locality;
- price ceiling;
- verified historical success on this task class.

Historical performance should eventually beat static model rankings.

## PI comparison

### PI is already strong in these architectural ideas

PI's current design already contains several principles found in strong systems:

- Krishna as central orchestrator;
- bounded specialist roles;
- provider independence;
- least privilege;
- explicit owner authority;
- independent verification requirement;
- evidence/provenance emphasis;
- retry/recovery paths;
- dead-letter concept;
- cost guard;
- idempotency intent;
- explicit release/evidence gates;
- distinction between a plan and a completed real-world action.

These are not cosmetic similarities; they are the correct direction.

### PI's biggest current architecture gap: implementation depth does not yet match the manifest

The team manifest is sophisticated, but some runtime components remain much simpler.

Examples observed in the current repository:

- `pi/specialist-router.mjs` uses regex domain matching and sequential delegation;
- `pi/queue.mjs` is process-memory only;
- durable mission state exists, but queue durability and distributed execution semantics remain incomplete;
- specialist selection does not yet use typed capabilities, historical performance, budgets, or confidence;
- the runtime has recovery/verification/guardrail hooks, but the system does not yet implement a general capability-specific verification registry;
- cross-agent state isolation and canonical ownership need stronger enforcement before broad parallelism;
- the owner/release plans correctly call for durable tasks, restart recovery, and real tool evidence, but those should be treated as hard prerequisites for higher autonomy.

## PI vNext architecture extracted from the best patterns

### Layer 1 — Objective contract

Normalize user request into a typed mission contract:

- goal;
- constraints;
- success criteria;
- freshness requirements;
- privacy level;
- risk level;
- time/cost budget;
- allowed side effects;
- owner approval requirements.

### Layer 2 — Capability registry

Each specialist/tool exposes a machine-readable manifest:

- capabilities;
- accepted input/output schemas;
- side-effect class;
- required permissions;
- model/tool dependencies;
- verification methods;
- expected cost/latency;
- historical benchmark metrics.

### Layer 3 — Krishna planner/router

Krishna creates the smallest sufficient graph, not the largest team.

Use four modes:

- `DIRECT`: simple deterministic/single-model task;
- `WORKFLOW`: known deterministic sequence with agentic steps;
- `SUPERVISED`: Krishna delegates to specialists and replans from observations;
- `ENSEMBLE`: multiple independent solvers only when expected accuracy gain justifies cost.

### Layer 4 — Durable mission ledger

Persist graph, step state, leases, evidence, approvals, retries, and artifacts. Resume exactly after interruption.

### Layer 5 — Execution boundary

Tools run through capability contracts. Side effects are idempotent, permission-gated and evidence-producing. Unverified external action never becomes `completed`.

### Layer 6 — Verification mesh

Select verifier by output/action type. Prefer deterministic or external evidence checks over model self-review.

### Layer 7 — Recovery controller

Detect:

- transient failure;
- provider failure;
- tool failure;
- permission failure;
- stale/contradictory evidence;
- plan stall;
- verifier failure;
- budget exhaustion.

Then choose retry, alternate provider, alternate tool, replan, degrade, or owner escalation.

### Layer 8 — Memory/learning

Only validated outcomes become durable procedural/semantic memory. Failed trajectories become structured lessons with provenance, not unfiltered prompt text.

### Layer 9 — Evaluation loop

Maintain a benchmark corpus of real PI tasks. Every architecture/model/tool change runs against:

- task success;
- verification pass rate;
- unsafe action rate;
- latency;
- cost;
- retries;
- unnecessary agent/tool count;
- owner interruption rate.

Do not promote a new pattern because it looks sophisticated.

## Highest-value implementation order

1. Replace regex-only specialist selection with a typed capability registry while keeping regex as fail-safe fallback.
2. Make mission queue/task graph durable with leases, restart recovery and idempotent step execution.
3. Add task/progress ledgers and explicit stall/replan thresholds inspired by Magentic-One.
4. Introduce capability-specific verifier registry.
5. Split memory into working, episodic, semantic, procedural, evidence and audit layers.
6. Add structured `awaiting_approval` state with action-scoped approvals.
7. Add routing/model scorecards based on real PI benchmark outcomes.
8. Add MCP adapters only where tools are useful and non-overlapping; add precedence rules to prevent tool-space interference.
9. Add A2A only for external agents that offer capabilities PI cannot economically provide internally.
10. Build owner visualization from actual traces rather than using a visual office as the architecture itself.

## What PI should NOT copy

- large agent counts for appearance;
- unrestricted group chats;
- every agent seeing all context;
- agents editing shared state without ownership rules;
- LLM-only verification;
- autonomous retries without budgets;
- auto-learning from unverified model output;
- many overlapping tools for the same capability;
- framework lock-in;
- claims of completion based on plan generation or internal mock success.

## Proposed acceptance tests for the architecture

Before merging runtime implementations derived from this research, prove at least:

1. routing picks fewer agents for simple work and specialists only when justified;
2. a process crash mid-mission resumes without duplicate external side effects;
3. parallel read-only branches execute safely while conflicting writes serialize;
4. an incorrect specialist result is rejected by an independent verifier;
5. stale current-data output cannot pass as fresh evidence;
6. a high-risk side effect persists as `awaiting_approval`, then resumes only for the approved action;
7. provider failure causes bounded fallback without retry storms;
8. overlapping tools have deterministic precedence and canonical state;
9. memory never promotes a failed/unverified claim to durable fact;
10. benchmark results show a measurable improvement over the current PI route/queue architecture.

## Bottom line

PI does not need to become a clone of OpenAI Agents, Claude Code, LangGraph, AutoGen, CrewAI, Letta, or any other system. Its existing architectural principles are directionally strong. The main opportunity is to turn those principles into deeper runtime contracts: typed capability discovery, durable execution, task/progress ledgers, heterogeneous verification, layered memory, action-scoped approvals, disciplined interoperability, and benchmark-driven routing.

The target architecture is: **one orchestrator, the smallest sufficient team, explicit contracts, durable state, evidence-backed actions, independent verification, bounded recovery, and measurable learning.**
