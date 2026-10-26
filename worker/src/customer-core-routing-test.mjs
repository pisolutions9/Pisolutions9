import assert from 'node:assert/strict';
import worker from './index.js';

async function ask(message,history=[]){
  const request=new Request('https://pi-chat.example/api/chat',{
    method:'POST',
    headers:{'content-type':'application/json','origin':'https://pisolutions9.github.io'},
    body:JSON.stringify({message,history})
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

const staleHistory=[
  {role:'user',content:'cash is 900k. expenses 220k every month. revenue starts 80k month one and goes up 20k every month. after 4 months what is left?'},
  {role:'assistant',content:'Cash remaining after month 4: $460,000.'}
];
const weatherSwitch=await ask("what's the weather today",staleHistory);
assert.equal(weatherSwitch.status,200);
assert.equal(weatherSwitch.body.ok,true);
assert.equal(weatherSwitch.body.status,'clarification_needed');
assert.equal(weatherSwitch.body.source,'pi-weather-location-clarification');
assert.match(weatherSwitch.body.answer,/what location/i);
assert.doesNotMatch(weatherSwitch.body.answer,/month 1|cash remaining|460,000/i);

const teluguMath=await ask('29 mandi unnaru okkokadu 14 checks chesthe total enti?');
assert.equal(teluguMath.status,200);
assert.equal(teluguMath.body.source,'pi-deterministic-quantified-multiplication');
assert.equal(teluguMath.body.truth,'deterministic-verified');
assert.match(teluguMath.body.answer,/406/);

const datedMath=await ask('In 2026, 29 people each complete 14 checks. What is the total number of checks?');
assert.equal(datedMath.status,200);
assert.equal(datedMath.body.source,'pi-deterministic-quantified-multiplication');
assert.equal(datedMath.body.truth,'deterministic-verified');
assert.equal(datedMath.body.answer,'The total is 406.');
const ambiguousMath=await ask('29 people each complete 14 checks and 37 servers each handle 460 requests. What is the total?');
assert.notEqual(ambiguousMath.body.source,'pi-deterministic-quantified-multiplication');
assert.notEqual(ambiguousMath.body.truth,'deterministic-verified');
const bonusMath=await ask('In 2026, 29 people each complete 14 checks, plus 5 bonus checks. What is the total number of checks?');
assert.notEqual(bonusMath.body.source,'pi-deterministic-quantified-multiplication');
assert.notEqual(bonusMath.body.truth,'deterministic-verified');
const resetMath=await ask('postgres migration gurinchi vadiley. 37 servers each 460 req/sec total enta?');
assert.equal(resetMath.status,200);
assert.equal(resetMath.body.source,'pi-deterministic-quantified-multiplication');
assert.match(resetMath.body.answer,/17020/);
assert.doesNotMatch(resetMath.body.answer,/migration|postgres|database/i);

const teluguCash=await ask('month 3 nunchi spending 180k chey. recalc month 4',staleHistory);
assert.equal(teluguCash.status,200);
assert.equal(teluguCash.body.source,'pi-deterministic-cash-flow');
assert.match(teluguCash.body.answer,/Cash remaining after month 4: \$540,000/);
assert.match(teluguCash.body.answer,/Month 3: revenue \$120,000 - expenses \$180,000/);

const typoShopping=await ask('find 2 lapops under 700 available to buy online rn seller price link');
assert.equal(typoShopping.status,200);
assert.equal(typoShopping.body.source,'pi-shopping-search-link');
assert.equal(typoShopping.body.truth,'retailer-search-link');
assert.match(typoShopping.body.answer,/not independently verified/i);

const originalFetch=globalThis.fetch;
const currentNewsTime=new Date();
const recentPublished=new Date(currentNewsTime.getTime()-30*60*1000).toISOString();
const oldPublished=new Date(currentNewsTime.getTime()-3*24*60*60*1000).toISOString();
const newsItem=(number,publishedAt)=>({title:'Headline '+number,url:'https://example.com/news/'+number,source:'Example',publishedAt});
try{
  let cacheItems=[
    newsItem(1,oldPublished),
    newsItem(2,recentPublished),
    newsItem(3,recentPublished.replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')),
    newsItem(4,new Date(currentNewsTime.getTime()-45*60*1000).toUTCString())
  ];
  globalThis.fetch=async url=>{
    if(String(url).includes('/live-news.json'))return new Response(JSON.stringify({updatedAt:currentNewsTime.toISOString(),items:cacheItems}),{status:200});
    return new Response('unavailable',{status:503});
  };
  const freshNews=await ask('What are the latest world news developments today?');
  assert.equal(freshNews.body.source,'pi-news-live-cache');
  assert.equal(freshNews.body.truth,'live-data-response');
  assert.doesNotMatch(freshNews.body.answer,/Headline 1/);
  assert.match(freshNews.body.answer,/Headline 2/);
  assert.match(freshNews.body.answer,/Headline 3/);
  assert.match(freshNews.body.answer,/Headline 4/);
  cacheItems=[newsItem(1,oldPublished),newsItem(2,oldPublished),newsItem(3,oldPublished)];
  const staleNews=await ask('What are the latest world news developments today?');
  assert.notEqual(staleNews.body.source,'pi-news-live-cache');
  assert.notEqual(staleNews.body.truth,'live-data-response');
  const rssItem=(number,date)=>`<item><title>RSS headline ${number}</title><link>https://example.com/rss/${number}</link><pubDate>${date}</pubDate></item>`;
  let rss=`<rss><channel>${[1,2,3].map(number=>rssItem(number,new Date(currentNewsTime.getTime()-3*24*60*60*1000).toUTCString())).join('')}</channel></rss>`;
  globalThis.fetch=async url=>String(url).includes('bing.com/news/search')
    ?new Response(rss,{status:200})
    :new Response('unavailable',{status:503});
  const staleRss=await ask('What are the latest world news developments today?');
  assert.notEqual(staleRss.body.truth,'live-data-response','an old RSS feed must not be presented as current news');
  rss=`<rss><channel>${rssItem(1,new Date(currentNewsTime.getTime()-3*24*60*60*1000).toUTCString())}${[2,3,4].map(number=>rssItem(number,new Date(currentNewsTime.getTime()-30*60*1000).toUTCString())).join('')}</channel></rss>`;
  const mixedRss=await ask('What are the latest world news developments today?');
  assert.equal(mixedRss.body.source,'pi-news-bing-rss');
  assert.doesNotMatch(mixedRss.body.answer,/RSS headline 1/);
  assert.match(mixedRss.body.answer,/RSS headline 4/);
  const gdeltArticles=[1,2,3].map(number=>({title:'GDELT headline '+number,url:'https://example.com/gdelt/'+number,domain:'example.com',seendate:recentPublished.replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')}));
  globalThis.fetch=async url=>String(url).includes('api.gdeltproject.org')
    ?new Response(JSON.stringify({articles:gdeltArticles}),{status:200})
    :new Response('unavailable',{status:503});
  const observedNews=await ask('What are the latest world news developments today?');
  assert.equal(observedNews.body.source,'pi-news-gdelt');
  assert.match(observedNews.body.answer,/seen by GDELT/i);
  assert.doesNotMatch(observedNews.body.answer,/published:/i);
  const exactPublication=await ask('What are the latest world news developments today? Give exact publication time and source for every claim.');
  assert.notEqual(exactPublication.body.truth,'live-data-response','GDELT observation time does not prove exact publication time');
}finally{
  globalThis.fetch=originalFetch;
}
console.log('customer core routing regression: ok');
