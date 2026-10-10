const SCOPE_ORDER = Object.freeze([
  'tool:read',
  'tool:write',
  'production:change',
  'production:destructive',
  'money:transfer',
  'secret:use',
  'secret:rotate',
  'legal:commit'
]);

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

export function requiredScopesForAction(action = {}) {
  const risk = action?.risk && typeof action.risk === 'object' ? action.risk : {};
  const scopes = [];

  if (risk.readOnly === true) scopes.push('tool:read');
  if (risk.externalSideEffect === true) scopes.push('tool:write');

  const type = String(action?.type || '');
  if (type === 'production_change' || type === 'production_deploy') scopes.push('production:change');
  if (risk.destructive === true || type === 'production_destructive_change') scopes.push('production:destructive');
  if (risk.spendsMoney === true || type === 'financial_transfer') scopes.push('money:transfer');
  if (risk.credentialRequired === true) scopes.push('secret:use');
  if (type === 'secret_rotation') scopes.push('secret:rotate');
  if (risk.legalCommitment === true || type === 'legal_commitment') scopes.push('legal:commit');

  for (const scope of Array.isArray(action?.requiredScopes) ? action.requiredScopes : []) {
    if (typeof scope === 'string' && scope.trim()) scopes.push(scope.trim());
  }

  return Object.freeze(unique(scopes).sort((a, b) => {
    const ai = SCOPE_ORDER.indexOf(a);
    const bi = SCOPE_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  }));
}

export function normalizePrincipal(principal) {
  if (!principal || typeof principal !== 'object' || Array.isArray(principal)) return null;
  const id = typeof principal.id === 'string' ? principal.id.trim() : '';
  const scopes = unique(Array.isArray(principal.scopes) ? principal.scopes.filter(scope => typeof scope === 'string').map(scope => scope.trim()).filter(Boolean) : []);
  if (!id) return null;
  return Object.freeze({ id, scopes: Object.freeze(scopes) });
}

export function authorizePrincipal(action = {}, principal = null) {
  const requiredScopes = requiredScopesForAction(action);
  const normalized = normalizePrincipal(principal);
  const consequential = requiredScopes.some(scope => scope !== 'tool:read');

  if (!normalized) {
    if (consequential) {
      return Object.freeze({ ok: false, reason: 'principal_required', principalId: null, requiredScopes, missingScopes: requiredScopes });
    }
    return Object.freeze({ ok: true, reason: 'public_or_read_only', principalId: null, requiredScopes, missingScopes: Object.freeze([]) });
  }

  const granted = new Set(normalized.scopes);
  const missingScopes = requiredScopes.filter(scope => !granted.has(scope));
  if (missingScopes.length) {
    return Object.freeze({ ok: false, reason: 'capability_not_granted', principalId: normalized.id, requiredScopes, missingScopes: Object.freeze(missingScopes) });
  }

  return Object.freeze({ ok: true, reason: 'least_privilege_pass', principalId: normalized.id, requiredScopes, missingScopes: Object.freeze([]) });
}

export function createPrincipal(id, scopes = []) {
  const principal = normalizePrincipal({ id, scopes });
  if (!principal) throw new Error('principal_id_required');
  return principal;
}
