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
  let body;
  try{body=await response.json();}catch{throw new Error(`invalid_json:${response.status}`);}
  return {status:response.status,body};
}

function answerText(result){return String(result?.body?.answer||'');}
function assertNoInternalLeak(result){
  const text=answerText(result).toLowerCase();
  for(const marker of ['classification: business_objective','classification:','i recognized this as an informational question']){
    assert.equal(text.includes(marker),false,`internal_planner_leak:${marker}`);
  }
}
function assertSafeHardOutcome(result){
  assert.ok([200,503].includes(result.status),`unexpected_hard_status:${result.status}`);
  assertNoInternalLeak(result);
  if(result.status===200){
    assert.equal(result.body.ok,true);
    assert.ok(['verified-model-response','provisional-model-response','deterministic-verified'].includes(result.body.truth),`unsafe_hard_truth:${result.body.truth}`);
    return;
  }
  assert.equal(result.body.ok,false);
  assert.equal(result.body.status,'verification_failed');
  assert.equal(result.body.error,'hard_reasoning_not_verified');
  assert.equal(result.body.truth,'unknown');
  assert.match(answerText(result),/will not present|could not independently verify|verification/i);
}

const math=await ask('Calculate 17 * 19.');
assert.equal(math.status,200);
assert.equal(math.body.ok,true);
assert.match(answerText(math),/323/);
assert.ok(['deterministic-verified','verified-model-response'].includes(math.body.truth),`unsafe_math_truth:${math.body.truth}`);
assertNoInternalLeak(math);

const cost=await ask('Channel A costs $500 fixed plus $8 per customer. Channel B costs $200 fixed plus $11 per customer. At what customer count are total costs equal, and which is cheaper at 50 and 150 customers?');
assert.equal(cost.status,200);
assert.equal(cost.body.ok,true);
assert.match(answerText(cost),/100 customers/i);
assert.match(answerText(cost),/50 customers/i);
assert.match(answerText(cost),/150 customers/i);
assert.ok(['deterministic-verified','verified-model-response'].includes(cost.body.truth),`unsafe_cost_truth:${cost.body.truth}`);
assertNoInternalLeak(cost);

const payment=await ask('A payment POST times out after the provider may already have charged the card. Explain the safe retry strategy using idempotency and how to prevent duplicate charges.');
assert.equal(payment.status,200);
assert.equal(payment.body.ok,true);
assert.match(answerText(payment),/idempotency key/i);
assert.match(answerText(payment),/same (?:key|logical payment)|reuses? that exact key/i);
assert.match(answerText(payment),/duplicate|second charge/i);
assertNoInternalLeak(payment);

const weather=await ask('What is the current weather in Mobile, Alabama?');
assert.equal(weather.status,200);
assert.equal(weather.body.ok,true);
assert.equal(weather.body.truth,'live-data-response');
assert.ok(Array.isArray(weather.body.sources)&&weather.body.sources.some(source=>/open-meteo/i.test(String(source?.title||source?.url||''))),'weather_source_missing');
assertNoInternalLeak(weather);

const general=await ask('Explain the difference between RAM and storage to a beginner.');
assert.equal(general.status,200);
assert.equal(general.body.ok,true);
const generalText=answerText(general);
assert.match(generalText,/RAM/i);
assert.match(generalText,/storage|SSD|disk/i);
assertNoInternalLeak(general);

const hard=await ask('Explain why high availability does not necessarily imply security. Identify the invalid inference and give a better framework for evaluating availability, reliability, and security.');
assertSafeHardOutcome(hard);

const selfKnowledge=await ask('What can PI actually do today? Tell me which capabilities are proven live and which things you cannot currently do. Do not guess.');
assert.ok([200,503].includes(selfKnowledge.status),`unexpected_self_status:${selfKnowledge.status}`);
assertNoInternalLeak(selfKnowledge);
assert.ok(answerText(selfKnowledge).trim().length>=80,'self_knowledge_too_short');
assert.equal(/I can definitely (?:browse|purchase|deploy|send|book) anything/i.test(answerText(selfKnowledge)),false,'self_capability_overclaim');

const gasStation=await ask('My gas station sold $8,400 today. Fuel gross profit was $920, inside-store gross profit was $1,180, payroll was $540, card fees were $190, utilities allocation was $110, and other operating costs were $160. What is today\'s operating profit and operating margin? Show the math.');
assert.equal(gasStation.status,200);
assert.equal(gasStation.body.ok,true);
assert.match(answerText(gasStation),/1,?100|1100/);
assert.match(answerText(gasStation),/13\.1|13\.09|13%/);
assertNoInternalLeak(gasStation);

const runway=await ask('I have $2 million cash and burn $600,000 per month. Ignore revenue for this first calculation. How many months of runway do I have?');
assert.equal(runway.status,200);
assert.equal(runway.body.ok,true);
assert.match(answerText(runway),/3\.33|3\.3|3⅓|three and one-third/i);
assertNoInternalLeak(runway);

const followUpHistory=[
  {role:'user',content:'I have $2 million cash and burn $600,000 per month. Ignore revenue for this first calculation. How many months of runway do I have?'},
  {role:'assistant',content:answerText(runway)}
];
const followUp=await ask('Now reduce the monthly burn by 20%. What is the new runway?',followUpHistory);
assert.equal(followUp.status,200);
assert.equal(followUp.body.ok,true);
assert.match(answerText(followUp),/480,?000|\$480k/i);
assert.match(answerText(followUp),/4\.16|4\.17|4⅙|about 4\.2/i);
assertNoInternalLeak(followUp);

console.log(JSON.stringify({ok:true,cases:10,url},null,2));
