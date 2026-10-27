import assert from 'node:assert/strict';
import { providerError } from './provider-error.mjs';
import worker, { resetProviderHealthForTest } from './index.js';

for (const code of ['insufficient_quota','billing_hard_limit_reached',
  'organization_spend_limit_exceeded','organization_usage_limit_exceeded']) {
  const response = new Response(JSON.stringify({error:{code,message:'sensitive-canary'}}),{status:429});
  assert.deepEqual(await providerError(response), {error:'chat_provider_quota_exhausted',status:503});
}
for (const body of ['broken-json', JSON.stringify({error:{code:'rate_limit_exceeded'}}), 'x'.repeat(8193)]) {
  assert.deepEqual(await providerError(new Response(body,{status:429})), {error:'chat_provider_rate_limited',status:503});
}
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({error:{code:'insufficient_quota',message:'sensitive-canary'}}),{status:429});
  const response = await worker.fetch(new Request('https://pi.test/api/chat',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({message:'What is the weather today in Mobile, Alabama?'})
  }),{OPENAI_API_KEY:'test-key'});
  const body = await response.json();
  assert.equal(response.status,503);
  assert.equal(body.ok,false);
  assert.equal(body.error,'chat_provider_quota_exhausted');
  assert.equal(body.truth,'unknown');
  assert.doesNotMatch(JSON.stringify(body),/sensitive-canary|test-key/);
} finally { globalThis.fetch = originalFetch; }

const liveFetch=globalThis.fetch;
try {
  for(const [upstreamStatus,expectedError] of [
    [401,'chat_provider_auth_failed'],
    [403,'chat_provider_access_denied'],
    [404,'chat_provider_model_or_endpoint_not_found'],
    [400,'chat_provider_request_rejected']
  ]) {
    resetProviderHealthForTest();
    globalThis.fetch=async url=>{
      if(String(url).startsWith('https://api.openai.com/'))return new Response('denied',{status:upstreamStatus});
      return new Response('unavailable',{status:503});
    };
    const response=await worker.fetch(new Request('https://pi.test/api/chat',{
      method:'POST',headers:{'content-type':'application/json','origin':'https://pisolutions9.github.io'},
      body:JSON.stringify({message:'What are the top 3 major world news developments happening today? Give the exact publication time and source for every claim.'})
    }),{OPENAI_API_KEY:'offline-test-key',PI_WEB_MODEL:'offline-web-model'});
    const body=await response.json();
    assert.equal(response.status,503,`unavailable live evidence after upstream ${upstreamStatus} must use service-unavailable status`);
    assert.equal(body.error,expectedError,'keep the specific provider failure for diagnosis');
    assert.equal(body.status,'live_evidence_required');
    assert.equal(body.truth,'unknown');
    assert.equal(body.ok,false);
    assert.deepEqual(body.sources||[],[]);
    assert.match(body.answer,/will not guess/i);
    assert.doesNotMatch(JSON.stringify(body),/offline-test-key|sensitive-canary/);
  }
} finally { globalThis.fetch=liveFetch; resetProviderHealthForTest(); }
console.log('Provider quota classification and live truth-boundary tests passed.');
