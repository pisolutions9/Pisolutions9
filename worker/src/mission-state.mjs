const STATUSES = new Set(['CREATED','ROUTED','RUNNING','WAITING_TOOL','WAITING_OWNER','VERIFYING','RECOVERING','COMPLETED','FAILED','CANCELLED']);
const TRANSITIONS = {
  CREATED:new Set(['ROUTED','FAILED','CANCELLED']),
  ROUTED:new Set(['RUNNING','WAITING_OWNER','FAILED','CANCELLED']),
  RUNNING:new Set(['WAITING_TOOL','WAITING_OWNER','VERIFYING','RECOVERING','FAILED','CANCELLED']),
  WAITING_TOOL:new Set(['RUNNING','RECOVERING','FAILED','CANCELLED']),
  WAITING_OWNER:new Set(['RUNNING','FAILED','CANCELLED']),
  VERIFYING:new Set(['COMPLETED','RECOVERING','FAILED']),
  RECOVERING:new Set(['RUNNING','WAITING_TOOL','WAITING_OWNER','VERIFYING','FAILED','CANCELLED']),
  COMPLETED:new Set([]), FAILED:new Set([]), CANCELLED:new Set([])
};

export function createMissionState({runId,taskId=null,task=null,budget=null,now=Date.now()}={}){
  if(!runId) throw new Error('run_id_required');
  return Object.freeze({schema:'pi.mission.v1',runId:String(runId),taskId:taskId?String(taskId):String(runId),status:'CREATED',stateVersion:1,checkpointId:`${runId}:1`,attemptCount:0,budget:budget??null,task:task??null,lastError:null,updatedAt:Number(now)});
}

export function transitionMission(state,next,{error=null,incrementAttempt=false,now=Date.now()}={}){
  if(!state||state.schema!=='pi.mission.v1') throw new Error('invalid_mission_state');
  if(!STATUSES.has(next)) throw new Error('invalid_mission_status');
  if(!TRANSITIONS[state.status]?.has(next)) throw new Error(`invalid_mission_transition:${state.status}->${next}`);
  const version=state.stateVersion+1;
  return Object.freeze({...state,status:next,stateVersion:version,checkpointId:`${state.runId}:${version}`,attemptCount:state.attemptCount+(incrementAttempt?1:0),lastError:error??null,updatedAt:Number(now)});
}

export function isTerminalMission(state){ return Boolean(state&&['COMPLETED','FAILED','CANCELLED'].includes(state.status)); }
