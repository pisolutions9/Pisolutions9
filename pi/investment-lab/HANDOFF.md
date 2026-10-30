# Investment Lab — branch handoff (`claude/pi-investment-lab`, draft PR #224)

Shared ground rules for every lane:

- Synthetic data only.
- The live Robinhood allowlist stays **empty**, and the digest gate stays in place.
- No real connection, token, trade, funding, merge or deploy.
- The PR stays draft.

## Lanes

| Lane | Owner | Files | Status |
|---|---|---|---|
| Owner-controlled target rebalancing (paper only) | Claude | `rebalance.mjs`, `rebalance-scenario.mjs`, `rebalance-test.mjs`, `evidence/rebalance-*.{md,log}` | Committed on this branch |
| Two-stage sealed decision proof: freeze a T0 decision, later compare it with do-nothing and a preset benchmark | Codex | `decision-proof.mjs`, `decision-proof-fixture/`, `decision-proof-test.mjs`, `evidence/decision-*` | Integrated by fast-forward to `da45c04`; tree `c849c2b` verified |
| Rebalancing freeze/reveal proof (joins the two lanes) | Claude | `rebalance-proof.mjs`, `rebalance-proof-fixture/`, `rebalance-proof-test.mjs`, `evidence/rebalance-proof*` and `evidence/rebalance-frozen.json` | Reuses `proposeRebalance`, `portfolioSnapshot` and the now-exported `digest`. Codex's proof logic is not duplicated. |

## What the rebalancing lane provides

`proposeRebalance({ dataset, quant, plan })` returns a frozen object (`schema: 'pi.investment-lab.rebalance.v1'`) with these fields:

- **`status`**: `proposed`, `already_within_band` or `refused`. A refusal also carries `stage` and `problems`.
- **`doNothing`**: always present, with `trades: 0` and `totalCost: 0`, plus the current weights and concentration.
- **Proposal details:**
  - `orders`, and `fills` (simulated, `submittedToBroker: false`);
  - `rows` for each symbol: current, target, paper change, post-trade weight and residual;
  - `costs`, `before`/`after` concentration and cash, and `turnover`;
  - `decision: 'owner'`.

Each output field is meant to be usable as an input or snapshot for a T0 decision record. Inputs are the owner's plan plus the inspected synthetic dataset. Price history is never used (a test checks this).

## Shared code changed in this lane

- **`agents.mjs` → `riskAgent`.** Position-cap and cash-floor pre-checks now apply only to **buys**. Previously, a sell that reduced an over-cap position or raised cash was blocked because the result still sat outside the limit, which blocked the remedy. Buys are unchanged. The regression is test 1 in `rebalance-test.mjs`, with pre-fix evidence in `evidence/rebalance-pre-fix.log`. Existing demo decisions are unchanged.
- **`package.json`.** `test:investment-lab` now also runs `rebalance-test.mjs`. Codex can append its own suite to the same script, and the `PI Investment Lab` PR workflow already covers `pi/investment-lab/**`.

## Integration notes for the T0/T1 proof

- Treat a `proposeRebalance` result as one candidate T0 action, alongside `doNothing` and the preset benchmark.
- Do not import `runLive`, and do not populate `ROBINHOOD_REVIEWED_ALLOWLIST`. `investment-lab-test.mjs` asserts the list is empty.
- If both lanes touch `package.json` scripts or `PI_INVESTMENT_LAB.md`, merge by appending. Neither lane should rewrite the other's sections.

## Shared code changed when joining the lanes

- **`decision-proof.mjs`.** The only change is that `digest` is now `export`ed; behaviour is unchanged.
- **`demo.mjs` → `runFixtureDemo`.** It accepts an optional `now`, which pins the synthetic clock for the fixture server, gateway and mission. Without it, behaviour is unchanged.
