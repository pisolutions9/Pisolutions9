import assert from 'node:assert/strict';

const url=process.env.PI_CHAT_URL || 'https://pi-chat.premchandyadlapati.workers.dev/api/chat';
const origin='https://pisolutions9.github.io';

async function ask(message,history=[]){
  const response=await fetch(url,{
    method:'POST',
    headers:{'content-type':'application/json','origin':origin},
    body:JSON.stringify({message,history}),
    signal:AbortSignal.timeout(25000)
  });
  let body={};
  try{body=await response.json();}catch{body={answer:'',truth:'unknown'};}
  return {status:response.status,body};
}
const text=r=>String(r?.body?.answer||'');
const hasInternal=r=>/classification:|i recognized this as an informational question|temporarily operating in verified recovery mode/i.test(text(r));
const safeFailure=r=>r.status===503 && r.body?.ok===false && (r.body?.truth==='unknown'||r.body?.status==='verification_failed'||/could not|cannot|unavailable|missing|not configured|try again/i.test(text(r)));
const safeLiveBoundary=r=>{
  if(r.status===200 && r.body?.ok===true){
    return r.body?.truth==='live-data-response' && Array.isArray(r.body?.sources) && r.body.sources.length>0;
  }
  return safeFailure(r);
};
const rows=[];
async function run(name,message,check,{history=[]}={}){
  const r=await ask(message,history);
  let useful=false,safe=false,detail='';
  try{
    ({useful,safe,detail=''}=check(r));
  }catch(e){detail=e?.message||String(e);}
  if(hasInternal(r)){safe=false;detail=(detail?detail+'; ':'')+'internal routing leaked';}
  rows.push({name,status:r.status,ok:r.body?.ok,truth:r.body?.truth,source:r.body?.source,useful,safe,detail,answer:text(r).slice(0,500),sources:Array.isArray(r.body?.sources)?r.body.sources.length:0});
  return r;
}

await run('basic_math','Calculate 17 * 19.',r=>({useful:r.status===200&&r.body?.ok===true&&/323/.test(text(r)),safe:r.status===200&&/323/.test(text(r)),detail:'expects 323'}));

await run('live_weather','What is the weather in Mobile, Alabama right now, and will it rain in the next 6 hours? Tell me when your weather data was last updated.',r=>({useful:r.status===200&&r.body?.ok===true&&r.body?.truth==='live-data-response'&&Array.isArray(r.body?.sources)&&r.body.sources.length>0,safe:safeLiveBoundary(r),detail:'requires live sourced weather'}));

await run('beginner_explainer','Explain the difference between RAM and storage to a beginner.',r=>({useful:r.status===200&&r.body?.ok===true&&/RAM/i.test(text(r))&&/storage|SSD|disk/i.test(text(r)),safe:r.status===200&&r.body?.ok===true,detail:'basic explanation'}));

await run('complex_reasoning','Explain why high availability does not necessarily imply security. Identify the invalid inference and give a better framework for evaluating availability, reliability, and security.',r=>({useful:r.status===200&&r.body?.ok===true&&['verified-model-response','provisional-model-response','deterministic-verified'].includes(r.body?.truth),safe:(r.status===200&&r.body?.ok===true)||safeFailure(r),detail:'hard reasoning must verify or fail safely'}));

await run('gas_station_owner_math',"My gas station sold $8,400 today. Fuel gross profit was $920, inside-store gross profit was $1,180, payroll was $540, card fees were $190, utilities allocation was $110, and other operating costs were $160. What is today's operating profit and operating margin? Show the math.",r=>({useful:r.status===200&&r.body?.ok===true&&/1,?100|1100/.test(text(r))&&/13\.1|13\.09|13%/.test(text(r)),safe:(r.status===200&&r.body?.ok===true)||safeFailure(r),detail:'expects $1,100 and about 13.1%'}));

const self=await run('pi_self_knowledge','What can PI actually do today? Tell me which capabilities are proven live and which things you cannot currently do. Do not guess.',r=>({useful:r.status===200&&r.body?.ok===true&&text(r).trim().length>=80,safe:(r.status===200||safeFailure(r))&&!/I can definitely (?:browse|purchase|deploy|send|book) anything/i.test(text(r)),detail:'must be runtime-grounded, not hype'}));

const runway=await run('runway_math','I have $2 million cash and burn $600,000 per month. Ignore revenue for this first calculation. How many months of runway do I have?',r=>({useful:r.status===200&&r.body?.ok===true&&/3\.33|3\.3|3⅓|three and one-third/i.test(text(r)),safe:(r.status===200&&r.body?.ok===true)||safeFailure(r),detail:'expects about 3.33 months'}));

const history=[{role:'user',content:'I have $2 million cash and burn $600,000 per month. Ignore revenue for this first calculation. How many months of runway do I have?'},{role:'assistant',content:text(runway)}];
await run('short_followup','Now reduce the monthly burn by 20%. What is the new runway?',r=>({useful:r.status===200&&r.body?.ok===true&&/480,?000|\$480k/i.test(text(r))&&/4\.16|4\.17|4⅙|4\.2/i.test(text(r)),safe:(r.status===200&&r.body?.ok===true)||safeFailure(r),detail:'must use prior context; expects $480k and ~4.17 months'}),{history});

await run('current_world_news','What are the top 3 major world news developments happening today? Give the exact publication time and source for every claim.',r=>({useful:r.status===200&&r.body?.ok===true&&r.body?.truth==='live-data-response'&&Array.isArray(r.body?.sources)&&r.body.sources.length>=1,safe:safeLiveBoundary(r),detail:'must use fresh sourced data or fail safely'}));

await run('live_shopping','Find me two laptops under $700 that are available to buy online right now. Give the seller, current price, and direct product link.',r=>({useful:r.status===200&&r.body?.ok===true&&Array.isArray(r.body?.sources)&&r.body.sources.length>=1&&/\$\d/.test(text(r)),safe:safeLiveBoundary(r),detail:'must use current shopping evidence or fail safely'}));

const useful=rows.filter(r=>r.useful).length;
const safe=rows.filter(r=>r.safe).length;
console.log(JSON.stringify({ok:safe===10&&useful>=8,total:10,useful,safe,rows},null,2));
if(safe<10||useful<8)process.exit(1);
