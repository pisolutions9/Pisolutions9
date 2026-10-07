import assert from 'node:assert/strict';
import {createMissionState,transitionMission,isTerminalMission} from './mission-state.mjs';
import {createExecutionTrace,appendTrace,traceSummary} from './execution-trace.mjs';

let state=createMissionState({runId:'r1',taskId:'t1',task:{capability:'weather'},now:1});
assert.equal(state.status,'CREATED');
state=transitionMission(state,'ROUTED',{now:2});
state=transitionMission(state,'RUNNING',{now:3,incrementAttempt:true});
state=transitionMission(state,'WAITING_TOOL',{now:4});
state=transitionMission(state,'RUNNING',{now:5});
state=transitionMission(state,'VERIFYING',{now:6});
state=transitionMission(state,'COMPLETED',{now:7});
assert.equal(state.stateVersion,7);assert.equal(state.attemptCount,1);assert.ok(isTerminalMission(state));
assert.throws(()=>transitionMission(state,'RUNNING'),/invalid_mission_transition/);

const trace=createExecutionTrace({runId:'r1',taskId:'t1',now:1});
appendTrace(trace,{type:'route',component:'krishna',status:'success',latencyMs:5,data:{capability:'weather',authorization:'Bearer SECRET'}},{now:2});
appendTrace(trace,{type:'tool',component:'weather',status:'failure',latencyMs:20,costUsd:0.001,data:{error:'provider unavailable'}},{now:3});
const summary=traceSummary(trace);
assert.equal(summary.eventCount,2);assert.equal(summary.totalLatencyMs,25);assert.equal(summary.totalCostUsd,0.001);assert.equal(summary.failures.length,1);
assert.equal(trace.events[0].data.authorization,'[REDACTED]');
console.log('mission state + execution trace: ok');
