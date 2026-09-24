import assert from 'node:assert/strict';
import worker from './index.js';

async function ask(message){
  const request=new Request('https://pi-chat.example/api/chat',{
    method:'POST',
    headers:{'content-type':'application/json','origin':'https://pisolutions9.github.io'},
    body:JSON.stringify({message})
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

console.log('customer core routing regression: ok');
