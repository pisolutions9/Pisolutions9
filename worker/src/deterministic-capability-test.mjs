import assert from 'node:assert/strict';
import worker, { resetProviderHealthForTest } from './index.js';

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network must not be used by deterministic capabilities'); };

const deadAI = {
  run: async () => { throw new Error('model must not be used by deterministic capabilities'); },
  toMarkdown: async () => { throw new Error('attachment conversion not expected'); }
};

async function ask(message, env = {}) {
  const request = new Request('https://pi.test/api/chat', {
    method:'POST',
    headers:{'content-type':'application/json',origin:'https://pisolutions9.github.io'},
    body:JSON.stringify({message})
  });
  return worker.fetch(request, { AI:deadAI, ...env });
}

try {
  resetProviderHealthForTest();

  const capabilityResponse = await ask('What can you do and what providers do you have?', { OPENAI_API_KEY:'test-openai', GROQ_API_KEY:'test-groq' });
  const capability = await capabilityResponse.json();
  assert.equal(capabilityResponse.status, 200);
  assert.equal(capability.ok, true);
  assert.equal(capability.source, 'pi-runtime-capabilities');
  assert.equal(capability.truth, 'runtime-derived');
  assert.equal(capability.capabilities.version, 'PI V1.02');
  assert.equal(capability.capabilities.providers.cloudflareWorkersAI, true);
  assert.equal(capability.capabilities.providers.openai, true);
  assert.equal(capability.capabilities.providers.groq, true);
  assert.equal(capability.capabilities.providers.openrouter, false);
  assert.equal(capability.capabilities.capabilities.liveWebResearch, true);
  assert.equal(capability.capabilities.capabilities.crossDeviceSessionSync, false);
  assert.equal(capability.capabilities.capabilities.authenticatedOwnerWorkspace, false);
  assert.equal(capability.capabilities.capabilities.verifiedLiveShopping, false);
  assert.match(capability.answer, /authenticated owner-account workspace/i);
  assert.match(capability.answer, /verified live shopping.*not currently configured/i);
  assert.doesNotMatch(capability.answer, /test-openai|test-groq/);


  const syncEnv = {
    OPENAI_API_KEY:'test-openai',
    PI_SESSION:{ idFromName(){ return 'id'; } }
  };
  const syncResponse = await ask('What capabilities do you have?', syncEnv);
  const sync = await syncResponse.json();
  assert.equal(sync.source, 'pi-runtime-capabilities');
  assert.equal(sync.capabilities.capabilities.crossDeviceSessionSync, true);
  assert.equal(sync.capabilities.capabilities.authenticatedOwnerWorkspace, false);
  assert.match(sync.answer, /private sync link\/token/i);
  assert.match(sync.answer, /not an authenticated owner-account workspace/i);

  for (const prompt of [
    'How do you verify answers?',
    'Can you browse the web?',
    'Can you access the internet?',
    'Do you have live web research access?'
  ]) {
    const selfResponse = await ask(prompt, { OPENAI_API_KEY:'test-openai' });
    const self = await selfResponse.json();
    assert.equal(selfResponse.status, 200);
    assert.equal(self.ok, true);
    assert.equal(self.source, 'pi-runtime-capabilities');
    assert.equal(self.truth, 'runtime-derived');
    assert.match(self.answer, /PI V1\.02/i);
    assert.match(self.answer, /verification|verified|review/i);
    assert.match(self.answer, /live web research|live-research/i);
    assert.doesNotMatch(self.answer, /does not have a direct verification process/i);
    assert.doesNotMatch(self.answer, /large database of knowledge/i);
  }

  const arithmeticResponse = await ask('What is (125 * 32) - 750?');
  const arithmetic = await arithmeticResponse.json();
  assert.equal(arithmeticResponse.status, 200);
  assert.equal(arithmetic.ok, true);
  assert.equal(arithmetic.source, 'pi-deterministic-arithmetic');
  assert.equal(arithmetic.truth, 'deterministic-verified');
  assert.equal(arithmetic.answer, 'The answer is 3250.');

  const linearResponse = await ask('A small online retailer has $10,000 to choose between Channel A and Channel B. A costs $4,000 fixed plus $20 per acquired customer. B costs $1,500 fixed plus $35 per acquired customer. At what customer count do their total costs become equal, and which is cheaper at 100 and 300 customers? Show the math clearly.');
  const linear = await linearResponse.json();
  assert.equal(linearResponse.status, 200);
  assert.equal(linear.ok, true);
  assert.equal(linear.source, 'pi-deterministic-linear-cost');
  assert.equal(linear.truth, 'deterministic-verified');
  assert.match(linear.answer, /166\.67/);
  assert.match(linear.answer, /At 100 customers: A = \$6,000; B = \$5,000; Channel B is cheaper/);
  assert.match(linear.answer, /At 300 customers: A = \$10,000; B = \$12,000; Channel A is cheaper/);
  assert.doesNotMatch(linear.answer, /167 customers[^\n.]{0,80}(?:equal|same)/i);

  const clockResponse = await ask('What is the current UTC date right now?');
  const clock = await clockResponse.json();
  assert.equal(clockResponse.status, 200);
  assert.equal(clock.ok, true);
  assert.equal(clock.source, 'pi-runtime-clock');
  assert.equal(clock.truth, 'runtime-derived');
  assert.match(clock.answer, /current UTC date/i);
  assert.match(clock.answer, /Source: PI Worker runtime clock/i);
  assert.match(clock.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  const runwayScenarioResponse = await ask('A company has $2 million cash, $600k monthly burn, and expects revenue to grow from $100k to $250k per month over six months. Build three runway scenarios and explain the assumptions and break-even conditions.');
  const runwayScenario = await runwayScenarioResponse.json();
  assert.equal(runwayScenarioResponse.status,200);
  assert.equal(runwayScenario.ok,true);
  assert.equal(runwayScenario.source,'pi-deterministic-runway-scenarios');
  assert.equal(runwayScenario.truth,'deterministic-verified');
  assert.match(runwayScenario.answer,/4\.47 months/);
  assert.match(runwayScenario.answer,/4\.00 months/);
  assert.match(runwayScenario.answer,/3\.33 months/);
  assert.match(runwayScenario.answer,/monthly revenue must reach \$600k/i);
  assert.match(runwayScenario.answer,/confirm whether "monthly burn" means gross operating outflow or net cash burn/i);

  const systemsResponse = await ask('Review this logic: if a system is highly available, it must also be highly reliable; if it is highly reliable, it must be secure; therefore highly available systems are necessarily secure. Identify the invalid inference and construct a better framework.');
  const systems = await systemsResponse.json();
  assert.equal(systemsResponse.status,200);
  assert.equal(systems.ok,true);
  assert.equal(systems.source,'pi-deterministic-system-properties');
  assert.equal(systems.truth,'deterministic-verified');
  assert.match(systems.answer,/distinct properties/i);
  assert.match(systems.answer,/not proof/i);

  const ecommerceResponse = await ask('An e-commerce service has p95 latency of 900ms, 2% checkout failures, and periodic inventory overselling. Diagnose likely causes and propose a prioritized remediation plan with measurable acceptance tests.');
  const ecommerce = await ecommerceResponse.json();
  assert.equal(ecommerceResponse.status,200);
  assert.equal(ecommerce.ok,true);
  assert.equal(ecommerce.source,'pi-deterministic-ecommerce-reliability');
  assert.equal(ecommerce.truth,'deterministic-verified');
  assert.match(ecommerce.answer,/idempotency/i);
  assert.match(ecommerce.answer,/overselling/i);
  assert.match(ecommerce.answer,/acceptance test/i);

  const quantumResponse = await ask('Explain why quantum computers do not simply replace classical computers. Compare qubits, superposition, entanglement, error correction, and practical workloads, then identify what would have to improve for useful large-scale quantum advantage.');
  const quantum = await quantumResponse.json();
  assert.equal(quantumResponse.status,200);
  assert.equal(quantum.ok,true);
  assert.equal(quantum.source,'pi-deterministic-quantum-classical');
  assert.equal(quantum.truth,'deterministic-verified');
  assert.match(quantum.answer,/superposition/i);
  assert.match(quantum.answer,/error correction/i);
  assert.match(quantum.answer,/heterogeneous/i);

  const paymentResponse = await ask('In a payment API, why can retrying a timed-out POST create duplicate charges? Design a safe retry strategy using idempotency keys and server state.');
  const payment = await paymentResponse.json();
  assert.equal(paymentResponse.status, 200);
  assert.equal(payment.ok, true);
  assert.equal(payment.source, 'pi-deterministic-payment-safety');
  assert.equal(payment.truth, 'deterministic-verified');
  assert.match(payment.answer, /stable idempotency key/i);
  assert.match(payment.answer, /atomically reserves?/i);
  assert.match(payment.answer, /persist/i);
  assert.match(payment.answer, /replay\/return the stored original result or response/i);
  assert.match(payment.answer, /must not create another charge/i);
  assert.match(payment.answer, /reconciliation/i);

  globalThis.fetch = async (url) => {
    const value=String(url);
    if(value.startsWith('https://geocoding-api.open-meteo.com/v1/search')) {
      return new Response(JSON.stringify({results:[{
        name:'Mobile', admin1:'Alabama', country:'United States',
        latitude:30.6944, longitude:-88.0431, timezone:'America/Chicago'
      }]}), {status:200, headers:{'content-type':'application/json'}});
    }
    if(value.startsWith('https://api.open-meteo.com/v1/forecast')) {
      return new Response(JSON.stringify({
        timezone:'America/Chicago',
        current:{
          time:'2026-09-20T05:00',
          temperature_2m:78.4,
          apparent_temperature:80.1,
          relative_humidity_2m:67,
          precipitation:0,
          weather_code:1,
          wind_speed_10m:6.2
        }
      }), {status:200, headers:{'content-type':'application/json'}});
    }
    throw new Error('unexpected weather URL: '+url);
  };
  const weatherResponse = await ask('What is the weather today in Mobile, Alabama?');
  const weather = await weatherResponse.json();
  assert.equal(weatherResponse.status, 200);
  assert.equal(weather.ok, true);
  assert.equal(weather.source, 'pi-weather-open-meteo');
  assert.equal(weather.truth, 'live-data-response');
  assert.match(weather.answer, /Mobile, Alabama, United States/);
  assert.match(weather.answer, /78\.4°F/);
  assert.match(weather.answer, /mainly clear/i);
  assert.equal(weather.sources?.length, 1);
  assert.match(weather.sources[0].url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);

  globalThis.fetch = async (url) => {
    const value=String(url);
    if(value.startsWith('https://serpapi.com/search.json?')){
      const parsed=new URL(value);
      assert.equal(parsed.searchParams.get('engine'),'google');
      assert.match(parsed.searchParams.get('q')||'',/laptops?/i);
      return new Response(JSON.stringify({
        organic_results:[
          {position:1,title:'Laptop A - $649',link:'https://shop.example/laptop-a',snippet:'Seller A current listing $649.'},
          {position:2,title:'Laptop B - $699',link:'https://shop.example/laptop-b',snippet:'Seller B current listing $699.'}
        ]
      }),{status:200,headers:{'content-type':'application/json'}});
    }
    throw new Error('unexpected shopping URL: '+url);
  };
  const shoppingResponse = await ask('Find me two laptops under $700 that are available to buy online right now. Give the seller, current price, and direct product link.', {SERPAPI_API_KEY:'serp-test-key'});
  const shopping = await shoppingResponse.json();
  assert.equal(shoppingResponse.status,200);
  assert.equal(shopping.ok,true);
  assert.equal(shopping.source,'pi-shopping-serpapi');
  assert.equal(shopping.truth,'live-data-response');
  assert.match(shopping.answer,/live shopping results from the web/i);
  assert.equal(shopping.sources?.[0]?.url,'https://shop.example/laptop-a');
  assert.equal(shopping.sources?.[0]?.title,'Laptop A - $649');

  globalThis.fetch = async () => { throw new Error('network must not be used by deterministic capabilities'); };

  console.log('PI provider-independent deterministic capability tests passed');
} finally {
  globalThis.fetch = originalFetch;
}
