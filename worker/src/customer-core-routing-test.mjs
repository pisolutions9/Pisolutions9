import assert from 'node:assert/strict';
import worker from './index.js';

async function ask(message,history=[]){
  const request=new Request('https://pi-chat.example/api/chat',{
    method:'POST',
    headers:{'content-type':'application/json','origin':'https://pisolutions9.github.io'},
    body:JSON.stringify({message,history})
  });
  const response=await worker.fetch(request,{});
  return {status:response.status,body:await response.json()};
}

const gas=await ask('A gas station has monthly sales of $180,000, gross margin 24%, payroll $12,000, rent $8,000, utilities $4,500 and other expenses $6,000. Calculate operating profit.');
assert.equal(gas.status,200);
assert.equal(gas.body.ok,true);
assert.equal(gas.body.source,'pi-deterministic-operating-profit');
assert.equal(gas.body.truth,'deterministic-verified');
assert.equal(gas.body.verification,'local-calculation');
assert.match(gas.body.answer,/\$12,700/);
assert.doesNotMatch(gas.body.answer,/verification_failed|No completed result|live data source/i);

const simple=await ask('Calculate 17 + 25.');
assert.equal(simple.status,200);
assert.equal(simple.body.ok,true);
assert.match(simple.body.answer,/42/);
assert.notEqual(simple.body.status,'verification_failed');

const staleHistory=[
  {role:'user',content:'cash is 900k. expenses 220k every month. revenue starts 80k month one and goes up 20k every month. after 4 months what is left?'},
  {role:'assistant',content:'Cash remaining after month 4: $460,000.'}
];
const weatherSwitch=await ask("what's the weather today",staleHistory);
assert.equal(weatherSwitch.status,200);
assert.equal(weatherSwitch.body.ok,true);
assert.equal(weatherSwitch.body.status,'clarification_needed');
assert.equal(weatherSwitch.body.source,'pi-weather-location-clarification');
assert.match(weatherSwitch.body.answer,/what location/i);
assert.doesNotMatch(weatherSwitch.body.answer,/month 1|cash remaining|460,000/i);

const teluguMath=await ask('29 mandi unnaru okkokadu 14 checks chesthe total enti?');
assert.equal(teluguMath.status,200);
assert.equal(teluguMath.body.source,'pi-deterministic-quantified-multiplication');
assert.equal(teluguMath.body.truth,'deterministic-verified');
assert.match(teluguMath.body.answer,/406/);

const resetMath=await ask('postgres migration gurinchi vadiley. 37 servers each 460 req/sec total enta?');
assert.equal(resetMath.status,200);
assert.equal(resetMath.body.source,'pi-deterministic-quantified-multiplication');
assert.match(resetMath.body.answer,/17020/);
assert.doesNotMatch(resetMath.body.answer,/migration|postgres|database/i);

const teluguCash=await ask('month 3 nunchi spending 180k chey. recalc month 4',staleHistory);
assert.equal(teluguCash.status,200);
assert.equal(teluguCash.body.source,'pi-deterministic-cash-flow');
assert.match(teluguCash.body.answer,/Cash remaining after month 4: \$540,000/);
assert.match(teluguCash.body.answer,/Month 3: revenue \$120,000 - expenses \$180,000/);

const typoShopping=await ask('find 2 lapops under 700 available to buy online rn seller price link');
assert.equal(typoShopping.status,200);
assert.equal(typoShopping.body.source,'pi-shopping-search-link');
assert.equal(typoShopping.body.truth,'retailer-search-link');
assert.match(typoShopping.body.answer,/not independently verified/i);

console.log('customer core routing regression: ok');
