import assert from 'node:assert/strict';
import worker, { resetProviderHealthForTest } from './index.js';

const originalFetch = globalThis.fetch;
const seenModels = [];
globalThis.fetch = async (_url, init = {}) => {
  const body = JSON.parse(init.body || '{}');
  seenModels.push(body.model);
  if (seenModels.length === 1) {
    return new Response(JSON.stringify({ error: { message: 'busy' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' }
    });
  }
  return new Response(JSON.stringify({
    output_text: 'It is 78°F right now.',
    output: [{ type:'web_search_call', action:{ sources:[{ url:'https://example.com/weather', title:'Weather' }] } }]
  }), { status:200, headers:{'content-type':'application/json'} });
};

try {
  const request = new Request('https://pi.test/api/chat', {
    method:'POST',
    headers:{'content-type':'application/json',origin:'https://pisolutions9.github.io'},
    body:JSON.stringify({message:'What is the weather right now?'})
  });
  const response = await worker.fetch(request, { OPENAI_API_KEY:'test-key', PI_WEB_MODEL:'model-a', PI_CHAT_MODEL:'model-b' });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.truth, 'web-grounded-model-response');
  assert.deepEqual(seenModels.slice(0,2), ['model-a','model-b']);
  console.log('PI live provider fallback test passed');
} finally {
  globalThis.fetch = originalFetch;
}


const originalFetch2 = globalThis.fetch;
const vendorAttempts = [];
globalThis.fetch = async (url, init = {}) => {
  const body = JSON.parse(init.body || '{}');
  vendorAttempts.push({url:String(url), model:body.model});
  if (String(url).startsWith('https://api.openai.com/')) {
    return new Response(JSON.stringify({ error: { code:'insufficient_quota', message:'quota' } }), {
      status:429, headers:{'content-type':'application/json'}
    });
  }
  if (String(url).startsWith('https://fallback.example/')) {
    return new Response(JSON.stringify({ output_text:'Independent fallback answered successfully.' }), {
      status:200, headers:{'content-type':'application/json'}
    });
  }
  throw new Error('unexpected provider URL');
};

try {
  const request = new Request('https://pi.test/api/chat', {
    method:'POST',
    headers:{'content-type':'application/json',origin:'https://pisolutions9.github.io'},
    body:JSON.stringify({message:'Explain why backups matter in one sentence.'})
  });
  const response = await worker.fetch(request, {
    OPENAI_API_KEY:'openai-test-key',
    PI_CHAT_MODEL:'model-a',
    PI_FALLBACK_API_KEY:'fallback-test-key',
    PI_FALLBACK_API_URL:'https://fallback.example/v1',
    PI_FALLBACK_MODEL:'fallback-model'
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.answer, 'Independent fallback answered successfully.');
  assert.equal(vendorAttempts.filter(x => x.url.startsWith('https://api.openai.com/')).length, 1);
  assert.equal(vendorAttempts.filter(x => x.url.startsWith('https://fallback.example/')).length, 1);

  const secondRequest = new Request('https://pi.test/api/chat', {
    method:'POST',
    headers:{'content-type':'application/json',origin:'https://pisolutions9.github.io'},
    body:JSON.stringify({message:'Explain why redundancy matters in one sentence.'})
  });
  const secondResponse = await worker.fetch(secondRequest, {
    OPENAI_API_KEY:'openai-test-key',
    PI_CHAT_MODEL:'model-a',
    PI_FALLBACK_API_KEY:'fallback-test-key',
    PI_FALLBACK_API_URL:'https://fallback.example/v1',
    PI_FALLBACK_MODEL:'fallback-model'
  });
  const secondBody = await secondResponse.json();
  assert.equal(secondResponse.status, 200);
  assert.equal(secondBody.answer, 'Independent fallback answered successfully.');
  assert.equal(vendorAttempts.filter(x => x.url.startsWith('https://api.openai.com/')).length, 1);
  assert.equal(vendorAttempts.filter(x => x.url.startsWith('https://fallback.example/')).length, 2);
  console.log('PI quota-aware independent vendor failover and cooldown test passed');
} finally {
  globalThis.fetch = originalFetch2;
}


resetProviderHealthForTest();

const originalFetch3 = globalThis.fetch;
let liveOpenAIAttempts = 0;
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('https://api.openai.com/')) throw new Error('unexpected live research provider');
  liveOpenAIAttempts += 1;
  return new Response(JSON.stringify({ error:{ code:'insufficient_quota', message:'quota' } }), {
    status:429, headers:{'content-type':'application/json'}
  });
};

try {
  const request = new Request('https://pi.test/api/chat', {
    method:'POST',
    headers:{'content-type':'application/json',origin:'https://pisolutions9.github.io'},
    body:JSON.stringify({message:'What is the weather right now in Mobile, Alabama?'})
  });
  const response = await worker.fetch(request, {
    OPENAI_API_KEY:'live-test-key',
    PI_WEB_MODEL:'web-a',
    PI_CHAT_MODEL:'chat-b'
  });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'chat_provider_quota_exhausted');
  assert.equal(liveOpenAIAttempts, 1);
  console.log('PI live research quota circuit test passed');
} finally {
  globalThis.fetch = originalFetch3;
}


resetProviderHealthForTest();

const originalFetch4 = globalThis.fetch;
const groqCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const body = JSON.parse(init.body || '{}');
  groqCalls.push({url:String(url), body});
  if (String(url).startsWith('https://api.openai.com/')) {
    return new Response(JSON.stringify({ error:{ code:'insufficient_quota', message:'quota' } }), {
      status:429, headers:{'content-type':'application/json'}
    });
  }
  if (String(url) === 'https://api.groq.com/openai/v1/chat/completions') {
    return new Response(JSON.stringify({
      choices:[{message:{role:'assistant',content:'Groq independent fallback answered.'}}]
    }), {status:200, headers:{'content-type':'application/json'}});
  }
  throw new Error('unexpected Groq failover URL: ' + url);
};

try {
  const request = new Request('https://pi.test/api/chat', {
    method:'POST',
    headers:{'content-type':'application/json',origin:'https://pisolutions9.github.io'},
    body:JSON.stringify({message:'Explain redundancy briefly.'})
  });
  const response = await worker.fetch(request, {
    OPENAI_API_KEY:'openai-test-key',
    PI_CHAT_MODEL:'model-a',
    GROQ_API_KEY:'groq-test-key'
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.answer, 'Groq independent fallback answered.');
  assert.equal(groqCalls.filter(x => x.url.startsWith('https://api.openai.com/')).length, 1);
  assert.equal(groqCalls.filter(x => x.url === 'https://api.groq.com/openai/v1/chat/completions').length, 1);
  assert.equal(groqCalls.find(x => x.url === 'https://api.groq.com/openai/v1/chat/completions').body.model, 'openai/gpt-oss-20b');
  console.log('PI one-key Groq cross-vendor failover test passed');
} finally {
  globalThis.fetch = originalFetch4;
}


resetProviderHealthForTest();

const originalFetch5 = globalThis.fetch;
const liveVendorCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const body = JSON.parse(init.body || '{}');
  liveVendorCalls.push({url:String(url), body});
  if (String(url).startsWith('https://api.openai.com/')) {
    return new Response(JSON.stringify({ error:{ code:'insufficient_quota', message:'quota' } }), {
      status:429, headers:{'content-type':'application/json'}
    });
  }
  if (String(url) === 'https://api.groq.com/openai/v1/chat/completions') {
    return new Response(JSON.stringify({
      choices:[{
        message:{
          role:'assistant',
          content:'It is currently raining in the test location.',
          executed_tools:[{
            search_results:[{
              url:'https://example.com/live-weather',
              title:'Live Weather'
            }]
          }]
        }
      }]
    }), {status:200, headers:{'content-type':'application/json'}});
  }
  throw new Error('unexpected live failover URL: ' + url);
};

try {
  const request = new Request('https://pi.test/api/chat', {
    method:'POST',
    headers:{'content-type':'application/json',origin:'https://pisolutions9.github.io'},
    body:JSON.stringify({message:'What is the weather right now in Mobile, Alabama?'})
  });
  const response = await worker.fetch(request, {
    OPENAI_API_KEY:'openai-live-test',
    PI_WEB_MODEL:'web-a',
    PI_CHAT_MODEL:'chat-b',
    GROQ_API_KEY:'groq-live-test'
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.truth, 'web-grounded-model-response');
  assert.equal(body.source, 'pi-chat-web-groq:groq/compound-mini');
  assert.equal(body.sources?.[0]?.url, 'https://example.com/live-weather');
  assert.equal(liveVendorCalls.filter(x => x.url.startsWith('https://api.openai.com/')).length, 1);
  assert.equal(liveVendorCalls.filter(x => x.url === 'https://api.groq.com/openai/v1/chat/completions').length, 1);
  console.log('PI OpenAI-to-Groq sourced live-research failover test passed');
} finally {
  globalThis.fetch = originalFetch5;
}


resetProviderHealthForTest();

const originalFetchOpenRouter = globalThis.fetch;
const openRouterCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const body = JSON.parse(init.body || '{}');
  openRouterCalls.push({url:String(url), body});
  if (String(url).startsWith('https://api.openai.com/')) {
    return new Response(JSON.stringify({ error:{ code:'insufficient_quota', message:'quota' } }), {
      status:429, headers:{'content-type':'application/json'}
    });
  }
  if (String(url) === 'https://api.groq.com/openai/v1/chat/completions') {
    return new Response(JSON.stringify({ error:{ message:'rate limited' } }), {
      status:429, headers:{'content-type':'application/json'}
    });
  }
  if (String(url) === 'https://openrouter.ai/api/v1/chat/completions') {
    return new Response(JSON.stringify({
      choices:[{message:{role:'assistant',content:'OpenRouter free multi-provider fallback answered.'}}]
    }), {status:200, headers:{'content-type':'application/json'}});
  }
  throw new Error('unexpected OpenRouter failover URL: ' + url);
};

try {
  const request = new Request('https://pi.test/api/chat', {
    method:'POST',
    headers:{'content-type':'application/json',origin:'https://pisolutions9.github.io'},
    body:JSON.stringify({message:'Explain resilient provider routing in one sentence.'})
  });
  const response = await worker.fetch(request, {
    OPENAI_API_KEY:'openai-test-key',
    PI_CHAT_MODEL:'model-a',
    GROQ_API_KEY:'groq-test-key',
    OPENROUTER_API_KEY:'openrouter-test-key'
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.answer, 'OpenRouter free multi-provider fallback answered.');
  assert.match(body.source, /^pi-chat-openrouter:openrouter\/free$/);
  assert.equal(body.truth, 'provisional-model-response');
  assert.equal(body.verification, 'not-completed');
  assert.equal(openRouterCalls.filter(x => x.url.startsWith('https://api.openai.com/')).length, 1);
  assert.equal(openRouterCalls.filter(x => x.url === 'https://api.groq.com/openai/v1/chat/completions').length, 1);
  assert.equal(openRouterCalls.filter(x => x.url === 'https://openrouter.ai/api/v1/chat/completions').length, 1);
  assert.equal(openRouterCalls.find(x => x.url === 'https://openrouter.ai/api/v1/chat/completions').body.model, 'openrouter/free');
  console.log('PI OpenAI-to-Groq-to-OpenRouter free fallback test passed');
} finally {
  globalThis.fetch = originalFetchOpenRouter;
}

