// PI Investment Lab — execution boundary.
// This version contains NO code path that submits orders, moves funds, enables margin,
// or runs automated trading. `requestLiveExecution` exists so callers get an explicit,
// auditable refusal instead of silently falling through, and so the owner-approval
// requirements for any future capability are recorded in code, not just in prose.

import { createExecutionPolicy } from '../policy.mjs';

export const LAB_MODE = 'read_only_inspection_plus_simulation';

export const EXECUTION_STATUS = Object.freeze({
  mode: LAB_MODE,
  liveOrders: 'not_built',
  accountFunding: 'not_built',
  margin: 'forbidden',
  automatedTrading: 'not_built',
  simulatedTrades: 'enabled_local_paper_ledger_only'
});

// Preconditions an owner must satisfy, in writing, before a future execution capability may be built.
export const OWNER_APPROVAL_REQUIREMENTS = Object.freeze([
  'Explicit written owner approval naming the exact capability (e.g. single manual equity order), account, and per-order/per-day limits.',
  'A separate code change and review; execution must never be enabled by configuration, environment variable, or model output alone.',
  'Per-order human confirmation with the full order preview shown to the owner before submission.',
  'Cash-only enforcement: no margin, no shorting, no options, no leverage.',
  'Kill switch, idempotency keys, audit trail, and reconciliation against broker confirmations.',
  'Sandbox or paper-trading verification plus a supervised production smoke before any unattended use.'
]);

const policy = createExecutionPolicy({ allowedTools: ['robinhood-mcp'] });

export function requestLiveExecution(intent = {}) {
  const action = {
    tool: 'robinhood-mcp',
    type: 'financial_transfer',
    approved: intent?.approved === true,
    risk: { spendsMoney: true, irreversible: true, externalSideEffect: true }
  };
  const policyDecision = policy.checkAction(action);
  return Object.freeze({
    ok: false,
    status: 'refused',
    reason: 'live_execution_not_available_in_this_version',
    policyDecision: { ok: policyDecision.ok, reason: policyDecision.reason || 'approved_but_no_executor' },
    requested: String(intent?.kind || 'unspecified'),
    requires: OWNER_APPROVAL_REQUIREMENTS,
    sideEffect: false
  });
}
