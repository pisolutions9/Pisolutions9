export const TRUTH_LEVELS = Object.freeze(['verified', 'probable', 'speculative', 'unknown']);

function normalizeFailure(error) {
  return String(error?.code || error?.message || error || 'unknown_error')
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,64}\b/g, '<id>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function failureFingerprint(error) {
  const normalized = normalizeFailure(error);
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `f_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function createMission(objective, context = {}) {
  const text = String(objective || '').trim();
  if (!text) throw new Error('objective_required');

  const lower = text.toLowerCase();
  const specialists = [];
  if (/business|market|sales|customer|revenue|export|import|price/.test(lower)) specialists.push('business', 'research', 'data');
  if (/earth|satellite|land|crop|agriculture|map|geospatial|location/.test(lower)) specialists.push('earth', 'research', 'data');
  if (/build|code|deploy|software|app|github|netlify/.test(lower)) specialists.push('engineering', 'security', 'verification');
  if (!specialists.length) specialists.push('research', 'data', 'verification');

  return {
    id: `mission_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    objective: text,
    context,
    status: 'planned',
    specialists: [...new Set(specialists)],
    steps: [
      { id: 'interpret', action: 'interpret_objective', status: 'ready' },
      { id: 'research', action: 'collect_evidence', status: 'ready' },
      { id: 'execute', action: 'execute_available_actions', status: 'ready' },
      { id: 'verify', action: 'independent_verification', status: 'ready' },
      { id: 'report', action: 'return_outcome', status: 'ready' }
    ],
    truth: { verified: [], probable: [], speculative: [], unknown: [] },
    recovery: { attempts: 0, maxAttempts: 3, lastError: null, lastFingerprint: null, repeatedFingerprintCount: 0, requiresStrategyChange: false },
    createdAt: new Date().toISOString()
  };
}

export function markFailure(mission, error) {
  const next = structuredClone(mission);
  next.recovery ||= { attempts: 0, maxAttempts: 3 };
  const fingerprint = failureFingerprint(error);
  const repeated = next.recovery.lastFingerprint === fingerprint;
  next.recovery.attempts = Number(next.recovery.attempts || 0) + 1;
  next.recovery.lastError = String(error?.message || error || 'unknown_error');
  next.recovery.repeatedFingerprintCount = repeated ? Number(next.recovery.repeatedFingerprintCount || 1) + 1 : 1;
  next.recovery.lastFingerprint = fingerprint;
  next.recovery.requiresStrategyChange = next.recovery.repeatedFingerprintCount >= 2;

  // Never loop the same failure fingerprint blindly. The second occurrence
  // must leave the ordinary retry path so recovery can choose a different
  // strategy or explicitly block/escalate.
  if (next.recovery.requiresStrategyChange) {
    next.status = 'blocked';
    next.recovery.blockReason = 'repeated_failure_requires_strategy_change';
  } else {
    next.status = next.recovery.attempts < Number(next.recovery.maxAttempts || 3) ? 'retrying' : 'blocked';
  }
  return next;
}

export function verifyClaim(claim, evidence = []) {
  const text = String(claim || '').trim();
  if (!text) return { level: 'unknown', reason: 'empty_claim' };
  if (evidence.length > 0) return { level: 'probable', reason: 'evidence_present_but_independent_verification_required' };
  return { level: 'unknown', reason: 'no_evidence' };
}

export function safeOutcome(mission, result = {}) {
  return {
    missionId: mission.id,
    objective: mission.objective,
    status: result.status || mission.status,
    completed: result.completed || [],
    evidence: result.evidence || [],
    truth: mission.truth,
    uncertainty: result.uncertainty || ['Any unverified execution is explicitly excluded from completed work.'],
    nextAction: result.nextAction || null
  };
}
