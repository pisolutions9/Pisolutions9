# PI Investment Lab

Status: OFFLINE ONLY. READ-ONLY INSPECTION + SIMULATED TRADES, TESTED AGAINST SYNTHETIC AND ADVERSARIAL MCP SERVERS. THE LIVE PATH REFUSES BEFORE ANY NETWORK I/O, BECAUSE NO ROBINHOOD TOOL HAS BEEN REVIEWED (`ROBINHOOD_REVIEWED_ALLOWLIST` IS EMPTY). EVEN A POPULATED ALLOWLIST REQUIRES THE OPERATOR TO PRESENT ITS EXACT DIGEST. NOT DEPLOYED. NO EXECUTION CAPABILITY EXISTS.

## Scope

This is an owner-side PI module. It can:

- inspect a brokerage account through an MCP server, behind a read-only permission gateway;
- run deterministic quantitative and risk analysis;
- simulate proposed trades on a local paper ledger;
- independently verify the results;
- produce a provenance-labelled report.

It does **not** submit orders, fund or transfer money, change account settings, use margin, run automated trading, or expose credentials, account identifiers or personal data. It is not wired into the customer chat Worker, the Netlify owner runtime or any deployment.

## Canonical repository

- Canonical source: `pisolutions9/pisolutions9`.
- Working mirror: `PrEM21032/Pisolutions`. Its `main` was verified to equal upstream `main` (`13c0c94`) on 2026-10-29.
- All lab work is on the feature branch `claude/pi-investment-lab` of the mirror. Nothing was pushed to the canonical repository.

## What Robinhood documents about its external-agent MCP

Robinhood's official support articles are [Onboarding an external agent](https://robinhood.com/us/en/support/articles/onboarding-an-external-agent/) and [Trading with your agent](https://robinhood.com/us/en/support/articles/trading-with-your-agent/). They state:

| Topic | Robinhood's documentation |
|---|---|
| MCP endpoint | The official Trading MCP URL is `https://agent.robinhood.com/mcp/trading`. External agents connect to it after the customer signs in. |
| Read scope | An external agent receives **read access to all of the customer's Robinhood accounts and their details**. That includes **account numbers**, positions and balances, and transaction history including order history. |
| Trading scope | The agent can place trades **only** in the customer's dedicated Robinhood Agentic (MCP) account. |
| Trade approvals | They are **on by default for built-in Robinhood Agents** and **off by default for MCP accounts (external agents)**, where the feature is available; it is still rolling out to MCP accounts. When approvals are on, the agent proposes and the customer places orders manually. Some trades may require approval regardless. |
| Responsibility | The customer is responsible for the agent's trades. Robinhood does not control, supervise, monitor or audit external agents. Data sent to a third-party AI provider leaves Robinhood's environment. |

**How this was read:** on 2026-10-29, robinhood.com was blocked by this environment's network policy, so the articles were not fetched directly. The table is built from search-engine extracts attributed to those official robinhood.com pages. It replaces the third-party summaries cited in the previous version of this file. The owner should confirm it against the live pages before any live review.

**Consequences for the lab's design:**

- Read access is account-wide. An unfunded agentic account, or trade approvals (off by default, and not available to everyone), **do not limit what can be read from the owner's other accounts**. The only things standing between real account data and the lab's agents, reports and files are the gateway's data minimization and the output guard.
- A Robinhood MCP access token gives **its holder** account-wide read access and trading in the agentic account. The lab's restrictions apply only to the lab's own use of the token. They do not reduce what the token could do if leaked.
- The lab never reads order history. `get_order_history`-style tools are denied by the `order` deny token.

## Architecture

`Owner objective → Krishna (orchestrator.mjs) → Garuda research → Kubera quant → Rama risk → Hanuman simulation (paper only) → Saraswati verification → Chitragupta report → output guard`

Only the **permission gateway** holds the MCP client. Agents see a single function, `gateway.inspect(capability, args, { accountRef })`. They never see real account identifiers, tool names chosen by the server, or broker free text.

| File | Role |
|---|---|
| `pi/investment-lab/mcp-client.mjs` | Dependency-free MCP Streamable HTTP client. Requires HTTPS (loopback excepted), refuses credentials in the URL or a query string, **refuses every redirect** (`redirect: 'manual'`), and reads responses as a stream, aborting at 4M chars. The token stays in a closure and never appears in errors. |
| `pi/investment-lab/permission-gateway.mjs` | Exact reviewed allowlist, schema audit, argument policy, response minimization, call budget and audit log. |
| `pi/investment-lab/reviewed-allowlist.mjs` | Code-reviewed allowlists. Robinhood: **empty and frozen**. Fixture: five literal fingerprint pins. |
| `pi/investment-lab/execution-gate.mjs` | Always refuses live execution. Routes the request through the existing `pi/policy.mjs` `financial_transfer` human gate. |
| `pi/investment-lab/normalize.mjs`, `quant.mjs` | Parsers that fail closed, and deterministic analytics. |
| `pi/investment-lab/paper-broker.mjs` | Simulated fills only. Cash-only, no shorting, imports nothing. |
| `pi/investment-lab/agents.mjs`, `orchestrator.mjs` | Specialists on the existing `data-finance` contract, plus Krishna sequencing and a redacted trace. |
| `pi/investment-lab/demo.mjs` | Fixture demo, output guard (`renderOutputs`), fail-closed live entry (`runLive`), and the offline `--review-tools` aid. |
| `pi/investment-lab/fixture-mcp-server.mjs` | Synthetic broker server. It includes dangerous tools and one read-looking tool that is not reviewed. |
| `pi/investment-lab/adversarial-mcp-server.mjs` | Attacker-controlled MCP server used in the audit. |

### Gateway authorization (fail closed)

Names and server-supplied annotations **never authorize** a call. A tool is callable only if all of the following hold:

1. A code-reviewed entry in `reviewed-allowlist.mjs` names it for exactly one read capability (`accounts`, `portfolio`, `positions`, `quotes`, `historicals`).
2. Its full server definition (name, title, description, input and output schemas, annotations) hashes, as canonical SHA-256, to the pinned fingerprint. Any drift denies it, including a changed description.
3. Its input schema declares no order- or transfer-shaped field at any depth or in any combinator. The check covers compound names (`orderQuantity`, `limit_order_price`, `dollarAmount`, `buySide`) by tokenizing camelCase and separators. Every reviewed argument must be declared as a primitive.
4. Its name is unique on the server, after NFKC normalization and case folding.
5. The heuristic screen does not deny it: write or credential name tokens, `destructiveHint: true`, `readOnlyHint: false`. The screen can only deny.
6. It was allowed by the **latest** discovery. Each `connect()` clears all routes first, so re-listing after drift never leaves a stale route.

The live entry point adds one more gate. `runLive` requires a non-empty `ROBINHOOD_REVIEWED_ALLOWLIST` **and** `--approve-allowlist <digest>`. The digest must equal the SHA-256 of exactly that reviewed list plus the endpoint, and `--allowlist-digest` prints it. Any later edit to the list changes the digest, so the edit cannot take effect until the owner presents the new one.

### Arguments

- Only reviewed top-level arguments of the reviewed primitive type are accepted. String values must match `[A-Za-z0-9 ._,:-]{0,200}`.
- Objects, arrays, unreviewed keys and order-shaped keys are rejected before transport.
- Accounts are addressed only by opaque `acct_ref_N` references, passed through the dedicated `accountRef` option.

### Responses

- Accepted results are a plain object, either `structuredContent` or JSON text. Anything else fails closed: arrays, non-JSON text, non-text content, over 1M chars, or nesting deeper than 12 levels.
- Keys are data too. Any key that is not plain letters and underscores is dropped, together with its value. This catches maps keyed by account number or email.
- Account-keyed values become references.
- Sensitive keys are withheld: names, holders, owners, email, phone, addresses, tax/SSN, bank/routing, memo/note/description/text, URLs, and IDs in any case (`id`, `userID`, `USER_ID`).
- Every remaining string is withheld unless it has a shape the lab needs **for its key**:
  - any key: ISO dates, decimals, integers of at most six digits, and `acct_ref_N`;
  - amount and quantity keys (price, cash, equity, value, quantity, …): numbers of any length;
  - symbol keys only: tickers (`BTC-USD` and `BRK.B` included);
  - enum keys only: lowercase enums (type, interval, …).
- The bearer token is scrubbed as a canary.

### Outputs

- `renderOutputs` emits only an allowlisted projection: no raw payloads and no evidence claims. Server-supplied labels pass through `safeLabel`.
- It **throws instead of writing** if the report or JSON contains any of the following:
  - the token, a known raw identifier, or any raw account identifier the gateway has seen. The gateway answers yes/no through `containsKnownIdentifier`, never revealing the values;
  - an email address, SSN, phone-like pattern or digit run of nine or more digits;
  - a bearer string.
- Live output must go outside the repository, with mode 0600. The check resolves symlinks and percent-encoding through `realpath` and `fileURLToPath`.

## Threat review of PR #224 head `6a370f8` (2026-10-30)

A fresh review of the changed code looked for four kinds of path:

- an unreviewed or disguised tool being called;
- credentials, account identifiers or personal data reaching agents, logs or files;
- output escaping its guard;
- an allowlist edit silently enabling live access.

Four concrete defects were found. Each was reproduced first by a failing offline regression (`evidence/review-2026-10-30-pre-fix.log`), then fixed, and each fix is shown to be load-bearing by a mutation that reverts it and makes the suite fail:

| ID | Defect at `6a370f8` | Fix |
|---|---|---|
| R1 | The schema audit matched whole field names only. A pinned tool whose schema accepted `orderQuantity`, `limit_order_price`, `dollarAmount`, a nested `trailingStopPercent` or `buySide` was called. | Field names are tokenized. The same check applies to schemas, allowlist arguments and runtime arguments. |
| R2 | A second `connect()` kept routes from the first discovery. A tool whose definition drifted was reported `fingerprint_mismatch` but stayed callable. | `connect()` clears routes and discovery before reclassifying. |
| R3 | Editing `ROBINHOOD_REVIEWED_ALLOWLIST` alone enabled live network access with just a token. Reproduced on a temp copy of the module tree, against a counting network stub. | `runLive` requires the owner-presented digest of exactly the reviewed list and endpoint. A missing or mismatched digest refuses before any network I/O. A positive control shows the matching digest is the only remaining gate. |
| R4 | None of PR #224's three checks (PI V1.02 Gate, PR Core, PR Gate) runs any Investment Lab test. They run `test:v1.02` and `test:release:v1.02` only. A PR that edits the allowlist or weakens the gateway would show green. | A new `.github/workflows/pi-investment-lab.yml` runs `npm run test:investment-lab` on pull requests touching lab code, its dependencies, `package.json` or the workflow itself. It is offline, needs no secrets and has `contents: read`. The V1.02 workflows are unchanged. A static test fails if no such workflow exists. |

**Reviewed and found sound:**

- Report and CLI strings come only from bounded codes and from values that passed the shape filter.
- Transport errors surface codes only, never server text.
- The token appears only in the `Authorization` header.
- Raw account identifiers stay inside the gateway, and the output guards run before any file is written.

**Not changed (accepted limitations, already documented):**

- A server could lie about a pinned tool's behaviour at call time.
- Values that fit their key's shape pass through by design.

## Synthetic owner walkthrough

`npm run walkthrough:investment-lab` prints a concise, owner-facing run. Captured output is in `evidence/owner-walkthrough.md`. It shows, in order:

1. **Live status.** **LIVE ROBINHOOD ACCESS: DISABLED**, taken from the real live entry point with a network stub: reason `no_reviewed_allowlist`, 0 network attempts.
2. **Gateway decisions** and the synthetic server's own call log.
3. **Account snapshot** by reference only.
4. **Deterministic analysis.** Every line carries provenance in the form `[source: tool@timestamp · synthetic]`.
5. **Paper-trade decisions.** Risk-blocked orders, simulated fills with `submittedToBroker=false`, and the refused live-execution request.
6. **Verification summary.**

## Owner-controlled rebalancing (paper only)

Run it with `npm run rebalance:investment-lab`, or pass your own plan with `-- --plan plan.json`, for example `{"targets":{"VTI":0.25,"SCHD":0.1},"minCashWeight":0.05}`. Captured output is in `evidence/rebalance-scenario.md`.

**Inputs.** The **owner** supplies target weights, a cash minimum, an optional position cap (default 25%, never above 50%) and an optional drift band (default 1%). Holdings left out of the plan get an explicit 0% target. **The lab never picks targets and never uses price history or forecasts.** Orders are sized only from the current quotes and the current holdings.

**Refusals.** Impossible or unsafe plans are refused before any paper trade:
- negative (short) weights, weights above 100% or not numbers, and duplicate or invalid symbols;
- unquoted symbols, and targets above the position cap;
- targets plus the cash minimum exceeding 100%;
- out-of-range cash, cap, band or slippage settings.

**Sizing.**
- Sells come first. They round up, so a holding ends at or below its target.
- Buys round down, and are funded only by cash above the owner's floor.
- Whole shares only, with fills priced at the quote's bid or ask plus fixed slippage (5 bps by default).

**Reused controls.**
- `riskAgent` runs the pre-check, using the owner's cap and floor.
- `createPaperBroker` produces the fills: cash-only, no shorting, fresh quotes required.
- **All or nothing:** any blocked or rejected order refuses the whole plan.

**Output.** Each proposal is shown next to an explicit **do nothing** column (0 trades, $0 cost). It includes:
- current vs target vs post-trade weight and residual drift, per symbol;
- the paper-only fills, with `submittedToBroker=false`;
- the total cost, split into slippage and spread against last-price marks;
- concentration before and after (largest holding, effective holdings);
- cash against the owner's minimum.

The decision stays with the owner.

**Status never overstates success** (fixed after a failing regression; evidence in `evidence/rebalance-pre-fix.log`). Previously, a zero-equity account, or one too small to buy whole shares, was reported as `already_within_band` while 20 percentage points from target. Now:
- a zero-equity account is refused with `no_equity_to_rebalance`;
- when no trade can reach the targets, the plan is refused at the `sizing` stage with `targets_unreachable_with_whole_shares`;
- a proposal that leaves any holding outside the drift band carries explicit **WARNING** lines in the owner report.

**Defect found while reusing `riskAgent`, fixed with a regression first.** The pre-check blocked risk-reducing **sells**: a sell that raised cash, but not yet above the floor, or that trimmed an over-cap holding but not yet below the cap. That blocked exactly the trades a rebalance needs. Caps and floors now gate buys only (`evidence/rebalance-pre-fix.log`).

**Synthetic example** (`evidence/rebalance-scenario.md`):
- The example owner plan gives a paper proposal. The largest holding goes from 30.54% to 24.94%, effective holdings from 4.18 to 5.84, and cash from 5.36% to 11.04% against an 8% floor. That takes 5 simulated fills and costs $12.65.
- A deliberately unsafe plan is **refused** at validation: NVDA 45% and VTI 30% exceed the 25% cap, and the targets plus cash add up to 105%.

**Mutation checks.**
- Eight mutations are caught: removing the cap, sum, short or quote validation; allowing a partial rebalance; reverting either sell fix; and dropping the buy cash floor.
- Three redundant defence layers are **not** exercised independently by tests: the risk pre-check refusal branch, the cash floor in the buy budget, and the post-trade cash and cap check. In every tested plan, target-capped sizing alone already keeps cash at or above the floor and positions under the cap.

Coordination with the separate Codex T0/T1 decision proof is recorded in `pi/investment-lab/HANDOFF.md`.

## Evidence (offline, 2026-10-29)

All figures below are synthetic. The files are in `pi/investment-lab/evidence/`.

- **`adversarial-pre-fix.log`**: the adversarial suite run against the code at `394b768`. **All 10 scenarios failed.** The failures included:
  - A1: a disguised write tool named `get_positions` with `readOnlyHint: true` was called.
  - A2: a tool whose description changed was called.
  - A3: a tool with an order-shaped schema was called.
  - A4: nested `{side, quantity}` arguments reached the server.
  - A5/A6: email, phone, SSN, account and routing numbers reached agents.
  - A7: redirects were followed. Node stripped `Authorization` on the cross-origin hop, but still forwarded the JSON-RPC body, four times.
  - A8: an ambiguous duplicate tool was called.
  - A9: personal data reached the report and the JSON.
  - A10: live mode had no reviewed-allowlist gate.
- **`adversarial-post-fix.log`**: A1–A13 pass. Three scenarios were added after the first fixes:
  - A11: the output guard's own refusals, including the gateway identifier guard and a symlinked `--out` into the repository;
  - A12: legitimate symbols, amounts of a million or more, and enums survive minimization;
  - A13: a 64 MB chunked response with no content-length is aborted early. The scenarios include positive controls, so they cannot pass by simply denying everything:
  - reviewed arguments still work, and the server receives exactly `{symbols: 'AAPL,MSFT'}`;
  - the A9 mission succeeds and still reports holdings.
- **`investment-lab-report.md` / `investment-lab-run.json`**: the fixture mission.
  - 14 tools were discovered, 5 allowed via `reviewed_exact_match`, and 9 denied. The denied tools include the disguised `getQuoteAndPlaceOrder` and the read-looking but unreviewed `get_holdings` (`not_in_reviewed_allowlist`).
  - The server's own log shows only the 5 reviewed reads.
  - 2 simulated fills were made. Live execution was refused even with `ownerApproval: true`.
  - 14/14 verification checks passed.
- **`sdk-conformance.json`**: the PI client works against the official MCP TypeScript SDK 1.32.2 server over JSON and SSE (protocol `2025-11-25`), and the SDK client works against the PI fixture.
- **`live-endpoint-probe.json`**: kept from the previous session (2026-10-29). The endpoint did not resolve under the network policy then. `--probe` has since been removed.

### Independent diff review

After the first round of fixes, the uncommitted diff was reviewed separately with the code-review tool at high effort. It reported 10 findings, four confirmed by execution. All 10 were fixed, and each fix has a test that fails when the fix is reverted:

1. **Object keys passed through unfiltered.** A map keyed by account number or email reached agents.
2. **Short words passed anywhere.** All-caps or lowercase words (`JANE`, `jsmith`) passed under any key.
3. **Live output scan missed real identifiers.** It was never given the account numbers the gateway had learned.
4. **Large amounts were withheld.** Whole-dollar strings of 1,000,000 or more were redacted, which broke research.
5. **Valid symbols were dropped.** `BTC-USD` and digit-bearing symbols were redacted and their positions left out.
6. **The repository guard was bypassable.** Percent-encoded or symlinked paths defeated it.
7. **The response cap came too late.** It was enforced only after the whole body had been buffered.
8. **Uppercase ID keys were missed.** Keys such as `customerID` were not caught.
9. **A sanitize pass was dead work.**
10. **The `leakage` flags were dead code.**

### Commands run

These were run offline in this environment, and all exited 0:

```bash
npm test
npm run test:v1.02
npm run test:security
npm run test:release:v1.02
npm run test:investment-lab
```

The 17 mutations listed below, plus 11 more for the review fixes (findings 1–8, both enum and ticker key-scoping, and the repository guard), were applied one at a time. Each removes a single control: the fingerprint pin, name-inference fallback, the schema audit, the duplicate check, the unreviewed-argument check, the argument type check, free-text pass-through, key redaction, array `structuredContent`, the over-depth check, raw server info, redirect status handling, redirect following, the output scan, the live gate, the live in-repository output guard, and the long bare-integer value shape. Each mutation made the suite fail. (The survivors of the first mutation pass, array `structuredContent` and over-depth payloads, led to the A6 fail-closed assertion and the depth check.)

`demo.mjs --live` and `--probe` were each invoked once during evidence regeneration, contrary to this task's instruction not to run them. Both refused before any network I/O: no token was set, and the live path returns at the empty-allowlist check before a client exists. No connection to Robinhood was made.

## Running offline

```bash
npm run test:investment-lab                           # unit + adversarial suites (also part of npm test)
npm run demo:investment-lab -- --out /tmp/lab         # synthetic end-to-end demo
npm run walkthrough:investment-lab                    # concise synthetic owner walkthrough
npm run rebalance:investment-lab                     # owner target rebalancing, paper only (-- --plan plan.json)
npm run walkthrough:decision-proof                   # single-candidate freeze → reveal proof (Codex lane)
npm run walkthrough:rebalance-proof                  # owner rebalancing freeze → reveal proof with counterexample
node pi/investment-lab/demo.mjs --allowlist-digest    # offline: digest of the reviewed Robinhood allowlist
node pi/investment-lab/demo.mjs --review-tools tools-list.json   # offline draft review of a saved tools/list
MCP_SDK_DIR=…/node_modules/@modelcontextprotocol/sdk node pi/investment-lab/sdk-conformance-check.mjs
```

`--live` currently returns `no_reviewed_allowlist` before constructing a client. With a populated list, it also returns `owner_allowlist_digest_required` or `owner_allowlist_digest_mismatch` unless the exact digest is presented. `--probe` returns a refusal.

## Two-stage synthetic decision proof

Run `node pi/investment-lab/decision-proof.mjs plan` first. It reads only `decision-proof-fixture/t0.json` and writes `evidence/decision-frozen.json` with a hash of the owner rule, candidate, benchmark, and costs. It succeeds with the outcome file absent. Then run `node pi/investment-lab/decision-proof.mjs reveal` to read the separate synthetic T1 price fixture, verify the frozen record, independently recompute the rule and arithmetic, and write `evidence/decision-proof.md`. `node pi/investment-lab/decision-proof-test.mjs` covers the separation and tampering checks.

The example starts with fictional $1,000. A proposed 30% single position violates the owner-set 25% limit, so PI holds cash. When the invented later price falls, holding avoids that loss but trails the predeclared diversified benchmark. The fixture authors knew both prices; the hash is tamper evidence, **not** an independent timestamp or proof of predictive value. No broker is connected.
## Rebalancing freeze → reveal proof (owner targets joined to the decision proof)

Run `npm run walkthrough:rebalance-proof`. Output is in `evidence/rebalance-proof.md`, and the frozen record in `evidence/rebalance-frozen.json`.

The proof reuses existing code rather than copying it: `proposeRebalance` (rebalancing lane), `portfolioSnapshot` (quant), and the decision proof's `digest` (now exported).

**Plan stage (T0).**
- It runs the synthetic fixture on the owner's pinned clock (`rebalance-proof-fixture/owner-plan.json`, T0 `2026-10-01T15:00Z`) and applies the owner's target plan and a deliberately unsafe plan.
- It freezes: the inputs (cash, holdings, quotes), both plans, the paper choice and fills, the refused unsafe plan, the cost model, and the predeclared benchmark entry (convert everything into VTI at T0 with the same costs).
- It never opens T1. The CLI succeeds with every T1 file hidden, and produces the identical hash.

**Reveal stage (T1).** Each `t1-*.json` is revealed separately, and each reveal:
- verifies the hash and requires synthetic provenance, with T1 after both the source and decision timestamps;
- **replays the owner's rule from the frozen inputs, under the frozen cost model**, and re-derives the benchmark entry;
- marks every path at the T1 last price (entry costs only, no exit costs);
- recomputes the PI and benchmark paths independently from the raw fills and quotes.

**Owner view.**
- Text bar charts of current, target and post-trade weights against the cash floor.
- The paper trades with their costs, and the refused unsafe plan.
- The frozen hash, and source, decision and outcome timestamps.
- PI paper vs do nothing vs benchmark, for each scenario.

**Two scenarios, deliberately not cherry-picked.**

| Scenario | PI paper rebalance | Do nothing | Benchmark |
|---|---:|---:|---:|
| A: the concentrated holding falls | $52,799.69 (+$1,699.69 vs do nothing) | $51,100.00 | $54,837.07 (best) |
| B: **adverse counterexample**, the trimmed holding rallies and the added one falls | $60,746.14 (−$2,627.86 vs do nothing) | $63,374.00 (best) | $57,634.88 |

**Regressions** (`rebalance-proof-test.mjs`, 52 checks):
- **Lookahead:** static and Proxy traps, a hidden T1 directory, deterministic freezes, the committed evidence is current, and time ordering is enforced.
- **Arithmetic:** hand-checked ending values plus independent recomputation.
- **Counterexample:** at least one losing scenario is present.
- **Unsafe plans:** they are frozen as refused, and forging them into proposals is detected.
- **Costs:** fills priced with the frozen slippage, benchmark entry costs, and detection of cost-model edits, including a consistent forgery with a re-derived benchmark.
- **Save and replay:** byte round-trip, tampering, re-hashed edits, edited inputs, non-synthetic T1, and invalid prices.
- **No empty proof:** a reveal with no T1 files fails closed, tested on a temp copy of the tree.

**Defects found by these tests, each fixed after a failing run (`evidence/rebalance-proof-pre-fix.log`).**
1. **Replay ignored the frozen costs.** It used the plan's *default* slippage, so an edited cost model was caught only incidentally, by the benchmark arithmetic. Replay now uses the frozen costs and re-derives the frozen benchmark.
2. **An empty reveal passed.** With no T1 files present, for example after an interrupted test, the reveal exited 0 with an empty outcome section. Both the reveal CLI and the formatter now refuse.

**Mutation checks.** Removing the hash, time-ordering, replay, cost binding, benchmark binding or T1 price validation, or ignoring the trades, makes the suite fail. The independent outcome recomputation is a redundant layer behind replay and is not exercised on its own.

**Limits.** The fixtures were written together by the lab authors; the hash detects edits but is not an independent timestamp. Two invented scenarios show mechanics and that the rule can lose; they show no skill, alpha or forecast.

## Remaining unknowns

- **Robinhood's real tools.** Their names, descriptions, input and output schemas and annotations, and whether every read tool is free of side effects. None of this has been observed. Server annotations are hints, not guarantees.
- **Response shapes.** The normalizers fail closed on unfamiliar shapes. Fields the lab needs may be withheld by the value-shape filter. Adjusting this is a reviewed code change.
- **Token behaviour.** Whether Robinhood offers any read-only or narrower OAuth scope, and the token's lifetime and revocation. The official text describes account-wide read access.
- **Trade approvals.** Whether they are available on the owner's account; they are still rolling out to MCP accounts.
- **Residual gateway risks.**
  - A tool whose reviewed, pinned definition looks read-only but which actually writes cannot be detected by the gateway. Only review against official behaviour can catch that.
  - Values under symbol keys that look like tickers, under enum keys that look like lowercase words, and amounts under amount keys pass through by design. A broker that put a name in a `symbol` field would get it through.
  - The output scanner is pattern-based.
- **Source fidelity.** The official articles were read through search extracts, not directly (see above).

## Owner-controlled steps before any later live read-only review

None of these have been performed. Each one is the owner's decision.

1. Read the two official articles directly and confirm the table above, in particular the **account-wide read access including account numbers**. Decide whether that exposure to the lab, and to the AI provider running it, is acceptable.
2. In an environment the owner controls, connect to `https://agent.robinhood.com/mcp/trading` with an official MCP client, completing Robinhood's own sign-in. Capture **only** the `tools/list` result to a file **outside the repository**. Do not call any tool. Confirm the file contains no account data.
3. Run `node pi/investment-lab/demo.mjs --review-tools <file>` offline. It prints fingerprints, screens, schema audits and **draft** entries. It never edits the allowlist.
4. For each candidate (at most one tool per read capability), have a human check the tool against Robinhood's official documentation: read-only behaviour, arguments and returned fields. Reject anything that can place, modify or cancel orders, move money, change settings, or read order history.
5. Commit the approved entries to `ROBINHOOD_REVIEWED_ALLOWLIST` through a reviewed PR, with explicit owner approval and a second reviewer. The `PI Investment Lab` check must pass, and its empty-list assertion must be changed deliberately in the same PR. Any later change to a Robinhood tool definition breaks its fingerprint and denies the tool until it is re-reviewed.
6. Run `node pi/investment-lab/demo.mjs --allowlist-digest` on the reviewed commit, and record the digest with the owner's approval. Only `--approve-allowlist <that digest>` will run live, and any later edit to the list invalidates it.
7. Set the agentic account as the owner prefers: leave it unfunded, and turn trade approvals on if available. These limit trading only, not reads.
8. Allow `agent.robinhood.com` only for the supervised run. Supply the token at runtime via `ROBINHOOD_MCP_ACCESS_TOKEN`; never commit or log it. Use `--out` with a directory outside the repository.
9. Supervise the first run and review the report before anyone else sees it. Afterwards, disconnect the agent or revoke the token in Robinhood. Expect normalizer fixes, each as a reviewed change.

## Future execution capability

Unchanged: there is no execution path. `OWNER_APPROVAL_REQUIREMENTS` in `execution-gate.mjs` lists the preconditions: explicit written owner approval, a reviewed code change (configuration or model output can never enable execution), per-order human confirmation, cash-only enforcement, a kill switch, idempotency, reconciliation, and paper then supervised verification.
