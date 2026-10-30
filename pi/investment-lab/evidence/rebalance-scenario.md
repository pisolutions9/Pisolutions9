# PI Investment Lab — owner rebalancing paper scenario

LIVE ROBINHOOD ACCESS: DISABLED — live entry point refused with "no_reviewed_allowlist" (reviewed Robinhood tools: 0; network attempts: 0).
DATA: SYNTHETIC FIXTURE — not a real account. PAPER ONLY — no order is sent anywhere. Targets come from the owner; the lab does not forecast prices or recommend targets. Not investment advice.

## Example owner plan (illustrative input, not advice): targets VTI 25.00%, NVDA 20.00%, MSFT 20.00%, AAPL 15.00%, SCHD 10.00%; cash ≥ 8.00%

**Status: PAPER PROPOSAL** — paper only, nothing sent to any broker. Decision: owner. [prices: get_quotes@2026-10-30T01:06:20.187Z; holdings: get_positions@2026-10-30T01:06:20.184Z · synthetic]

| Symbol | Current | Target | Paper change | After | Residual |
|---|---:|---:|---|---:|---:|
| AAPL | 16.43% | 15.00% | sell 4 | 14.79% | -0.21% |
| MSFT | 18.75% | 20.00% | buy 1 | 19.50% | -0.50% |
| NVDA | 28.93% | 20.00% | sell 38 | 19.77% | -0.23% |
| SCHD | 0.00% | 10.00% | buy 199 | 9.95% | -0.05% |
| VTI | 30.54% | 25.00% | sell 11 | 24.94% | -0.06% |
| Cash | 5.36% | ≥ 8.00% | | 11.04% | |

| | Do nothing | Paper proposal |
|---|---:|---:|
| Trades | 0 | 5 |
| Turnover | $0.00 | $15,178.35 |
| Cost (slippage + spread, fees $0.00) | $0.00 | $12.65 ($7.59 + $5.06) |
| Largest holding | 30.54% | 24.94% |
| Effective holdings | 4.183 | 5.844 |
| Cash | $3,000.00 (5.36%) | $6,180.35 (11.04%) |

- SIMULATED sell 4 AAPL @ $229.87 (quote $229.98 − 5 bps), submittedToBroker=false
- SIMULATED sell 38 NVDA @ $134.91 (quote $134.98 − 5 bps), submittedToBroker=false
- SIMULATED sell 11 VTI @ $284.84 (quote $284.98 − 5 bps), submittedToBroker=false
- SIMULATED buy 199 SCHD @ $28.03 (quote $28.02 + 5 bps), submittedToBroker=false
- SIMULATED buy 1 MSFT @ $420.23 (quote $420.02 + 5 bps), submittedToBroker=false
- Costs are measured vs marking each holding at its last trade price. Whole shares only, so small residual drift remains.

## Deliberately unsafe plan (shows a refusal): targets NVDA 45.00%, VTI 30.00%, MSFT 20.00%; cash ≥ 10.00%

**Status: REFUSED** at plan_validation. No paper trades were made.
- target_exceeds_position_cap:NVDA:0.45>0.25
- target_exceeds_position_cap:VTI:0.3>0.25
- impossible_targets_plus_cash_exceed_100pct:1.05

Do-nothing remains available: top holding 30.54%, cash 5.36%, cost $0.00.

