import { authorizePrincipal } from './capability-guard.mjs';

const HUMAN_GATES = new Set(['irreversible_external_action','legal_commitment','financial_transfer','secret_rotation','production_destructive_change','production_change','production_deploy']);

export function normalizeToolRisk(action = {}) {
  const risk = action?.risk && typeof action.risk === 'object' ? action.risk : {};
  const irreversible = risk.irreversible === true || action?.type === 'irreversible_external_action';
  const destructive = risk.destructive === true || action?.type === 'production_destructive_change';
  const spendsMoney = risk.spendsMoney === true || action?.type === 'financial_transfer';
  const credentialRequired = risk.credentialRequired === true || action?.type === 'secret_rotation';
  const legalCommitment = risk.legalCommitment === true || action?.type === 'legal_commitment';
  const productionChange = action?.type === 'production_change' || action?.type === 'production_deploy' || destructive;
  const ownerRequired = risk.ownerRequired === true || irreversible || destructive || spendsMoney || credentialRequired || legalCommitment || productionChange;
  return Object.freeze({
    readOnly: risk.readOnly === true,
    retrySafe: risk.retrySafe === true,
    idempotent: risk.idempotent === true,
    externalSideEffect: risk.externalSideEffect === true,
    irreversible,
    destructive,
    spendsMoney,
    credentialRequired,
    legalCommitment,
    productionChange,
    verificationRequired: risk.verificationRequired !== false,
    ownerRequired
  });
}

export function createExecutionPolicy({ humanApprovalRequiredFor = [...HUMAN_GATES], allowedTools = [] } = {}) {
  const gates = new Set(humanApprovalRequiredFor);
  return Object.freeze({
    allowedTools: [...allowedTools],
    requiresApproval(actionType) { return gates.has(actionType); },
    classifyRisk(action = {}) { return normalizeToolRisk(action); },
    checkAction(action = {}) {
      if (!action?.tool) return { ok: false, reason: 'tool_required' };
      if (allowedTools.length && !allowedTools.includes(action.tool)) return { ok: false, reason: 'tool_not_allowed' };

      const risk = normalizeToolRisk(action);
      const authorization = authorizePrincipal({ ...action, risk: { ...(action.risk || {}), ...risk } }, action.principal);
      if (!authorization.ok) return { ok: false, reason: authorization.reason, risk, authorization };

      const gatedByType = action?.type && gates.has(action.type);
      if ((gatedByType || risk.ownerRequired) && action?.approved !== true) {
        return { ok: false, reason: 'human_approval_required', actionType: action.type || 'risk_metadata', risk, authorization };
      }
      return { ok: true, risk, authorization };
    },
    recoveryPolicy(action = {}) {
      const risk = normalizeToolRisk(action);
      if (risk.ownerRequired || risk.irreversible || risk.destructive || risk.productionChange) {
        return { retryAllowed: false, alternateAllowed: false, reason: 'protected_action' };
      }
      if (risk.retrySafe || risk.idempotent || risk.readOnly) {
        return { retryAllowed: true, alternateAllowed: true, reason: 'safe_recovery' };
      }
      return { retryAllowed: false, alternateAllowed: true, reason: 'alternate_only' };
    }
  });
}
