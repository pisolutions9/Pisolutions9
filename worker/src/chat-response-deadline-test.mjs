import assert from 'node:assert/strict';
import worker from './index.js';

const request=new Request('https://pi.test/api/chat',{
  method:'POST',
  headers:{'content-type':'application/json',origin:'https://pisolutions9.github.io'},
  body:JSON.stringify({message:'Explain the water cycle to a high school student.'})
});
const never={run:async()=>await new Promise(()=>{})};
const started=Date.now();
const response=await worker.fetch(request,{AI:never});
const elapsed=Date.now()-started;
const body=await response.json();
assert.equal(response.status,503);
assert.equal(body.ok,false);
assert.equal(body.status,'provider_timeout');
assert.equal(body.error,'customer_request_deadline_exceeded');
assert.equal(body.truth,'unknown');
assert.match(body.answer,/could not complete/i);
assert.match(response.headers.get('x-pi-request-id')||'',/^[0-9a-f-]{36}$/i);
assert.match(response.headers.get('server-timing')||'',/^pi_chat;dur=\d+(, pi_[a-z0-9_]+;dur=\d+(;desc="inflight")?)*$/);
assert.match(response.headers.get('server-timing'),/, pi_edge_model;dur=\d+;desc="inflight"$/);
assert.ok(elapsed<22000,`expected response before the 22-second customer timeout; got ${elapsed}ms`);
console.log('PI bounded chat response deadline passed');
