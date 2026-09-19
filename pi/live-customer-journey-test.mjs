import assert from 'node:assert/strict';
const endpoint=process.env.PI_CHAT_URL||'https://pi-chat.premchandyadlapati.workers.dev/api/chat';
async function ask(message, history=[]) {
  // Transport retries never turn an invalid answer into success.
  let response;
  for(let attempt=0;attempt<3;attempt++){
    try{response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',origin:'https://pisolutions9.github.io'},body:JSON.stringify({message,history}),signal:AbortSignal.timeout(65000)});break;}catch(error){if(attempt===2)throw error;}
  }
  assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.ok,true);return result;
}
const first='Remember: project code ORCHID-7319, budget 73000 rupees, deadline 14 November. Reply with the project code only.';
const one=await ask(first);assert.equal(one.truth,'model-response');
const two=await ask('What project code, budget, and deadline did I give you?',[{role:'user',content:first},{role:'assistant',content:one.answer}]);
assert.equal(two.truth,'model-response');assert.match(two.answer,/ORCHID-7319/);assert.match(two.answer,/73,?000/);assert.match(two.answer,/(14.*November|November.*14)/i);
const file=await ask('Create an inventory CSV:\npens,12,15.00\nnotebooks,8,45.00');
assert.equal(file.status,'completed');assert.equal(file.truth,'verified-calculation');
assert.equal(file.artifacts?.[0]?.content,'item,quantity,unit_price,total\r\npens,12,15.00,180.00\r\nnotebooks,8,45.00,360.00\r\nGrand total,,,540.00\r\n');
const long=await ask('Write a complete 12-step software launch checklist. Each numbered step must contain at least 25 words. End with the exact marker CHECKLIST_COMPLETE.');
assert.equal(long.truth,'model-response');assert.match(long.answer,/CHECKLIST_COMPLETE/);assert.match(long.answer,/(?:^|\n)\s*(?:\*\*)?12[.)]/);
console.log(JSON.stringify({ok:true,sha:process.env.GITHUB_SHA||'external-diagnostic',recall:two.answer,artifact:file.evidence,longAnswerCharacters:long.answer.length,completionMarker:true}));
