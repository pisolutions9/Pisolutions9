import assert from 'node:assert/strict';
import worker, { resetProviderHealthForTest } from './index.js';

const originalFetch = globalThis.fetch;
const ask = async (message, env = {}) => {
  const response = await worker.fetch(new Request('https://pi.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://pisolutions9.github.io' },
    body: JSON.stringify({ message })
  }), env);
  return { status: response.status, body: await response.json() };
};

try {
  resetProviderHealthForTest();
  globalThis.fetch = async url => {
    if (String(url).includes('raw.githubusercontent.com/')) return new Response('missing', { status: 404 });
    if (String(url).includes('api.openai.com/')) return new Response(JSON.stringify({ error: { message: 'upstream gateway failed' } }), { status: 502, headers: { 'content-type': 'application/json' } });
    throw new Error('free news source unavailable in offline fixture');
  };
  const unavailable = await ask('give me three major global headlines from today. publisher and exact publication time for each. live evidence only.', { OPENAI_API_KEY: 'offline-fixture', PI_WEB_MODEL: 'fixture-model' });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.ok, false);
  assert.equal(unavailable.body.truth, 'unknown');
  assert.match(unavailable.body.answer, /will not guess/i);
  assert.ok(!unavailable.body.sources?.length);

  resetProviderHealthForTest();
  globalThis.fetch = async url => {
    if (String(url).includes('raw.githubusercontent.com/')) return new Response(JSON.stringify({
      updatedAt: new Date().toISOString(),
      items: [1, 2, 3].map(n => ({ title: `Verified headline ${n}`, url: `https://publisher.example/story-${n}`, source: 'Fixture publisher', publishedAt: new Date().toISOString() }))
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error('news cache should answer before provider calls');
  };
  const sourced = await ask('What are the top 3 major world news developments happening today? Give the exact publication time and source for every claim.', { OPENAI_API_KEY: 'offline-fixture' });
  assert.equal(sourced.status, 200);
  assert.equal(sourced.body.truth, 'live-data-response');
  assert.equal(sourced.body.sources.length, 3);

  const shopping = await ask('find two wifi routers under $120 actually in stock online now. seller, current price, direct link. if you cannot verify, say so.');
  assert.equal(shopping.status, 200);
  assert.equal(shopping.body.truth, 'retailer-search-link');
  assert.match(shopping.body.answer, /not independently verified/i);
  assert.doesNotMatch(shopping.body.answer, /\$\d|in stock at/i);
  assert.ok(shopping.body.sources.every(source => /^https:\/\//.test(source.url)));
  console.log('PI news and shopping customer boundaries passed');
} finally {
  globalThis.fetch = originalFetch;
  resetProviderHealthForTest();
}
