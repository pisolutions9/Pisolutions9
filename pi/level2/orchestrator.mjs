import fs from 'node:fs';
import crypto from 'node:crypto';
export const LIMITS=Object.freeze({maxTasks:12,maxAttempts:2,maxDepth:2,maxModelCalls:0,maxSpendUsd:0});
const ACTIONS=new Set(['research','plan','write_patch','test','review']);
const ROLES=new Set(['claude','codex','verifier']);
const restricted=/(production|deploy|stripe|billing|secret|credential|cloudflare|hardware|gpio|shell_command|push_main)/i;
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fresh=()=>({schema:'pi.level2.queue.v1',tasks:[],events:[],spentUsd:0,modelCalls:0});
const clone=x=>JSON.parse(JSON.stringify(x));
export function validate(t){
 if(!t||typeof t!=='object'||Array.isArray(t))return 'invalid_task';
 if(typeof t.id!=='string'||!/^[a-z0-9_-]{1,64}$/.test(t.id))return 'invalid_id';
 if(!ROLES.has(t.assignee)||!ACTIONS.has(t.action))return 'invalid_role_or_action';
 if(typeof t.goal!=='string'||t.goal.length<4||t.goal.length>500)return 'invalid_goal';
 if(!Number.isInteger(t.depth)||t.depth<0||t.depth>LIMITS.maxDepth)return 'depth_exceeded';
 if(!Array.isArray(t.acceptance)||!t.acceptance.length||t.acceptance.some(x=>typeof x!=='string'||x.length>200))return 'missing_acceptance';
 if(restricted.test(JSON.stringify(t)))return 'restricted_scope';
 return null;
}
export function handoff(task,evidence){
 const error=validate(task);if(error)throw Error(error);
 if(!evidence||typeof evidence.reference!=='string'||!evidence.reference)throw Error('evidence_reference_required');
 return {schema:'pi.level2.handoff.v1',task:clone(task),
  context:{canonicalRepo:'pisolutions9/Pisolutions9',mode:'sandbox',productionAccess:false,ownerSpendUsd:0},
  evidence:clone(evidence),required:{actualWork:true,independentReview:true,claimOnlyNotSufficient:true}};
}
export class SandboxQueue{
 constructor(path){this.path=path;this.lockPath=path+'.lock';this.fd=null;this.state=null;}
 open(){this.fd=fs.openSync(this.lockPath,'wx');
  try{this.state=fs.existsSync(this.path)?JSON.parse(fs.readFileSync(this.path,'utf8')):fresh();
   if(this.state.schema!=='pi.level2.queue.v1')throw Error('invalid_queue_state');return this;}
  catch(e){this.close();throw e;}}
 close(){if(this.fd!==null){fs.closeSync(this.fd);this.fd=null;fs.rmSync(this.lockPath,{force:true});}}
 save(){if(this.fd===null)throw Error('queue_not_locked');
  const tmp=this.path+'.tmp-'+process.pid;fs.writeFileSync(tmp,JSON.stringify(this.state,null,2),{flag:'wx',mode:0o600});fs.renameSync(tmp,this.path);}
 event(type,data){const event={seq:this.state.events.length+1,type,data,previous:this.state.events.at(-1)?.hash??null};event.hash=hash(event);this.state.events.push(event);}
 add(task){const reason=validate(task);if(reason)return {accepted:false,reason};
  if(this.state.tasks.some(x=>x.id===task.id))return {accepted:false,reason:'duplicate_id'};
  if(this.state.tasks.length>=LIMITS.maxTasks)return {accepted:false,reason:'task_budget'};
  const t={...clone(task),status:'queued',attempts:0,outputs:[],parentId:task.parentId??null};
  this.state.tasks.push(t);this.event('submitted',{id:t.id});this.save();return {accepted:true,id:t.id};}
 claim(role){const t=this.state.tasks.find(x=>x.status==='queued'&&x.assignee===role);
  if(!t)return null;t.status='running';t.attempts++;this.event('claimed',{id:t.id,role,attempt:t.attempts});this.save();return clone(t);}
 complete(id,output){const t=this.state.tasks.find(x=>x.id===id);
  if(!t||t.status!=='running')throw Error('task_not_running');
  const raw=JSON.stringify(output);if(!output||!raw||raw.length>32768)throw Error('output_invalid_or_oversize');
  if(typeof output.evidenceRef!=='string'||!output.evidenceRef||typeof output.summary!=='string')throw Error('evidence_required');
  t.outputs.push(clone(output));t.status='awaiting_review';
  this.event('submitted_for_review',{id,evidenceRef:output.evidenceRef});this.save();}
 verify(id,decision){const t=this.state.tasks.find(x=>x.id===id);
  if(!t||t.status!=='awaiting_review')throw Error('not_awaiting_review');
  if(!decision||decision.verifier!=='independent'||typeof decision.evidenceRef!=='string'||!decision.evidenceRef)throw Error('independent_evidence_required');
  t.status=decision.passed===true?'verified':'rejected';this.event('verification',{id,passed:decision.passed===true,evidenceRef:decision.evidenceRef});this.save();return t.status;}
 retry(id){const t=this.state.tasks.find(x=>x.id===id);
  if(!t||t.status!=='rejected')throw Error('not_rejected');
  if(t.attempts>=LIMITS.maxAttempts){t.status='blocked';this.event('retry_exhausted',{id});this.save();return false;}
  t.status='queued';this.event('retry',{id});this.save();return true;}
 charge(usd,modelCalls=1){if(!Number.isFinite(usd)||usd<0||!Number.isInteger(modelCalls)||modelCalls<0)throw Error('invalid_cost');
  if(this.state.spentUsd+usd>LIMITS.maxSpendUsd||this.state.modelCalls+modelCalls>LIMITS.maxModelCalls)throw Error('model_budget_denied');
  this.state.spentUsd+=usd;this.state.modelCalls+=modelCalls;this.save();}
 snapshot(){return clone(this.state);}
}
export async function runWorker(queue,role,provider){
 if(!ROLES.has(role)||typeof provider!=='function')throw Error('invalid_worker');
 const task=queue.claim(role);if(!task)return {status:'idle'};
 try{const output=await provider(handoff(task,{reference:'queue:'+task.id}));
  queue.complete(task.id,output);return {status:'awaiting_review',id:task.id};}
 catch(e){const t=queue.state.tasks.find(t=>t.id===task.id);t.status='rejected';
  queue.event('worker_error',{id:task.id,reason:String(e.message).slice(0,160)});queue.save();return {status:'rejected',id:task.id};}
}
