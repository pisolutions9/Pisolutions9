import assert from 'node:assert/strict';
import worker,{createStageTimer,serverTimingHeader} from './index.js';

// Stage timer with a fake clock: stages close in order, finish() freezes the summary,
// names outside the fixed token shape are ignored, and the stage list is bounded.
let clock=1000;
const timer=createStageTimer(()=>clock);
clock+=5;timer.stage('route');
clock+=7;timer.stage('Explain the water cycle');
timer.stage('edge_model');
clock+=11;
const summary=timer.finish();
assert.deepEqual(summary,{durationMs:23,lastStage:'edge_model',stages:[{stage:'ingress',durationMs:5},{stage:'route',durationMs:7},{stage:'edge_model',durationMs:11}]});
clock+=50;timer.stage('provider_openai');
assert.equal(timer.finish(),summary,'finish must freeze the summary against late stages from abandoned work');
assert.equal(serverTimingHeader(summary),'pi_chat;dur=23, pi_ingress;dur=5, pi_route;dur=7, pi_edge_model;dur=11');
assert.equal(serverTimingHeader(summary,'deadline'),'pi_chat;dur=23, pi_ingress;dur=5, pi_route;dur=7, pi_edge_model;dur=11;desc="inflight"');
const busy=createStageTimer(()=>0);
for(let i=0;i<40;i+=1)busy.stage(`provider_${i}`);
assert.ok(busy.finish().stages.length<=17,'stage list must stay bounded');

const HEADER=/^pi_chat;dur=\d+(, pi_[a-z0-9_]+;dur=\d+(;desc="inflight")?)*$/;
const request=message=>new Request('https://pi.test/api/chat',{
  method:'POST',
  headers:{'content-type':'application/json',origin:'https://pisolutions9.github.io'},
  body:JSON.stringify({message,history:[{role:'user',content:'private-history-marker'}]})
});
async function traced(message,env){
  const lines=[];
  const original=console.log;
  console.log=(...args)=>{lines.push(args.join(' '));};
  try{
    const response=await worker.fetch(request(message),env);
    const body=await response.json();
    return {response,body,lines};
  }finally{console.log=original;}
}
function boundaryOf(lines){
  const events=lines.filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).filter(event=>event.event==='pi_chat_boundary');
  assert.equal(events.length,1);
  return events[0];
}
function assertPrivate(lines,...secrets){
  const logged=lines.join('\n');
  for(const secret of secrets)assert.ok(!logged.includes(secret),`trace log leaked request or answer content: ${secret.slice(0,40)}`);
}

// Success through the edge model with a provider-free fake binding.
const modelAnswer='private-model-output-marker: evaporation, condensation, precipitation, and collection move water through the environment.';
const edge=await traced('Explain the water cycle to a high school student, private-prompt-marker.',{AI:{run:async()=>({response:modelAnswer,finish_reason:'stop'})}});
assert.equal(edge.response.status,200);
assert.equal(edge.body.ok,true);
const edgeTiming=edge.response.headers.get('server-timing')||'';
assert.match(edgeTiming,HEADER);
assert.match(edgeTiming,/^pi_chat;dur=\d+, pi_ingress;dur=\d+, pi_route;dur=\d+, pi_edge_model;dur=\d+$/);
assert.ok(!edgeTiming.includes('inflight'));
const edgeBoundary=boundaryOf(edge.lines);
assert.equal(edgeBoundary.outcome,'response');
assert.equal(edgeBoundary.status,200);
assert.equal(edgeBoundary.lastStage,'edge_model');
assert.equal(edgeBoundary.requestId,edge.response.headers.get('x-pi-request-id'));
assert.deepEqual(edgeBoundary.stages.map(entry=>entry.stage),['ingress','route','edge_model']);
assert.deepEqual(Object.keys(edgeBoundary).sort(),['durationMs','event','lastStage','outcome','requestId','stages','status']);
assertPrivate(edge.lines,'private-prompt-marker','private-history-marker','private-model-output-marker');

// Success through a deterministic direct tool never reaches a model stage.
const direct=await traced('What is 17 * 23?',{AI:{run:()=>{throw Error('direct arithmetic must not use a model');}}});
assert.equal(direct.response.status,200);
const directTiming=direct.response.headers.get('server-timing')||'';
assert.match(directTiming,/^pi_chat;dur=\d+, pi_ingress;dur=\d+, pi_route;dur=\d+$/);
assert.equal(boundaryOf(direct.lines).lastStage,'route');
assertPrivate(direct.lines,'17 * 23','private-history-marker','391');

console.log('PI chat stage timing passed');
