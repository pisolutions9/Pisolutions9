import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { PISessionStore } from './session-store.mjs';
import { handleBillingRequest, verifyStripeSignature } from './billing.mjs';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
if(!globalThis.btoa)globalThis.btoa=value=>Buffer.from(value,'binary').toString('base64');

class Storage{constructor(){this.map=new Map()}async get(k){return this.map.get(k)}async put(k,v){this.map.set(k,structuredClone(v))}async delete(k){this.map.delete(k)}}
const objects=new Map();
const env={
  PI_STRIPE_SECRET_KEY:'sk_test_example',
  PI_STRIPE_WEBHOOK_SECRET:'whsec_test_secret',
  PI_STRIPE_PRICE_ID:'price_test_123',
  PI_SESSION:{idFromName:n=>n,get(id){if(!objects.has(id))objects.set(id,new PISessionStore({storage:new Storage()}));return{fetch:(...args)=>objects.get(id).fetch(new Request(...args))}}}
};
const origin='https://pisolutions9.github.io';
const request=(path,{method='GET',body,headers={}}={})=>new Request('https://worker.example'+path,{method,headers:{origin,...headers},...(body===undefined?{}:{body})});

let response=await handleBillingRequest(request('/api/billing/config'),env);
let body=await response.json();
assert.equal(response.status,200);assert.equal(body.billingReady,true);assert.equal(body.billingMode,'test');assert.equal(body.testBillingReady,true);assert.equal(body.liveBillingReady,false);

const originalFetch=globalThis.fetch;
let checkoutRequest;
globalThis.fetch=async(url,options)=>{
  if(String(url)==='https://api.stripe.com/v1/checkout/sessions'){
    checkoutRequest={url,options};
    return new Response(JSON.stringify({id:'cs_test_1',url:'https://checkout.stripe.com/c/pay/test'}),{status:200,headers:{'content-type':'application/json'}});
  }
  return originalFetch(url,options);
};
response=await handleBillingRequest(request('/api/billing/start',{method:'POST',headers:{'CF-Connecting-IP':'127.0.0.1'},body:'{}'}),env);
body=await response.json();
assert.equal(response.status,200);assert.match(body.customerToken,/^[A-Za-z0-9_-]{43}$/);
assert.equal(body.checkoutUrl,'https://checkout.stripe.com/c/pay/test');
assert.match(checkoutRequest.options.body,/mode=subscription/);
assert.match(checkoutRequest.options.body,/price_test_123/);
assert.ok(checkoutRequest.options.headers['Idempotency-Key']);
const customerToken=body.customerToken;
const customerKey=new URLSearchParams(checkoutRequest.options.body).get('client_reference_id');
globalThis.fetch=originalFetch;

const raw=JSON.stringify({id:'evt_1',type:'checkout.session.completed',data:{object:{client_reference_id:customerKey,customer:'cus_1',subscription:'sub_1',payment_status:'paid'}}});
const timestamp=Math.floor(Date.now()/1000);
const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.PI_STRIPE_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
const digest=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+'.'+raw));
const signature=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
assert.equal(await verifyStripeSignature(raw,`t=${timestamp},v1=${signature}`,env.PI_STRIPE_WEBHOOK_SECRET),true);

response=await handleBillingRequest(request('/api/billing/webhook',{method:'POST',body:raw,headers:{'Stripe-Signature':`t=${timestamp},v1=${signature}`}}),env);
body=await response.json();assert.equal(response.status,200);assert.equal(body.duplicate,false);
response=await handleBillingRequest(request('/api/billing/webhook',{method:'POST',body:raw,headers:{'Stripe-Signature':`t=${timestamp},v1=${signature}`}}),env);
body=await response.json();assert.equal(body.duplicate,true);

response=await handleBillingRequest(request('/api/billing/status',{headers:{Authorization:`Bearer ${customerToken}`}}),env);
body=await response.json();assert.equal(response.status,200);assert.equal(body.entitlement.entitled,true);

const failRaw=JSON.stringify({id:'evt_2',type:'invoice.payment_failed',data:{object:{customer:'cus_1',subscription:'sub_1'}}});
const t2=Math.floor(Date.now()/1000);
const d2=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(t2+'.'+failRaw));
const s2=[...new Uint8Array(d2)].map(b=>b.toString(16).padStart(2,'0')).join('');
response=await handleBillingRequest(request('/api/billing/webhook',{method:'POST',body:failRaw,headers:{'Stripe-Signature':`t=${t2},v1=${s2}`}}),env);
assert.equal(response.status,200);
response=await handleBillingRequest(request('/api/billing/status',{headers:{Authorization:`Bearer ${customerToken}`}}),env);
body=await response.json();assert.equal(body.entitlement.entitled,false);

response=await handleBillingRequest(request('/api/billing/webhook',{method:'POST',body:raw,headers:{'Stripe-Signature':'t=1,v1=bad'}}),env);
assert.equal(response.status,400);

const liveEnv={...env,PI_STRIPE_SECRET_KEY:'sk_live_example'};
response=await handleBillingRequest(request('/api/billing/config'),liveEnv);
body=await response.json();assert.equal(body.billingMode,'live');assert.equal(body.liveBillingReady,true);assert.equal(body.testBillingReady,false);
const restrictedTestEnv={...env,PI_STRIPE_SECRET_KEY:'rk_test_example'};
response=await handleBillingRequest(request('/api/billing/config'),restrictedTestEnv);
body=await response.json();assert.equal(body.billingMode,'test');assert.equal(body.billingReady,true);assert.equal(body.testBillingReady,true);
const restrictedLiveEnv={...env,PI_STRIPE_SECRET_KEY:'rk_live_example'};
response=await handleBillingRequest(request('/api/billing/config'),restrictedLiveEnv);
body=await response.json();assert.equal(body.billingMode,'live');assert.equal(body.liveBillingReady,true);assert.equal(body.testBillingReady,false);
const disabled={...env,PI_STRIPE_SECRET_KEY:''};
response=await handleBillingRequest(request('/api/billing/start',{method:'POST',body:'{}'}),disabled);
assert.equal(response.status,503);
console.log('PI Stripe billing runtime tests passed.');
