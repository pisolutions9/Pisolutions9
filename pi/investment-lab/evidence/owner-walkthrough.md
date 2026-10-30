# PI Investment Lab — synthetic owner walkthrough

LIVE ROBINHOOD ACCESS: DISABLED — live entry point refused with "no_reviewed_allowlist" (reviewed Robinhood tools: 0; network attempts: 0).
DATA: SYNTHETIC FIXTURE on 127.0.0.1 — not a real account. Trades below are SIMULATED on a local paper ledger; nothing is sent to any broker. Not investment advice.

## 1. What the gateway allowed
5 of 14 server tools allowed (exact reviewed fingerprint match): get_accounts, get_portfolio, get_positions, get_quotes, get_historicals.
Denied: get_order_history (deny_token:order); get_account_settings (annotation_not_read_only); refresh_positions (not_in_reviewed_allowlist); place_equity_order (deny_token:place); cancel_order (deny_token:cancel); transfer_funds (deny_token:transfer); enable_margin (deny_token:enable); getQuoteAndPlaceOrder (deny_token:place); get_holdings (not_in_reviewed_allowlist).
Server-side call log: get_accounts, get_portfolio, get_positions, get_quotes, get_historicals — no denied tool was called.

## 2. Account snapshot
acct_ref_1 (real identifier withheld) · type margin · settled cash $3,000.00 · source-reported equity $56,000.00 [source: get_accounts@2026-10-30T00:20:09.220Z, get_portfolio@2026-10-30T00:20:09.224Z · synthetic]

## 3. Analysis (deterministic, recomputed from inspected data)
- VTI: 60 × $285.00 = $17,100.00 (30.54% of equity) [source: get_positions@2026-10-30T00:20:09.226Z, get_quotes@2026-10-30T00:20:09.229Z · synthetic]
- NVDA: 120 × $135.00 = $16,200.00 (28.93% of equity) [source: get_positions@2026-10-30T00:20:09.226Z, get_quotes@2026-10-30T00:20:09.229Z · synthetic]
- MSFT: 25 × $420.00 = $10,500.00 (18.75% of equity) [source: get_positions@2026-10-30T00:20:09.226Z, get_quotes@2026-10-30T00:20:09.229Z · synthetic]
- AAPL: 40 × $230.00 = $9,200.00 (16.43% of equity) [source: get_positions@2026-10-30T00:20:09.226Z, get_quotes@2026-10-30T00:20:09.229Z · synthetic]
- Total equity $56,000.00; cash 5.36%; effective holdings 4.183.
- Annualized volatility 7.27%; 1-day 95% historical VaR 0.78% over 62 days [source: get_historicals@2026-10-30T00:20:09.236Z · synthetic]
- Risk flag [high] concentration: VTI is 30.54% of equity (limit 25%).
- Risk flag [high] concentration: NVDA is 28.93% of equity (limit 25%).
- Risk flag [info] margin_account: The inspected account reports margin capability. The lab never uses margin; simulations are cash-only.

## 4. Paper-trade decisions (SIMULATED — never submitted)
- buy 10 SCHD: risk-approved → SIMULATED fill sim_1 @ $28.03 (quote $28.02 + 5 bps slippage); cash $3,000.00 → $2,719.66; submittedToBroker=false [source: get_quotes@2026-10-30T00:20:09.229Z · synthetic]
- sell 5 AAPL: risk-approved → SIMULATED fill sim_2 @ $229.87 (quote $229.98 − 5 bps slippage); cash $2,719.66 → $3,868.98; submittedToBroker=false [source: get_quotes@2026-10-30T00:20:09.229Z · synthetic]
- buy 20 NVDA: BLOCKED by risk limits (post_trade_weight_33.75pct_exceeds_limit).
- buy 1000 VTI: BLOCKED by risk limits (post_trade_weight_539.46pct_exceeds_limit).
- Live execution request (even with ownerApproval=true): refused — live_execution_not_available_in_this_version.

## 5. Verification
14/14 verification checks passed. Scope: Internal consistency, provenance, freshness, read-only gateway behaviour and simulation integrity. Not an audit of the broker’s data.
