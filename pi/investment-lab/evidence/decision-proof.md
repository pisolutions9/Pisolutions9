# PI Decision Lab — owner proof

**SYNTHETIC ONLY · PAPER DECISION · NO BROKER CONNECTION**

At 2026-10-01T12:00:00.000Z, fictional FOCUS at $10.00 would consume **30.00%** of $1000.00. Owner limit: 25%. An independent arithmetic check agreed.

**Frozen decision:** Hold cash; reject the concentrated purchase. Reason: exceeds_owner_concentration_limit. SHA-256: `0f6d6173fcd80bb30df0fe677a66ae482f90fcabac32921723058e7e9ac21e4c`.

The BASKET benchmark and trade costs (5 bps slippage, $1.00 per order) were set before the outcome.

At 2026-10-29T12:00:00.000Z, separately revealed fictional prices: FOCUS $7.00; BASKET $102.00. Every path starts with $1000.00 and uses the same costs for trades.

| Path | Ending value | Change |
|---|---:|---:|
| PI paper decision | $1000.00 | $0.00 |
| Do nothing | $1000.00 | $0.00 |
| Predeclared benchmark | $1016.96 | $16.96 |
| Rejected purchase, counterfactual | $907.75 | -$92.25 |

**Proved:** the plan command works with the outcome file absent, the rule is applied before reveal, and independent arithmetic agrees. The hash detects changes to the frozen record. **Limits:** these invented fixtures were authored together; the hash is not an independent timestamp. One synthetic case cannot establish an investment edge or predict returns. A rejected purchase could have risen.
