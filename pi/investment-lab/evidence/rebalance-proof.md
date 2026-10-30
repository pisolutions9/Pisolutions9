# PI Investment Lab — owner rebalancing proof (freeze → reveal)

LIVE ROBINHOOD ACCESS: DISABLED — live entry point refused with "no_reviewed_allowlist" (network attempts: 0).
**SYNTHETIC ONLY · PAPER ONLY · OWNER-SET TARGETS · NOT A FORECAST · NOT ADVICE**

| Timestamp | Value (synthetic clock) |
|---|---|
| Source quotes observed (T0) | 2026-10-01T15:00:00.000Z |
| Decision frozen (T0) | 2026-10-01T15:00:00.000Z · SHA-256 `67fb05f57c62eca0dc502f5bcc1ba12b63b0d6eb13dadea9c567f90f83a559cc` |
| Outcome revealed (T1, A) | 2026-10-29T15:00:00.000Z |
| Outcome revealed (T1, B) | 2026-10-29T15:00:00.000Z |

## 1. Current vs owner target vs paper result
```
Symbol  current                            target                             after
AAPL    ███████████·············  16.43%  ██████████··············  15.00%  ██████████··············  14.79%
MSFT    █████████████···········  18.75%  ██████████████··········  20.00%  █████████████···········  19.50%
NVDA    ████████████████████····  28.93%  ██████████████··········  20.00%  ██████████████··········  19.77%
SCHD    ························   0.00%  ███████·················  10.00%  ███████·················   9.95%
VTI     █████████████████████···  30.54%  █████████████████·······  25.00%  █████████████████·······  24.94%
Cash    ████····················   5.36%  floor ≥ 8.00%                      ████████················  11.04%
```

## 2. Proposed paper trades (proposed; never sent to a broker)
- sell 4 AAPL @ $229.87 (quote $229.98, 5 bps slippage)
- sell 38 NVDA @ $134.91 (quote $134.98, 5 bps slippage)
- sell 11 VTI @ $284.84 (quote $284.98, 5 bps slippage)
- buy 199 SCHD @ $28.03 (quote $28.02, 5 bps slippage)
- buy 1 MSFT @ $420.23 (quote $420.02, 5 bps slippage)
- Total cost vs last-price marks: $12.65 · fees $0.00 per order.

## 3. Refused unsafe plan (also frozen)
- Targets NVDA 45.00%, VTI 30.00%, MSFT 20.00%, cash ≥ 10.00% → **refused** at plan_validation: target_exceeds_position_cap:NVDA:0.45>0.25; target_exceeds_position_cap:VTI:0.3>0.25; impossible_targets_plus_cash_exceed_100pct:1.05. Its outcome is identical to doing nothing.

## 4. Frozen before any outcome
- PI paper choice, the do-nothing path, and the predeclared benchmark (VTI: convert all holdings and cash into VTI at T0 with the same cost model.; 196.337529 shares, entry cost $43.80) were hashed together at 2026-10-01T15:00:00.000Z.
- Costs: entry costs at T0 for every path; all paths marked at T1 last price, no exit costs.

## 5. Later outcomes (each T1 file revealed only after the freeze)

### A: concentrated holding falls — revealed 2026-10-29T15:00:00.000Z
Prices: AAPL $232.30, MSFT $428.40, VTI $279.30, NVDA $94.50, SCHD $28.56

| Path | Ending value | vs do nothing |
|---|---:|---:|
| PI paper rebalance | $52,799.69 | $1,699.69 |
| Do nothing | $51,100.00 | $0.00 |
| Predeclared benchmark (VTI) | $54,837.07 | $3,737.07 |

```
rebalance vs do nothing                |▓▓▓▓           $1,699.69
benchmark vs do nothing                |▓▓▓▓▓▓▓▓▓      $3,737.07
```
Verdict: the paper rebalance beat doing nothing by $1,699.69 and TRAILED the benchmark by $2,037.38. Independent recomputation agreed.

### B: adverse counterexample — the trimmed holding rallies and the added one falls — revealed 2026-10-29T15:00:00.000Z
Prices: AAPL $236.90, MSFT $424.20, VTI $293.55, NVDA $189.00, SCHD $25.76

| Path | Ending value | vs do nothing |
|---|---:|---:|
| PI paper rebalance | $60,746.14 | -$2,627.86 |
| Do nothing | $63,374.00 | $0.00 |
| Predeclared benchmark (VTI) | $57,634.88 | -$5,739.12 |

```
rebalance vs do nothing          ▓▓▓▓▓▓|               -$2,627.86
benchmark vs do nothing  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓|               -$5,739.12
```
Verdict: the paper rebalance TRAILED doing nothing by $2,627.86 and beat the benchmark by $3,111.26. Independent recomputation agreed.

## Limits
- These synthetic T0 and T1 files were written together by the lab authors; the hash detects later edits but is not an independent timestamp.
- Two invented scenarios show the mechanics and that the rule can lose (scenario B). They are not evidence of skill, alpha, or future returns.
- Rebalancing here only enforces the owner's own targets and cash floor; it does not predict prices.
