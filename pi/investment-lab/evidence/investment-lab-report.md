# PI Investment Lab — Read-only Account Inspection Report

> **READ-ONLY INSPECTION · SIMULATED TRADES ONLY · NOT INVESTMENT ADVICE.** No order was submitted, no funds moved, no margin used.
> **DATA PROVENANCE: SYNTHETIC FIXTURE.** All account figures below come from a local test MCP server, not a real Robinhood account.

Generated: 2026-10-30T00:20:09.050Z · Mission: lab_demo_1793319608975

## Source
- MCP server: pi-synthetic-broker-fixture 0.1.0 at 127.0.0.1:46733 (protocol 2025-11-25)
- Tools discovered: 14; allowed (read-only): 5; denied: 9
  - `get_accounts` → **allow** (reviewed_exact_match; accounts)
  - `get_portfolio` → **allow** (reviewed_exact_match; portfolio)
  - `get_positions` → **allow** (reviewed_exact_match; positions)
  - `get_quotes` → **allow** (reviewed_exact_match; quotes)
  - `get_historicals` → **allow** (reviewed_exact_match; historicals)
  - `get_order_history` → **deny** (deny_token:order)
  - `get_account_settings` → **deny** (annotation_not_read_only)
  - `refresh_positions` → **deny** (not_in_reviewed_allowlist)
  - `place_equity_order` → **deny** (deny_token:place)
  - `cancel_order` → **deny** (deny_token:cancel)
  - `transfer_funds` → **deny** (deny_token:transfer)
  - `enable_margin` → **deny** (deny_token:enable)
  - `getQuoteAndPlaceOrder` → **deny** (deny_token:place)
  - `get_holdings` → **deny** (not_in_reviewed_allowlist)

## Account (probable)
- Account reference: acct_ref_1 (real identifier withheld by gateway)
- Type: margin; settled cash: $3,000.00; margin capability reported: yes (never used by lab)
- Source-reported equity: $56,000.00

## Holdings (probable, deterministic)
| Symbol | Qty | Last | Market value | Weight | Unrealized P&L |
|---|---:|---:|---:|---:|---:|
| VTI | 60 | $285.00 | $17,100.00 | 30.54% | $3,900.00 |
| NVDA | 120 | $135.00 | $16,200.00 | 28.93% | $11,400.00 |
| MSFT | 25 | $420.00 | $10,500.00 | 18.75% | $3,000.00 |
| AAPL | 40 | $230.00 | $9,200.00 | 16.43% | $3,200.00 |
| Cash | | | $3,000.00 | 5.36% | |
| **Total** | | | **$56,000.00** | | $21,500.00 |

Effective number of holdings: 4.183 (Herfindahl 0.239075).
Portfolio annualized volatility 7.27%; 1-day 95% historical VaR 0.78% over 62 overlapping days (historical simulation on equity-weighted daily log returns over overlapping dates; cash assumed zero-return).

| Symbol | Obs | Total return | Ann. vol | Max drawdown | 20d momentum |
|---|---:|---:|---:|---:|---:|
| AAPL | 63 | -11.72% | 18.97% | -18.85% | -4.75% |
| MSFT | 63 | 9.11% | 18.69% | -5.33% | 4.03% |
| VTI | 63 | -11.20% | 17.09% | -15.04% | 0.46% |
| NVDA | 63 | 1.73% | 17.02% | -6.96% | -0.47% |
| SCHD | 63 | 4.04% | 18.97% | -14.37% | 0.36% |

## Risk (probable)
- [high] concentration: VTI is 30.54% of equity (limit 25%).
- [high] concentration: NVDA is 28.93% of equity (limit 25%).
- [info] margin_account: The inspected account reports margin capability. The lab never uses margin; simulations are cash-only.

## Simulated trades (paper ledger only — never sent to a broker)
- Risk pre-check buy 10 SCHD: approved for simulation
- Risk pre-check sell 5 AAPL: approved for simulation
- Risk pre-check buy 20 NVDA: blocked (post_trade_weight_33.75pct_exceeds_limit)
- Risk pre-check buy 1000 VTI: blocked (post_trade_weight_539.46pct_exceeds_limit)
- SIMULATED fill sim_1: buy 10 SCHD @ $28.03 (ref $28.02, 5 bps slippage) → cash $3,000.00 → $2,719.66
- SIMULATED fill sim_2: sell 5 AAPL @ $229.87 (ref $229.98, 5 bps slippage) → cash $2,719.66 → $3,868.98
- Live execution request: **refused** (live_execution_not_available_in_this_version; policy: approved_but_no_executor).

## Verification (verified)
- PASS equity_recomputed_independently: independent 56000.00 vs quant 56000
- PASS equity_matches_source_reported: source-reported 56000; relative difference 0.000% (tolerance 0.5%)
- PASS evidence_accounts: tool:get_accounts observed 2026-10-30T00:20:09.021Z
- PASS evidence_portfolio: tool:get_portfolio observed 2026-10-30T00:20:09.024Z
- PASS evidence_positions: tool:get_positions observed 2026-10-30T00:20:09.027Z
- PASS evidence_quotes: tool:get_quotes observed 2026-10-30T00:20:09.030Z
- PASS evidence_historicals: tool:get_historicals observed 2026-10-30T00:20:09.037Z
- PASS quotes_fresh_per_source_timestamp: all quotes within 120s
- PASS gateway_only_called_read_classified_tools: 5 call(s), all to read-classified tools
- PASS gateway_never_called_denied_tools: 9 tool(s) denied at discovery
- PASS all_trades_simulated_not_submitted: 2 fill(s), 0 rejection(s)
- PASS paper_ledger_reconciles: start 3000 + flows 868.984950 = end 3868.98495
- PASS paper_ledger_cash_non_negative_no_margin: end cash 3868.98495
- PASS live_execution_refused: live_execution_not_available_in_this_version
- Scope: Internal consistency, provenance, freshness, read-only gateway behaviour and simulation integrity. Not an audit of the broker’s data.

## Gateway audit
- 5 read call(s) executed; 0 request(s) denied by the gateway.

## Limitations
- Figures are point-in-time and source-reported; the lab does not independently audit broker records.
- Historical statistics describe the past only and are not forecasts or recommendations.
- Simulated fills use a fixed slippage model and ignore liquidity, fees, taxes, settlement timing and market hours.
- Robinhood MCP tool names and response shapes are discovered at runtime; unrecognized shapes fail closed.
