const APPROVAL_ACTIONS = new Set(['payment', 'delete', 'deploy']);

export function evaluateTaskPolicy(task = {}) {
  const requiresApproval = APPROVAL_ACTIONS.has(task.action);
  const requiresLiveEvidence = Boolean(task.freshnessRequired);
  const denyModelOnlyCompletion = requiresLiveEvidence || requiresApproval;

  return Object.freeze({
    schema: 'pi.policy.v1',
    requiresApproval,
    requiresLiveEvidence,
    denyModelOnlyCompletion,
    sandboxRecommended: task.capability === 'coding' || task.action === 'deploy',
    maxAutonomy: requiresApproval ? 'prepare-only' : task.risk === 'medium' ? 'bounded' : 'normal',
    reason: requiresApproval
      ? `consequential_action:${task.action}`
      : requiresLiveEvidence
        ? 'fresh_evidence_required'
        : 'standard_runtime_policy'
  });
}

export function policyAllowsAutomaticSideEffect(task = {}, policy = evaluateTaskPolicy(task)) {
  if (!task.action) return true;
  return !policy.requiresApproval;
}
