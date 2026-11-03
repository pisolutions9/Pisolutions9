// PI physical lab candidate: simulation-only. No real actuator driver is imported.
import crypto from 'node:crypto';

export const LAB_LIMITS = Object.freeze({
  maxTasks: 8, maxAttempts: 2, maxDepth: 2, maxModelCalls: 0,
  maxSpendUsd: 0, maxRuntimeMs: 30000, maxEvidenceAgeMs: 5000
});
const ACTIONS = new Set(['observe', 'simulate_led_on', 'simulate_led_off']);
const FORBIDDEN = /deploy|production|stripe|payment|secret|shell|exec|gpio|relay|motor|heater|camera_record|unlock|mains/i;
const stable = obj => JSON.stringify(obj);
const sha = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
export function authorize(task, context) {
  if (!task || typeof task !== 'object' || !context || typeof context !== 'object') return 'invalid_input';
  if (context.mode !== 'simulation' || context.hardwareConnected !== false) return 'hardware_disabled';
  if (context.emergencyStop !== false || context.interlockClosed !== true) return 'interlock_open';
  if (context.costUsd !== 0 || context.modelCalls !== 0) return 'budget_exceeded';
  if (!ACTIONS.has(task.action) || FORBIDDEN.test(stable(task))) return 'action_not_allowlisted';
  if (!Number.isInteger(task.depth) || task.depth < 0 || task.depth > LAB_LIMITS.maxDepth) return 'depth_exceeded';
  if (!Number.isInteger(task.attempts) || task.attempts < 0 || task.attempts >= LAB_LIMITS.maxAttempts) return 'retry_exhausted';
  if (typeof task.id !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(task.id)) return 'invalid_task_id';
  if (typeof task.goal !== 'string' || task.goal.length < 1 || task.goal.length > 240) return 'invalid_goal';
  return null;
}
export function createSimulation({ now = () => Date.now(), sensor = () => ({value: 0, observedAt: now()}) } = {}) {
  const queue = [], seen = new Set(), evidence = [];
  let emergencyStop = false;
  const state = { led: false, observed: null };
  const context = () => ({
    mode: 'simulation', hardwareConnected: false, emergencyStop,
    interlockClosed: true, costUsd: 0, modelCalls: 0
  });
  const submit = task => {
    if (queue.length + evidence.length >= LAB_LIMITS.maxTasks) return {accepted:false,reason:'queue_budget_exceeded'};
    const reason = authorize(task, context());
    if (reason) return {accepted:false,reason};
    if (seen.has(task.id)) return {accepted:false,reason:'duplicate_task'};
    seen.add(task.id); queue.push({...task});
    return {accepted:true,id:task.id};
  };
  const step = () => {
    if (!queue.length) return null;
    const task = queue.shift();
    const denied = authorize(task, context());
    if (denied) {const result={id:task.id,status:'blocked',reason:denied};evidence.push(result);return result;}
    let result;
    if (task.action === 'observe') {
      const reading = sensor();
      if (!reading || !Number.isFinite(reading.value) ||
          !Number.isFinite(reading.observedAt) ||
          reading.observedAt > now() ||
          now() - reading.observedAt > LAB_LIMITS.maxEvidenceAgeMs) {
        result={id:task.id,status:'blocked',reason:'stale_or_invalid_sensor'};
      } else {
        state.observed={...reading};
        result={id:task.id,status:'simulated',action:task.action,value:reading.value};
      }
    } else if (!state.observed || now() - state.observed.observedAt > LAB_LIMITS.maxEvidenceAgeMs) {
      result={id:task.id,status:'blocked',reason:'no_fresh_sensor'};
    } else {
      state.led = task.action === 'simulate_led_on';
      result={id:task.id,status:'simulated',action:task.action,led:state.led};
    }
    const record={...result,at:now(),mode:'simulation',prevHash:evidence.at(-1)?.hash || null};
    record.hash=sha(record); evidence.push(record);
    return record;
  };
  const stop = () => {emergencyStop=true; queue.length=0;state.led=false;return {status:'stopped'};};
  return {submit,step,stop,snapshot:()=>({mode:'simulation',hardwareConnected:false,queue:queue.length,state:{...state},evidence:[...evidence],emergencyStop})};
}
export function handoff({ parentId, goal, findings, evidenceHash, nextAction }) {
  if (![parentId,goal,findings,evidenceHash,nextAction].every(v=>typeof v==='string'&&v.length>0)) throw Error('incomplete_handoff');
  return {schema:'pi.lab.handoff.v1',parentId,goal,findings,evidenceHash,nextAction,
    allowedActions:[...ACTIONS],requiresOrchestratorReview:true,physicalExecutionAuthorized:false};
}
