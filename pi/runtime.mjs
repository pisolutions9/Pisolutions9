import { createMission, markFailure, safeOutcome } from './core.mjs';
import { createQueue } from './queue.mjs';
import { createStateAdapter } from './state-adapter.mjs';
import { saveMission, loadMission, findMissionByIdempotencyKey, listMissions, clearState } from './state.mjs';
import { verifyOutcome } from './verify.mjs';
import { createObserver } from './observability.mjs';
import { createCostGuard } from './cost-guard.mjs';
import { createDeadLetterStore } from './dead-letter.mjs';
import { createDelegationPlan, validateDelegation } from './delegation.mjs';
import { createExecutionPolicy } from './policy.mjs';
import { classifyBlocker } from './blocker-router.mjs';
import { createAutonomousRecovery } from './autonomous-recovery.mjs';
import { createNetra } from './netra.mjs';
import { verifyLearningAction } from './learning-prevention.mjs';
import { createV2MissionGraph } from './v2-mission-plan.mjs';
import { executeV2Graph } from './v2-execution.mjs';
import { createMissionGuardrails } from './mission-guardrails.mjs';

const defaultState = createStateAdapter({ save: saveMission, load: loadMission, findByIdempotencyKey: findMissionByIdempotencyKey, list: listMissions, clear: clearState });

export function createRuntime({ execute = async () => ({ completed: [], evidence: [], status: 'blocked' }), executeSpecialist = null, verifySpecialist = null, alternatives = [], repair = null, verify = null, observer = createObserver(), cost = {}, guardrails = {}, deadLetters = createDeadLetterStore(), state = defaultState, policy = createExecutionPolicy(), netra = createNetra(), learn = null, v2MaxParallel = 2 } = {}) {
  if (!state || typeof state.save !== 'function' || typeof state.load !== 'function') throw new Error('invalid_state_adapter');
  if (!netra || typeof netra.inspect !== 'function') throw new Error('invalid_netra');
  if (learn !== null && typeof learn !== 'function') throw new Error('invalid_learning_hook');
  if (repair !== null && typeof repair !== 'function') throw new Error('invalid_repair_hook');
  if (executeSpecialist !== null && typeof executeSpecialist !== 'function') throw new Error('invalid_v2_specialist_executor');
  if (verifySpecialist !== null && typeof verifySpecialist !== 'function') throw new Error('invalid_v2_verifier');
  if (executeSpecialist !== null && verifySpecialist === null) throw new Error('v2_independent_verifier_required');
  if (!Number.isInteger(v2MaxParallel) || v2MaxParallel < 1) throw new Error('invalid_v2_max_parallel');
  const queue = createQueue();
  const guard = createCostGuard(cost);
  const missionGuard = createMissionGuardrails(guardrails);
  const recovery = createAutonomousRecovery({ repair, alternatives });
  let cycleInFlight = false;

  async function submit(objective, context = {}) {
    const preCheck = netra.inspect(objective, 'pre');
    observer.emit({ missionId: null, step: 'netra_precheck', status: preCheck.allowed ? 'allowed' : 'blocked', truth: 'verified', message: preCheck.severity, findings: preCheck.findings });
    if (!preCheck.allowed) throw new Error(`netra_precheck_blocked:${preCheck.severity}`);
    const boundary = missionGuard.boundary(objective);
    observer.emit({ missionId: null, step: 'instruction_boundary', status: boundary.trusted ? 'allowed' : 'blocked', truth: 'verified', message: boundary.reason, findings: boundary.findings });
    if (!boundary.trusted) throw new Error('untrusted_instruction_boundary');
    const key = context?.idempotencyKey;
    if (key) {
      const existing = await state.findByIdempotencyKey(key);
      if (existing) return existing;
    }
    const risk = missionGuard.risk(objective);
    const mission = await state.save(createMission(objective, { ...context, riskLevel: risk }));
    const delegation = createDelegationPlan(mission);
    const delegationCheck = validateDelegation(delegation);
    if (!delegationCheck.ok) throw new Error('delegation_validation_failed');
    const missionGraph = createV2MissionGraph(mission, { maxParallel: v2MaxParallel });
    const enriched = { ...mission, delegation, missionGraph, guardrails: missionGuard.limits, riskLevel: risk };
    await state.save(enriched);
    queue.enqueue(enriched);
    observer.emit({ missionId: mission.id, step: 'submit', status: 'planned', truth: 'verified', message: 'mission_queued', riskLevel: risk, missionGraph: { maxParallel: missionGraph.maxParallel, stepCount: missionGraph.steps.length } });
    return enriched;
  }

  async function resumeUnfinished() {
    const missions = await state.list();
    const resumable = missions.filter(mission =>
      mission?.id &&
      ['planned', 'retrying', 'running'].includes(mission.status) &&
      mission.context?.humanApproved !== false
    );
    for (const mission of resumable) {
      queue.enqueue(mission);
      observer.emit({ missionId: mission.id, step: 'resume', status: 'queued', truth: 'verified', message: 'unfinished_mission_rehydrated' });
    }
    return { resumed: resumable.length, missionIds: resumable.map(mission => mission.id) };
  }

  async function executeMission(mission) {
    try {
      missionGuard.action();
      if (mission.riskLevel === 'L3' && mission.context?.humanApproved !== true) throw new Error('human_approval_required_for_high_impact_action');
      const boundary = missionGuard.boundary(mission.objective);
      if (!boundary.trusted) throw new Error('untrusted_instruction_boundary');
      if (executeSpecialist) {
        const v2 = await executeV2Graph(mission.missionGraph, { executeSpecialist, verifySpecialist, context: mission.context, constraints: mission.context?.constraints || {} });
        return { status: v2.status, completed: v2.completed, evidence: v2.results.flatMap(item => item.result.evidence), v2Graph: v2.graph, specialistResults: v2.results.map(item => ({ specialist: item.step.specialist, result: item.result })) };
      }
      return await execute(mission, { cost: guard, policy });
    } catch (error) {
      const recoveryResult = await recovery.recover({ mission, error, context: { cost: guard, policy } });
      for (const event of recoveryResult.trace || []) observer.emit({ missionId: mission.id, step: `recovery_${event.phase}`, status: event.action || event.status || 'observed', truth: 'unknown', message: event.reason || event.action || 'recovery_step' });
      if (recoveryResult.status === 'completed') return recoveryResult.result;
      throw error;
    }
  }

  async function recordLearning(mission, error) {
    if (!learn) return null;
    const evidence = [{ source: 'runtime-error', claim: String(error?.message || error) }];
    const action = await learn({ mission, error, evidence });
    const check = verifyLearningAction(action);
    observer.emit({ missionId: mission.id, step: 'learning_prevention', status: check.verified ? 'verified' : 'rejected', truth: check.verified ? 'verified' : 'unknown', message: check.reason });
    if (!check.verified) throw new Error(`learning_prevention_rejected:${check.reason}`);
    return action;
  }

  async function cycle() {
    if (cycleInFlight) {
      observer.emit({ missionId: null, step: 'cycle_guard', status: 'blocked', truth: 'verified', message: 'cycle_already_running' });
      return { status: 'blocked', nextAction: 'retry_later', uncertainty: ['Another runtime cycle is already executing; no overlapping cycle was started.'] };
    }
    cycleInFlight = true;
    try {
      const queued = queue.next();
      if (!queued) return { status: 'idle' };
      let mission = await state.load(queued.mission.id) || queued.mission;
      missionGuard.beginMission();
      const started = Date.now();
      observer.emit({ missionId: mission.id, step: 'cycle', status: 'running', truth: 'unknown', message: 'cycle_started', riskLevel: mission.riskLevel, guardrails: missionGuard.snapshot() });
      try {
        mission = await state.save({ ...mission, status: 'running' });
        guard.action();
        const result = await executeMission(mission);
        if (result.v2Graph) mission = await state.save({ ...mission, missionGraph: result.v2Graph });
        const gate = verifyOutcome(result);
        if (!gate.ok) throw new Error('verification_failed');
        if (result.status === 'completed' && (!Array.isArray(result.evidence) || result.evidence.length === 0)) throw new Error('evidence_required_for_completed');
        const checked = verify ? await verify(result, mission) : result;
        const finalCheck = netra.inspect({ outcome: checked?.status, evidence: checked?.evidence }, 'final');
        observer.emit({ missionId: mission.id, step: 'netra_finalcheck', status: finalCheck.allowed ? 'allowed' : 'blocked', truth: 'verified', message: finalCheck.severity, findings: finalCheck.findings });
        if (!finalCheck.allowed) throw new Error(`netra_finalcheck_blocked:${finalCheck.severity}`);
        const outcome = safeOutcome(mission, checked);
        mission = await state.save({ ...mission, status: outcome.status, result: outcome, guardrails: missionGuard.snapshot() });
        observer.emit({ missionId: mission.id, step: 'verify', status: outcome.status, truth: outcome.truth?.verified?.length ? 'verified' : 'probable', durationMs: Date.now() - started, message: 'cycle_verified', guardrails: missionGuard.snapshot() });
        return outcome;
      } catch (error) {
        let learningError = null;
        try { await recordLearning(mission, error); } catch (learnError) { learningError = learnError; }
        const blocker = classifyBlocker(error);
        const humanGate = !blocker.safeToReroute || Boolean(learningError) || String(error?.message || '').includes('human_approval_required');
        mission = humanGate ? await state.save({ ...mission, status: 'blocked' }) : markFailure(mission, error);
        const nextAction = humanGate ? 'owner_required' : null;
        if (mission.status === 'retrying') {
          missionGuard.retry();
          queue.enqueue(mission);
        } else if (mission.status === 'blocked') deadLetters.add(mission, error);
        observer.emit({ missionId: mission.id, step: 'recovery', status: mission.status, truth: 'unknown', durationMs: Date.now() - started, message: humanGate ? `owner_required:${blocker.reason}` : blocker.reason, guardrails: missionGuard.snapshot() });
        return safeOutcome(mission, { status: mission.status, uncertainty: [String(error?.message || error), ...(learningError ? [String(learningError?.message || learningError)] : [])], nextAction });
      }
    } finally {
      cycleInFlight = false;
    }
  }

  async function runCycles({ maxCycles = 1 } = {}) {
    const limit = Number.isInteger(maxCycles) && maxCycles >= 0 ? maxCycles : 1;
    const outcomes = [];
    for (let index = 0; index < limit; index += 1) {
      const outcome = await cycle();
      outcomes.push(outcome);
      if (outcome.status === 'idle') break;
    }
    const executed = outcomes.filter(outcome => outcome.status !== 'idle');
    const hasBlocked = executed.some(outcome => outcome.status === 'blocked');
    const hasUnfinished = executed.some(outcome => !['completed'].includes(outcome.status));
    const exhausted = executed.length >= limit && hasUnfinished;
    const status = hasBlocked ? 'blocked' : (hasUnfinished ? 'incomplete' : 'completed');
    return {
      status,
      cycles: outcomes,
      executedCycles: executed.length,
      exhausted,
      nextAction: status === 'incomplete' ? 'continue_or_escalate' : (status === 'blocked' ? 'owner_required' : null)
    };
  }

  return { submit, resumeUnfinished, cycle, runCycles, queue, cost: guard, guardrails: missionGuard, deadLetters, policy, state, netra, recovery };
}
