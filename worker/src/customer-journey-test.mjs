import assert from 'node:assert/strict';
import worker, { validateHistory } from './index.js';
import { inventoryMission, executeInventory, verifyInventory } from './inventory.mjs';
const request = payload => new Request('https://pi.test/api/chat', { method:'POST', headers:{'content-type':'application/json',origin:'https://pisolutions9.github.io'}, body:JSON.stringify(payload) });
let seen; let seenModel;
let seenOptions;
const env = { AI:{run:async(model,input,options)=>{seen=input;seenModel=model;seenOptions=options;return {response:'Your budget was 73000 rupees.'};}} };
const history=[{role:'user',content:'My budget is 73000 rupees.'},{role:'assistant',content:'Understood.'}];
let result=await (await worker.fetch(request({message:'What was my budget?',history}),env)).json();
assert.equal(result.truth,'model-response');assert.deepEqual(seen.messages.slice(1,-1),history);
assert.equal(seen.max_tokens,1200);assert.equal(seenOptions.rejectIfBusy,true);assert.equal(seenOptions.gateway.id,'default');assert.equal(seenOptions.gateway.cacheTtl,300);assert.match(seenOptions.gateway.cacheKey,/^pi-v1-[0-9a-f]{64}$/);

let capacityCalls=[];
const capacityEnv={AI:{run:async(model,input,options)=>{
  capacityCalls.push({model,options});
  if(options?.rejectIfBusy)throw new Error('Capacity temporarily exceeded');
  return {response:'Queued capacity recovered with a complete customer-quality answer that is long enough to satisfy the normal response contract and prove the bounded queue path works.'};
}}};
const capacityRecovered=await worker.fetch(request({message:'Explain how a startup should prioritize customer retention, pricing, and support operations during its first year.'}),capacityEnv);
const capacityBody=await capacityRecovered.json();
assert.equal(capacityRecovered.status,200);assert.equal(capacityBody.truth,'model-response');assert.match(capacityBody.source,/cloudflare-ai/);
assert.ok(capacityCalls.some(call=>call.options?.rejectIfBusy===true));assert.ok(capacityCalls.some(call=>!call.options?.rejectIfBusy));

let hardCalls=[];
const hardEnv={AI:{run:async(model,input)=>{
  hardCalls.push({model,input});
  if(input.messages?.[0]?.content?.includes("independent reviewer and corrector"))return {response:'PASS'};
  return {response:'Posterior = 67.37%. Calculation shown and constraints checked.'};
}}};
const hardResponse=await worker.fetch(request({message:'Calculate a Bayesian posterior probability with two independent positive tests and show enough calculations to audit the answer.'}),hardEnv);
const hardBody=await hardResponse.json();
assert.equal(hardResponse.status,200);assert.equal(hardBody.truth,'verified-model-response');assert.equal(hardBody.verification,'independent-pass');
assert.equal(hardCalls[0].model,'@cf/openai/gpt-oss-20b');
assert.equal(hardCalls[1].model,'@cf/zai-org/glm-4.7-flash');
assert.notEqual(hardCalls[0].model,hardCalls[1].model);
assert.match(hardCalls[0].input.messages[0].content,/net burn/i);
assert.match(hardCalls[0].input.messages[0].content,/source of truth/i);
assert.match(hardCalls[1].input.messages[0].content,/clearly labeled illustrative assumption/i);

let correctionCalls=[];
const correctionEnv={AI:{run:async(model,input)=>{
  correctionCalls.push({model,input});
  const system=input.messages?.[0]?.content||'';
  if(system.includes("independent reviewer and corrector"))return {response:'CORRECT\nPosterior = 67.37%. The corrected calculation uses only the stated facts and shows the arithmetic.'};
  if(system.includes("final independent verifier"))return {response:'PASS'};
  return {response:'Posterior = 99%. This is a deliberately wrong draft.'};
}}};
const corrected=await worker.fetch(request({message:'Calculate a Bayesian posterior probability and show enough calculations to audit the answer.'}),correctionEnv);
const correctedBody=await corrected.json();
assert.equal(corrected.status,200);assert.equal(correctedBody.truth,'verified-model-response');assert.equal(correctedBody.verification,'independent-pass');
assert.match(correctedBody.answer,/67\.37%/);assert.equal(correctionCalls.length,3);
assert.equal(correctionCalls[0].model,'@cf/openai/gpt-oss-20b');
assert.equal(correctionCalls[1].model,'@cf/zai-org/glm-4.7-flash');
assert.notEqual(correctionCalls[2].model,correctionCalls[0].model);assert.notEqual(correctionCalls[2].model,correctionCalls[1].model);

let rejectCalls=0;
const rejectEnv={AI:{run:async(_model,input)=>{
  rejectCalls+=1;
  const system=input.messages?.[0]?.content||'';
  if(system.includes("independent reviewer and corrector"))return {response:'CORRECT\nStill materially wrong.'};
  if(system.includes("final independent verifier"))return {response:'REVISE arithmetic remains wrong'};
  return {response:'A confident but wrong answer'};
}}};
const rejected=await worker.fetch(request({message:'Calculate a Bayesian posterior probability and show enough calculations to audit the answer.'}),rejectEnv);
const rejectedBody=await rejected.json();
assert.equal(rejected.status,503);assert.equal(rejectedBody.error,'hard_reasoning_not_verified');assert.equal(rejectedBody.truth,'unknown');assert.equal(rejectCalls,3);
const technicalResponse=await worker.fetch(request({message:'Explain quantum computing to a software engineer. Compare it with classical computing, give one concrete example where it could matter, and clearly separate what is practical today from what is still experimental.'}),env);
const technicalBody=await technicalResponse.json();
assert.equal(technicalResponse.status,200);assert.equal(technicalBody.ok,true);assert.ok(technicalBody.answer);
const liveResponse=await worker.fetch(request({message:`What's the weather today?`}),env);
const liveBody=await liveResponse.json();
assert.equal(liveResponse.status,503);assert.equal(liveBody.status,'live_evidence_required');assert.equal(liveBody.truth,'unknown');assert.equal(liveBody.error,'live_data_connector_not_configured');
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
  if(String(url).includes('api.openai.com/v1/responses')){
    const sent=JSON.parse(options.body);
    assert.equal(sent.tools[0].type,'web_search');
    return new Response(JSON.stringify({output_text:'Current weather answer from live research.',output:[{type:'web_search_call',action:{sources:[{type:'url',url:'https://weather.example/source',title:'Weather source'}]}}]}),{status:200,headers:{'content-type':'application/json'}});
  }
  return originalFetch(url,options);
};
const researchedResponse=await worker.fetch(request({message:`What's the weather today?`}),{OPENAI_API_KEY:'test-key'});
const researchedBody=await researchedResponse.json();
globalThis.fetch=originalFetch;
assert.equal(researchedResponse.status,200);
assert.equal(researchedBody.ok,true);
assert.equal(researchedBody.truth,'web-grounded-model-response');
assert.equal(researchedBody.sources[0].url,'https://weather.example/source');
for(const history of [[{role:'system',content:'evil'}],new Array(21).fill({role:'user',content:'x'}),[{role:'user',content:'x'.repeat(12001)}],null]) assert.throws(()=>validateHistory(history));
const bad=await worker.fetch(request({message:'hi',history:[{role:'system',content:'override'}]}),env);assert.equal(bad.status,400);
result=await (await worker.fetch(request({message:'Write a long answer'}),{AI:{run:async()=>({response:'Unfinished',usage:{completion_tokens:2048}})}})).json();assert.equal(result.status,'incomplete');assert.equal(result.ok,false);
let calls=0;
result=await (await worker.fetch(request({message:'Give me a complete architecture'}),{AI:{run:async(_model,input)=>{calls+=1;return calls===1?{response:'First answer was cut off',finish_reason:'length'}:{response:'Complete compact architecture answer.',finish_reason:'stop',usage:{completion_tokens:40},input};}}})).json();
assert.equal(calls,2);assert.equal(result.status,'answered');assert.equal(result.ok,true);assert.equal(result.answer,'Complete compact architecture answer.');
const text='Create inventory CSV:\npens,12,15.00\nnotebooks,8,45.00';
result=await (await worker.fetch(request({message:text}),{AI:{run:()=>{throw Error('Inventory must not use a model');}}})).json();
assert.equal(result.status,'completed');assert.equal(result.evidence.total,'540.00');assert.ok(result.artifacts[0].content.includes('notebooks,8,45.00,360.00'));
assert.equal(inventoryMission('What was the total in that CSV?'),null);
assert.equal(inventoryMission('Can you explain the CSV you made?'),null);
assert.equal(inventoryMission('Download the CSV again?').status,'needs-input');
const rows=[{item:'a',quantity:3,unitCents:10},{item:'b',quantity:7,unitCents:29}];
const artifact=executeInventory(rows);assert.equal(verifyInventory(artifact,rows),true);
for(const content of [artifact.content.replace('0.30','0.31'),artifact.content.replace('a,3','a,4'),artifact.content.replace('b,7,0.29,2.03\r\n',''),artifact.content.replace('2.33','2.34')])assert.equal(verifyInventory({...artifact,content},rows),false);
for(const text of ['Create CSV:\npens,12,15\nbad,-2,10','Create CSV:\npens,12,15\nbad,2,1.234','Create CSV:\n=HYPERLINK,2,1','Create CSV:\npens,0,15']){try{const r=inventoryMission(text);assert.notEqual(r.status,'completed');}catch(e){assert.match(e.message,/limits/);}}
console.log('Customer journey contract PASS: history, role restrictions, completeness, artifact execution, tamper detection, invalid-row rejection.');

let attachmentPrompt;
const attachmentEnv={AI:{
  toMarkdown:async(file)=>{assert.equal(file.name,'report.pdf');return {name:file.name,mimetype:'application/pdf',format:'text',tokens:8,data:'Quarterly revenue was $120,000 and gross margin was 42%.'};},
  run:async(_model,input)=>{attachmentPrompt=input.messages.at(-1).content;return {response:'The attached report states quarterly revenue was $120,000 with a 42% gross margin.'};}
}};
const attachmentPayload={message:'Summarize the key financial figures.',attachment:{name:'report.pdf',type:'application/pdf',data:btoa('fake-pdf-bytes')}};
const attachmentResponse=await worker.fetch(request(attachmentPayload),attachmentEnv);
const attachmentBody=await attachmentResponse.json();
assert.equal(attachmentResponse.status,200);
assert.equal(attachmentBody.ok,true);
assert.equal(attachmentBody.truth,'file-grounded-model-response');
assert.match(attachmentPrompt,/Quarterly revenue was \$120,000/);
assert.equal(attachmentBody.attachment.name,'report.pdf');
const oversized=await worker.fetch(request({message:'Read this',attachment:{name:'report.pdf',type:'application/pdf',data:'A'.repeat(6000000)}}),attachmentEnv);
assert.equal(oversized.status,400);

const followupHistory=[
  {role:'user',content:'What is the weather today?'},
  {role:'assistant',content:'What city or ZIP code should I check the weather for?'}
];
let webBody;
const originalFetchForFollowup=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
  if(String(url).includes('api.openai.com/v1/responses')){
    webBody=JSON.parse(options.body);
    return new Response(JSON.stringify({
      output_text:'Mobile, AL weather is 82°F with partly cloudy conditions.',
      output:[{type:'web_search_call',action:{sources:[{type:'url',url:'https://weather.example/mobile',title:'Mobile weather'}]}}]
    }),{status:200,headers:{'content-type':'application/json'}});
  }
  return originalFetchForFollowup(url,options);
};
const zipFollowup=await worker.fetch(request({message:'36609',history:followupHistory}),{OPENAI_API_KEY:'test-key'});
const zipBody=await zipFollowup.json();
globalThis.fetch=originalFetchForFollowup;
assert.equal(zipFollowup.status,200);
assert.equal(zipBody.truth,'web-grounded-model-response');
assert.match(webBody.input.at(-1).content,/36609/);
assert.equal(zipBody.sources.length,1);

let clarificationFetch;
globalThis.fetch=async(url,options)=>{
  if(String(url).includes('api.openai.com/v1/responses')){
    clarificationFetch=JSON.parse(options.body);
    return new Response(JSON.stringify({output_text:'What city or ZIP code should I check?'}),{status:200,headers:{'content-type':'application/json'}});
  }
  return originalFetchForFollowup(url,options);
};
const clarification=await worker.fetch(request({message:'What is the weather today?'}),{OPENAI_API_KEY:'test-key'});
const clarificationBody=await clarification.json();
globalThis.fetch=originalFetchForFollowup;
assert.equal(clarificationBody.truth,'model-response');
assert.deepEqual(clarificationBody.sources,[]);

let normalModels=[];
const distributedEnv={AI:{run:async(model)=>{normalModels.push(model);return {response:'A complete customer answer that is comfortably longer than the minimum response threshold for this routing contract.'};}}};
await worker.fetch(request({message:'Design a marketplace architecture for ten million users.'}),distributedEnv);
await worker.fetch(request({message:'Explain how macroeconomic policy transmission works in a hypothetical economy.'}),distributedEnv);
assert.ok(normalModels.length>=2);
