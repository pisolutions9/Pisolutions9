// PI V1 release-candidate deployment marker: keep the customer worker deployment tied to this release train.
// Launch-gate path: sequential Workers AI model routing through AI Gateway, sequential provider fallback, deterministic emergency recovery.
import { inventoryMission } from './inventory.mjs';
import { deterministicFallback } from './deterministic-fallback.mjs';

const ALLOWED_ORIGIN = 'https://pisolutions9.github.io';
const MAX_INPUT = 8000;
const MAX_OUTPUT_TOKENS = 2048;
const COMPACT_OUTPUT_TOKENS = 1536;
const PROVIDER_TIMEOUT_MS = 20000;
const EDGE_TIMEOUT_MS = 7000;
const HARD_REQUEST_BUDGET_MS = 18000;
const DEFAULT_EDGE_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const EDGE_MODEL_FALLBACKS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/zai-org/glm-4.7-flash'
];
const OPENAI_MODEL_FALLBACKS = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5'];
const HARD_REASONING = /\b(calculate|posterior|bayes|probability|optimi[sz]|linear programming|profit-maximi[sz]|cash model|cash flow|runway|break-even|constraint|corner points?|binding constraints?|distributed systems?|network partition|cap theorem|exactly.once|no double charges?|ledger|migration|reconciliation|invariants?|rollback|shard(?:ed|ing)?|25,?000 writes|prove why|show enough calculations|audit the answer)\b/i;
function requiresHardReasoning(text=''){return HARD_REASONING.test(String(text));}
const LIVE_EVIDENCE_ALWAYS = /\b(weather|temperature|forecast|stock (?:price|quote)|score|standings|traffic|open now|available now)\b/i;
const LIVE_EVIDENCE_FRESHNESS = /\b(latest|live|right now|currently|today|tonight|this (?:morning|afternoon|evening|week|month|year))\b/i;
const LIVE_EVIDENCE_DYNAMIC_DOMAIN = /\b(weather|temperature|forecast|price|stock|market|score|standings|news|traffic|availability|available|open|election results?|sports?|flight status|exchange rate)\b/i;
function requiresLiveEvidence(text=''){
  const value=String(text);
  return LIVE_EVIDENCE_ALWAYS.test(value)||(LIVE_EVIDENCE_FRESHNESS.test(value)&&LIVE_EVIDENCE_DYNAMIC_DOMAIN.test(value));
}
const PI_INSTRUCTIONS = "You are PI, an autonomous intelligence assistant coordinated by Krishna. Answer the user's actual question directly and naturally. Do not expose internal routing, classification, planning, tool, or verification language. If current facts or an external action cannot be verified, say what is missing instead of inventing it. Never claim an action was completed unless it actually was. You can discuss, explain, and draft text. Inventory CSV creation is handled by a separate tool; you cannot browse, deploy, or run other external actions. Give a complete response within 1000 tokens; prioritize the most useful points and avoid repetition. Use the provided conversation history for follow-up questions.";
const HARD_REASONING_INSTRUCTIONS = `${PI_INSTRUCTIONS} This is a high-depth reasoning task. Work from the stated facts only. Do not invent costs, constraints, guarantees, sources, or assumptions. Recompute every material numeric conclusion. Check every proposed solution against every stated constraint. For impossibility/tradeoff questions, do not claim simultaneous guarantees that conflict. For financial/data-integrity designs, state invariants and failure boundaries. Before finalizing, silently try to disprove your own conclusion.`;
const VERIFY_INSTRUCTIONS = "You are PI's independent verifier. Review the candidate answer against the user's question. Check arithmetic, probability, recurrence, feasibility, omitted cost terms, invented assumptions, contradictory guarantees, and unsafe data-integrity claims. Return exactly PASS if no material defect exists. Otherwise return REVISE followed by a compact correction brief. Do not praise the answer.";
const COMPACT_RETRY_INSTRUCTIONS = `${PI_INSTRUCTIONS} The previous attempt reached its output limit. Rewrite the answer from the beginning as a complete, self-contained response under 700 words. Do not mention the retry or truncation.`;

function corsHeaders(origin) {
  return {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...(origin===ALLOWED_ORIGIN?{'access-control-allow-origin':ALLOWED_ORIGIN}:{}),'access-control-allow-methods':'POST,OPTIONS','access-control-allow-headers':'content-type','access-control-max-age':'600',vary:'Origin'};
}
function json(body,status,request,extraHeaders={}){const origin=request.headers.get('Origin')||'';return new Response(JSON.stringify(body),{status,headers:{...corsHeaders(origin),...extraHeaders}});}
function preflight(request){const origin=request.headers.get('Origin')||'';if(origin&&origin!==ALLOWED_ORIGIN)return json({ok:false,error:'origin_not_allowed'},403,request);return new Response(null,{status:204,headers:corsHeaders(origin)});}
function providerError(response){if(response.status===401)return{error:'chat_provider_auth_failed',status:502};if(response.status===403)return{error:'chat_provider_access_denied',status:502};if(response.status===404)return{error:'chat_provider_model_or_endpoint_not_found',status:502};if(response.status===429)return{error:'chat_provider_rate_limited',status:503};if(response.status>=500)return{error:'chat_provider_server_error',status:503};if(response.status>=400)return{error:'chat_provider_request_rejected',status:502};return{error:'chat_provider_unavailable',status:503};}
function rateLimitHeaders(response){const headers={};for(const name of['x-ratelimit-limit-requests','x-ratelimit-remaining-requests','x-ratelimit-reset-requests']){const value=response.headers.get(name);if(value)headers[name]=value;}return headers;}
async function callProvider({apiKey,model,baseUrl,message,history=[]}){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),PROVIDER_TIMEOUT_MS);try{return await fetch(`${baseUrl.replace(/\/$/,'')}/responses`,{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:JSON.stringify({model,store:false,max_output_tokens:MAX_OUTPUT_TOKENS,instructions:PI_INSTRUCTIONS,input:[...history,{role:'user',content:message}]}),signal:controller.signal});}finally{clearTimeout(timer);}}
function extractAnswer(body){return body?.output_text?.trim()||body?.output?.flatMap(item=>item?.content||[]).find(part=>part?.type==='output_text')?.text?.trim();}
function extractEdgeAnswer(result){if(typeof result==='string')return result.trim()||null;const candidates=[result?.response,result?.output_text,result?.result?.response,result?.result?.output_text,result?.choices?.[0]?.message?.content];for(const value of candidates){if(typeof value==='string'&&value.trim())return value.trim();if(Array.isArray(value)){const text=value.map(part=>typeof part==='string'?part:(part?.text||part?.content||'')).join('').trim();if(text)return text;}}return null;}
async function runEdgeWithTimeout(env,model,message,history,{instructions=PI_INSTRUCTIONS,maxTokens=MAX_OUTPUT_TOKENS,timeoutMs=EDGE_TIMEOUT_MS}={}){const input={messages:[{role:'system',content:instructions},...history,{role:'user',content:message}],max_tokens:maxTokens};const work=env.AI.run(model,input,{gateway:{id:'default',skipCache:false}});let timer;const boundedTimeout=Math.max(1,Math.min(EDGE_TIMEOUT_MS,timeoutMs));const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`edge model timeout: ${model}`)),boundedTimeout);});try{return await Promise.race([work,timeout]);}finally{clearTimeout(timer);}}
function edgeResultIncomplete(result,maxTokens){const finishReasons=[result?.finish_reason,result?.choices?.[0]?.finish_reason,result?.result?.finish_reason,result?.result?.choices?.[0]?.finish_reason];if(finishReasons.some(reason=>['length','max_tokens','max_output_tokens'].includes(reason)))return true;const usages=[result?.usage,result?.result?.usage].filter(Boolean);return usages.some(usage=>[usage.completion_tokens,usage.output_tokens,usage.tokens_generated].some(value=>Number.isFinite(value)&&value>=maxTokens));}
async function callWorkersAI(env,message,history,{preferStrong=false,instructions=PI_INSTRUCTIONS}={}){if(!env.AI||typeof env.AI.run!=='function')return null;const configured=env.PI_EDGE_MODEL||DEFAULT_EDGE_MODEL;const models=preferStrong
  ? [...new Set(['@cf/meta/llama-3.3-70b-instruct-fp8-fast','@cf/zai-org/glm-4.7-flash',configured].filter(Boolean))]
  : [...new Set([configured,...EDGE_MODEL_FALLBACKS].filter(Boolean))];for(const model of models){try{const result=await runEdgeWithTimeout(env,model,message,history,{instructions});const answer=extractEdgeAnswer(result);if(answer){const incomplete=edgeResultIncomplete(result,MAX_OUTPUT_TOKENS);if(!incomplete)return {answer,model,incomplete:false};try{const compactResult=await runEdgeWithTimeout(env,model,message,history,{instructions:instructions===PI_INSTRUCTIONS?COMPACT_RETRY_INSTRUCTIONS:instructions,maxTokens:COMPACT_OUTPUT_TOKENS});const compactAnswer=extractEdgeAnswer(compactResult);if(compactAnswer&&!edgeResultIncomplete(compactResult,COMPACT_OUTPUT_TOKENS))return {answer:compactAnswer,model,incomplete:false,recoveredFrom:'output_limit'};}catch(error){console.error(`Workers AI compact retry failed: ${model}`,error instanceof Error?error.message:String(error));}return {answer,model,incomplete:true};}console.error(`Workers AI empty response: ${model}`);}catch(error){console.error(`Workers AI model failed: ${model}`,error instanceof Error?error.message:String(error));}await new Promise(resolve=>setTimeout(resolve,250));}return null;}
async function verifyHardAnswer(env,message,history,candidate,deadline=Date.now()+HARD_REQUEST_BUDGET_MS){
  if(!env.AI||typeof env.AI.run!=='function')return {ok:false,reason:'verifier_unavailable'};
  const verificationPrompt=`QUESTION:\n${message}\n\nCANDIDATE ANSWER:\n${candidate}\n\nVerify independently.`;
  for(const model of ['@cf/zai-org/glm-4.7-flash','@cf/meta/llama-3.3-70b-instruct-fp8-fast']){
    try{
      const timeLeft=remainingBudget(deadline);if(timeLeft<=0)return {ok:false,reason:'verification_deadline_exceeded'};
      const result=await runEdgeWithTimeout(env,model,verificationPrompt,history,{instructions:VERIFY_INSTRUCTIONS,maxTokens:900,timeoutMs:timeLeft});
      const verdict=extractEdgeAnswer(result);
      if(!verdict)continue;
      if(/^PASS\b/i.test(verdict))return {ok:true,model};
      if(/^REVISE\b/i.test(verdict))return {ok:false,model,reason:verdict};
    }catch(error){console.error('PI verifier failed',model,error instanceof Error?error.message:String(error));}
  }
  return {ok:false,reason:'verification_inconclusive'};
}
function remainingBudget(deadline){return Math.max(0,deadline-Date.now());}
async function produceVerifiedHardAnswer(env,message,history){
  const deadline=Date.now()+HARD_REQUEST_BUDGET_MS;
  const first=await callWorkersAI(env,message,history,{preferStrong:true,instructions:HARD_REASONING_INSTRUCTIONS});
  if(!first||first.incomplete||remainingBudget(deadline)<EDGE_TIMEOUT_MS)return null;
  const check=await verifyHardAnswer(env,message,history,first.answer,deadline);
  if(check.ok)return {...first,verified:true,verifier:check.model};
  if(remainingBudget(deadline)<EDGE_TIMEOUT_MS)return null;
  const correction=check.reason||'Independent verification found a material defect. Recompute and correct the answer.';
  const retryMessage=`${message}\n\nIndependent verification rejected the previous draft. Correction brief:\n${correction}\nProduce a corrected self-contained answer. Recalculate from the original facts and do not repeat the rejected error.`;
  const revised=await callWorkersAI(env,retryMessage,history,{preferStrong:true,instructions:HARD_REASONING_INSTRUCTIONS});
  if(!revised||revised.incomplete)return null;
  const recheck=await verifyHardAnswer(env,message,history,revised.answer,deadline);
  return recheck.ok?{...revised,verified:true,verifier:recheck.model,recoveredFrom:'verification'}:null;
}
function recoveryResponse(message,request,failure){const answer=deterministicFallback(message);if(!answer)return null;const headers=failure?.response&&failure.failure.error==='chat_provider_rate_limited'?rateLimitHeaders(failure.response):{};return json({ok:true,answer,source:'pi-chat-deterministic-recovery',truth:'deterministic',providerFailure:failure?.failure?.error||'chat_provider_unavailable'},200,request,headers);}
export default{async fetch(request,env){const url=new URL(request.url);const origin=request.headers.get('Origin')||'';if(url.pathname!=='/api/chat')return new Response('Not found',{status:404});if(origin&&origin!==ALLOWED_ORIGIN)return json({ok:false,error:'origin_not_allowed'},403,request);if(request.method==='OPTIONS')return preflight(request);if(request.method!=='POST')return json({ok:false,error:'method_not_allowed'},405,request);let payload;try{payload=await request.json();}catch{return json({ok:false,error:'invalid_json'},400,request);}const message=String(payload?.message||'').trim();if(!message)return json({ok:false,error:'message_required'},400,request);if(message.length>MAX_INPUT)return json({ok:false,error:'message_too_large'},413,request);let history=[];try{history=validateHistory(payload.history);const mission=inventoryMission(message);if(mission)return json(mission,200,request);}catch(error){return json({ok:false,error:error.message},400,request);}if(requiresLiveEvidence(message))return json({ok:false,status:'live_evidence_required',error:'live_data_connector_not_configured',answer:'I need a live data source to answer that accurately. I will not guess or present model memory as current data.',truth:'unknown'},503,request);const hardReasoning=requiresHardReasoning(message);
if(hardReasoning){
  const verified=await produceVerifiedHardAnswer(env,message,history);
  if(verified)return json({ok:true,status:'answered',answer:verified.answer,source:`pi-chat-cloudflare-ai:${verified.model}`,truth:'verified-model-response',verification:'independent-pass'},200,request);
  return json({ok:false,status:'verification_failed',error:'hard_reasoning_not_verified',answer:'I could not independently verify this high-depth answer, so I will not present an unverified result as reliable.',truth:'unknown'},503,request);
}
const edgeResult=await callWorkersAI(env,message,history);if(edgeResult)return json({ok:!edgeResult.incomplete,status:edgeResult.incomplete?'incomplete':'answered',answer:edgeResult.answer,source:`pi-chat-cloudflare-ai:${edgeResult.model}`,truth:'model-response'},200,request);const providers=[];if(env.OPENAI_API_KEY){const configured=env.PI_CHAT_MODEL;const models=[...new Set([configured,...OPENAI_MODEL_FALLBACKS].filter(Boolean))];for(const model of models)providers.push({name:`openai:${model}`,apiKey:env.OPENAI_API_KEY,model,baseUrl:'https://api.openai.com/v1'});}if(env.PI_FALLBACK_API_KEY&&env.PI_FALLBACK_API_URL&&env.PI_FALLBACK_MODEL)providers.push({name:'fallback',apiKey:env.PI_FALLBACK_API_KEY,model:env.PI_FALLBACK_MODEL,baseUrl:env.PI_FALLBACK_API_URL});let lastFailure={failure:{error:'edge_model_unavailable',status:503},provider:'cloudflare-ai'};for(const provider of providers){try{const response=await callProvider({...provider,message,history});if(!response.ok){lastFailure={response,failure:providerError(response),provider:provider.name};if(response.status===429||response.status>=500||response.status===404)continue;const recovered=recoveryResponse(message,request,lastFailure);return recovered||json({ok:false,error:lastFailure.failure.error},lastFailure.failure.status,request);}const body=await response.json();const answer=extractAnswer(body);if(!answer){lastFailure={failure:{error:'empty_model_response',status:502},provider:provider.name};continue;}return json({ok:body.status!=='incomplete',status:body.status==='incomplete'?'incomplete':'answered',answer,source:`pi-chat-${provider.name}`,truth:'model-response'},200,request);}catch{lastFailure={failure:{error:'chat_provider_network_error',status:503},provider:provider.name};}}const recovered=recoveryResponse(message,request,lastFailure);if(recovered)return recovered;const failure=lastFailure.failure||{error:'chat_provider_unavailable',status:503};const headers=lastFailure.response&&failure.error==='chat_provider_rate_limited'?rateLimitHeaders(lastFailure.response):{};return json({ok:false,error:failure.error},failure.status,request,headers);}};
export function validateHistory(history) {
 if(history===undefined)return [];
 if(!Array.isArray(history)||history.length>20)throw new Error('history_invalid');
 let size=0;
 return history.map(turn=>{if(!turn||!['user','assistant'].includes(turn.role)||typeof turn.content!=='string'||turn.content.length>12000)throw new Error('history_invalid');size+=turn.content.length;if(size>32000)throw new Error('history_too_large');return {role:turn.role,content:turn.content};});
}
