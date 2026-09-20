const PUBLIC_APP_URL='https://pisolutions9.github.io/Pisolutions9/';
const CUSTOMER_TOKEN=/^[A-Za-z0-9_-]{43}$/;
const ACTIVE_STATES=new Set(['active','trialing']);

function response(body,status=200,request){
  const origin=request.headers.get('Origin')||'';
  const headers={
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
    'access-control-allow-methods':'GET,POST,OPTIONS',
    'access-control-allow-headers':'content-type,authorization,stripe-signature',
    vary:'Origin'
  };
  if(origin==='https://pisolutions9.github.io')headers['access-control-allow-origin']=origin;
  return new Response(status===204?null:JSON.stringify(body),{status,headers});
}
function randomToken(){
  const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);
  let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
}
async function sha256(value){
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function bearer(request){
  const header=request.headers.get('Authorization')||request.headers.get('authorization')||'';
  const match=header.match(/^Bearer\s+([A-Za-z0-9_-]{43})$/);return match?match[1]:'';
}
function configured(env){
  return Boolean(env.PI_STRIPE_SECRET_KEY&&env.PI_STRIPE_WEBHOOK_SECRET&&env.PI_STRIPE_PRICE_ID&&env.PI_SESSION);
}
function store(env,name){const id=env.PI_SESSION.idFromName(name);return env.PI_SESSION.get(id);}
async function internal(stub,payload){
  const r=await stub.fetch('https://pi-session.internal/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  let body={};try{body=await r.json();}catch{}
  return {status:r.status,body};
}
async function customerStub(env,customerKey){return store(env,'billing-customer:'+customerKey);}
async function globalStub(env){return store(env,'billing-global-v1');}
function formEncode(data){
  const p=new URLSearchParams();
  for(const [key,value] of Object.entries(data))if(value!==undefined&&value!==null)p.append(key,String(value));
  return p.toString();
}
async function stripeRequest(env,path,{method='GET',body,idempotencyKey}={}){
  const headers={authorization:'Bearer '+env.PI_STRIPE_SECRET_KEY};
  if(body!==undefined)headers['content-type']='application/x-www-form-urlencoded';
  if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
  return fetch('https://api.stripe.com'+path,{method,headers,...(body===undefined?{}:{body:formEncode(body)})});
}
function parseSignature(header=''){
  const out={t:'',v1:[]};
  for(const part of String(header).split(',')){
    const [key,value]=part.split('=',2);
    if(key==='t')out.t=value||'';
    if(key==='v1'&&value)out.v1.push(value);
  }
  return out;
}
function hex(bytes){return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function verifyStripeSignature(raw,header,secret,now=Date.now()){
  const sig=parseSignature(header);const timestamp=Number(sig.t);
  if(!Number.isFinite(timestamp)||!sig.v1.length)return false;
  if(Math.abs(Math.floor(now/1000)-timestamp)>300)return false;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const expected=hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(sig.t+'.'+raw)));
  let matched=false;
  for(const candidate of sig.v1){
    if(candidate.length!==expected.length)continue;
    let diff=0;for(let i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^candidate.charCodeAt(i);
    if(diff===0)matched=true;
  }
  return matched;
}
async function setEntitlement(env,customerKey,{entitled,status,stripeCustomerId='',subscriptionId=''}){
  const stub=await customerStub(env,customerKey);
  return internal(stub,{action:'billing_entitlement_set',entitled,status,stripeCustomerId,subscriptionId});
}
async function lookupCustomerKey(env,stripeCustomerId){
  if(!stripeCustomerId)return '';
  const result=await internal(await globalStub(env),{action:'billing_lookup_customer',stripeCustomerId});
  return String(result.body?.customerKey||'');
}
async function processStripeEvent(env,event){
  const global=await globalStub(env);
  const check=await internal(global,{action:'billing_event_check',eventId:event.id});
  if(check.body?.processed)return {duplicate:true};
  const object=event?.data?.object||{};
  const type=String(event.type||'');
  let customerKey=String(object?.metadata?.pi_customer_key||object?.client_reference_id||'');
  const stripeCustomerId=String(object?.customer||'');
  if(!customerKey&&stripeCustomerId)customerKey=await lookupCustomerKey(env,stripeCustomerId);
  const subscriptionId=String(object?.subscription||object?.id?.startsWith?.('sub_')?object.id:'');
  if(type==='checkout.session.completed'&&customerKey){
    if(stripeCustomerId)await internal(global,{action:'billing_bind_customer',stripeCustomerId,customerKey});
    const entitled=Boolean(object.subscription)&&['paid','no_payment_required'].includes(String(object.payment_status||''));
    await setEntitlement(env,customerKey,{entitled,status:entitled?'active':'checkout_incomplete',stripeCustomerId,subscriptionId:String(object.subscription||'')});
  }else if((type==='customer.subscription.created'||type==='customer.subscription.updated'||type==='customer.subscription.deleted')&&customerKey){
    if(stripeCustomerId)await internal(global,{action:'billing_bind_customer',stripeCustomerId,customerKey});
    const status=String(object.status||'unknown').toLowerCase();
    await setEntitlement(env,customerKey,{entitled:ACTIVE_STATES.has(status),status,stripeCustomerId,subscriptionId:String(object.id||'')});
  }else if(['invoice.payment_failed','charge.dispute.created','checkout.session.expired'].includes(type)&&customerKey){
    await setEntitlement(env,customerKey,{entitled:false,status:type,stripeCustomerId,subscriptionId});
  }else if(type==='invoice.paid'&&customerKey){
    await setEntitlement(env,customerKey,{entitled:true,status:'active',stripeCustomerId,subscriptionId});
  }
  await internal(global,{action:'billing_event_mark',eventId:event.id});
  return {duplicate:false};
}
export async function handleBillingRequest(request,env){
  const origin=request.headers.get('Origin')||'';
  if(origin&&origin!=='https://pisolutions9.github.io')return response({ok:false,error:'origin_not_allowed'},403,request);
  if(request.method==='OPTIONS')return response({},204,request);
  const url=new URL(request.url);
  if(url.pathname==='/api/billing/config'){
    if(request.method!=='GET')return response({ok:false,error:'method_not_allowed'},405,request);
    return response({ok:true,provider:'stripe',checkoutConfigured:Boolean(env.PI_STRIPE_SECRET_KEY&&env.PI_STRIPE_PRICE_ID&&env.PI_SESSION),webhookConfigured:Boolean(env.PI_STRIPE_WEBHOOK_SECRET&&env.PI_SESSION),liveBillingReady:configured(env)},200,request);
  }
  if(url.pathname==='/api/billing/webhook'){
    if(request.method!=='POST')return response({ok:false,error:'method_not_allowed'},405,request);
    if(!configured(env))return response({ok:false,error:'billing_not_configured'},503,request);
    const raw=await request.text();
    const valid=await verifyStripeSignature(raw,request.headers.get('Stripe-Signature')||'',env.PI_STRIPE_WEBHOOK_SECRET);
    if(!valid)return response({ok:false,error:'invalid_webhook_signature'},400,request);
    let event;try{event=JSON.parse(raw);}catch{return response({ok:false,error:'invalid_json'},400,request);}
    if(!event?.id||!event?.type)return response({ok:false,error:'payment_event_invalid'},400,request);
    const result=await processStripeEvent(env,event);
    return response({ok:true,duplicate:result.duplicate},200,request);
  }
  if(!configured(env))return response({ok:false,error:'billing_not_configured'},503,request);
  if(url.pathname==='/api/billing/start'){
    if(request.method!=='POST')return response({ok:false,error:'method_not_allowed'},405,request);
    const ip=String(request.headers.get('CF-Connecting-IP')||request.headers.get('x-forwarded-for')||'unknown');
    const rateKey=await sha256(ip);
    const rate=await internal(await globalStub(env),{action:'billing_rate_check',key:rateKey});
    if(rate.body?.allowed!==true)return response({ok:false,error:'billing_rate_limited',retryAfterMs:rate.body?.retryAfterMs||0},429,request);
    const customerToken=randomToken();const customerKey=await sha256(customerToken);
    const idempotencyKey='pi-checkout:'+customerKey+':'+env.PI_STRIPE_PRICE_ID;
    const stripe=await stripeRequest(env,'/v1/checkout/sessions',{method:'POST',idempotencyKey,body:{
      mode:'subscription',
      success_url:PUBLIC_APP_URL+'?billing=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url:PUBLIC_APP_URL+'?billing=cancelled',
      'line_items[0][price]':env.PI_STRIPE_PRICE_ID,
      'line_items[0][quantity]':'1',
      client_reference_id:customerKey,
      'metadata[pi_customer_key]':customerKey,
      'subscription_data[metadata][pi_customer_key]':customerKey
    }});
    let body={};try{body=await stripe.json();}catch{}
    if(!stripe.ok||!body.id||!body.url)return response({ok:false,error:'checkout_provider_failed'},502,request);
    await internal(await customerStub(env,customerKey),{action:'billing_checkout_set',sessionId:body.id,customerKey});
    return response({ok:true,checkoutUrl:body.url,customerToken,sessionId:body.id},200,request);
  }
  if(url.pathname==='/api/billing/status'){
    if(request.method!=='GET')return response({ok:false,error:'method_not_allowed'},405,request);
    const token=bearer(request);if(!CUSTOMER_TOKEN.test(token))return response({ok:false,error:'customer_auth_required'},401,request);
    const customerKey=await sha256(token);
    const ent=await internal(await customerStub(env,customerKey),{action:'billing_entitlement_get'});
    return response({ok:true,entitlement:ent.body?.entitlement||{entitled:false,status:'none'}},200,request);
  }
  return response({ok:false,error:'not_found'},404,request);
}
export {verifyStripeSignature,processStripeEvent};
