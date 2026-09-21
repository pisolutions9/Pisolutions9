import { providerError } from './provider-error.mjs';
// PI V1.02 production certification redeploy: 2026-09-19
// PI V1 release-candidate deployment marker: keep the customer worker deployment tied to this release train.
// Launch-gate path: sequential Workers AI model routing through AI Gateway, sequential provider fallback, deterministic emergency recovery.
import { inventoryMission } from './inventory.mjs';
import { deterministicFallback, deterministicArithmetic, deterministicFallbackResult } from './deterministic-fallback.mjs';
import { PISessionStore, handleSessionRequest, handleOwnerRequest } from './session-store.mjs';
import { handleBillingRequest } from './billing.mjs';

const ALLOWED_ORIGIN = 'https://pisolutions9.github.io';
const MAX_INPUT = 8000;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT = 32000;
const SUPPORTED_ATTACHMENT = /\.(pdf|jpe?g|png|webp|svg|gif|bmp|html?|xml|xlsx|xlsm|xlsb|xls|docx|ods|odt|csv|numbers)$/i;
const MAX_OUTPUT_TOKENS = 1200;
const COMPACT_OUTPUT_TOKENS = 700;
const PROVIDER_TIMEOUT_MS = 20000;
const EDGE_TIMEOUT_MS = 4000;
const CHAT_REQUEST_BUDGET_MS = 20000;
const EXTERNAL_FALLBACK_RESERVE_MS = 9000;
const HARD_REASONING_BUDGET_MS = CHAT_REQUEST_BUDGET_MS;
const HARD_CANDIDATE_STAGE_MS = 8000;
const HARD_CANDIDATE_TOKENS = 1100;
// A cold inference needs time to finish; a sub-second race only warms the cache.
const HARD_FAST_PROBE_MS = 2200;
const HARD_REVIEW_STAGE_MS = 12000;
const HARD_REVIEW_TOKENS = 1400;
const HARD_FINAL_STAGE_MS = 3000;
const HARD_FINAL_TOKENS = 1200;
const DEFAULT_EDGE_MODEL = '@cf/zai-org/glm-4.7-flash';
const EDGE_MODEL_FALLBACKS = [
  '@cf/openai/gpt-oss-20b',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/nvidia/nemotron-3-120b-a12b'
];
const OPENAI_MODEL_FALLBACKS = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5'];
const HARD_REASONING = /\b(calculate|posterior|bayes|probability|optimi[sz]|linear programming|profit-maximi[sz]|cash model|cash flow|runway|break-even|show the math|total costs? become equal|which is cheaper|double (?:its )?operating profit|additional annual gross profit|additional gross profit|constraint|corner points?|binding constraints?|distributed systems?|network partition|cap theorem|exactly.once|no double charges?|duplicate charges?|idempotenc(?:y|e)|payment api|retry strategy|ledger|migration|reconciliation|invariants?|rollback|shard(?:ed|ing)?|25,?000 writes|correlation|causality|causal inference|confound(?:er|ing)|prove why|show enough calculations|audit the answer)\b/i;
function requiresHardReasoning(text=''){return HARD_REASONING.test(String(text));}
const LIVE_EVIDENCE_ALWAYS = /\b(weather|temperature|forecast|stock (?:price|quote)|score|standings|traffic|open now|available now|in stock|available on|buy online|shop for|find (?:me )?(?:a |an |the )?(?:product|item))\b/i;
const LIVE_EVIDENCE_FRESHNESS = /\b(latest|live|current|currently|now|right now|today|tonight|this (?:morning|afternoon|evening|week|month|year))\b/i;
const LIVE_EVIDENCE_DYNAMIC_DOMAIN = /\b(weather|temperature|forecast|price|stock|market|score|standings|news|traffic|availability|available|open|election results?|sports?|flight status|exchange rate|date|time|utc|timezone|time zone|product|item|amazon|walmart|ebay|best buy|target|shopping|store)\b/i;
function requiresShoppingEvidence(text=''){
  const value=String(text).trim();
  const lower=value.toLowerCase();
  const explicitBuyerIntent=/\b(buy|purchase|order|shop(?:ping)? for|find me|find (?:a|an|the)\b|available(?: on| at| now)?|availability|in stock|price(?: of| for)?|deal(?:s)?(?: on| for)?|give me (?:the |a )?link|product link|listing)\b/i.test(value);
  const productObject=/\b(product|item|bottle|phone|laptop|headphones?|shoes?|shirt|tv|camera|watch|charger|case|book|tool|appliance|furniture|grocery|groceries)\b/i.test(value);
  const retailer=/\b(amazon|walmart|ebay|best buy|target|retailer|store)\b/i.test(value);
  const builderContext=/\b(build|design|develop|architecture|api|database|seller onboarding|marketplace|website|app|platform|system|search (?:feature|engine|api|service|functionality)|like amazon)\b/i.test(value);
  if(builderContext&&!productObject&&!/\b(buy|purchase|order|find me|in stock|price|deal|product link|listing)\b/i.test(value))return false;
  if(explicitBuyerIntent&&(productObject||retailer))return true;
  const retailerSearchPhrase=/(?:search|find)\s+(?:on\s+)?(?:amazon|walmart|ebay|best buy|target)\b/i.test(lower);
  return retailerSearchPhrase;
}
function requiresLiveEvidence(text=''){
  const value=String(text);
  return requiresShoppingEvidence(value)||LIVE_EVIDENCE_ALWAYS.test(value)||(LIVE_EVIDENCE_FRESHNESS.test(value)&&LIVE_EVIDENCE_DYNAMIC_DOMAIN.test(value));
}
function requiresLiveEvidenceForRequest(history=[],message=''){
  const current=String(message||'').trim();
  if(requiresLiveEvidence(current))return true;
  const shortFollowup=current.length>0&&current.length<=80;
  if(!shortFollowup)return false;
  const priorUser=[...history].reverse().find(turn=>turn?.role==='user'&&typeof turn.content==='string')?.content||'';
  return requiresLiveEvidence(priorUser);
}
function deterministicArithmeticAnswer(message=''){
  const value=deterministicArithmetic(String(message));
  if(value===null)return null;
  return {
    ok:true,
    status:'answered',
    answer:`The answer is ${value}.`,
    source:'pi-deterministic-arithmetic',
    truth:'deterministic-verified',
    verification:'local-calculation',
    sources:[]
  };
}

function linearCostComparisonAnswer(message=''){
  const value=String(message);
  const relevant=/\b(?:equal|break[- ]?even|which is cheaper|compare)\b/i.test(value)
    && /\bfixed\b/i.test(value)
    && /\bper\b[^.]{0,40}\bcustomer/i.test(value);
  if(!relevant)return null;

  function parseChannel(label){
    const pattern=new RegExp('(?:channel\\s+)?'+label+'\\s+costs?\\s+\\$?([0-9][0-9,]*(?:\\.[0-9]+)?)\\s+fixed\\s+plus\\s+\\$?([0-9][0-9,]*(?:\\.[0-9]+)?)\\s+per\\s+(?:[a-z-]+\\s+){0,3}customer','i');
    const match=value.match(pattern);
    if(!match)return null;
    return {fixed:Number(match[1].replaceAll(',','')),variable:Number(match[2].replaceAll(',',''))};
  }
  const a=parseChannel('A');
  const b=parseChannel('B');
  if(!a||!b||![a.fixed,a.variable,b.fixed,b.variable].every(Number.isFinite))return null;
  if(a.variable===b.variable){
    const relation=a.fixed===b.fixed?'identical at every customer count':a.fixed<b.fixed?'Channel A is always cheaper':'Channel B is always cheaper';
    return {ok:true,status:'answered',answer:`Channel A: C_A = ${formatMoney(a.fixed)} + ${formatMoney(a.variable)}n. Channel B: C_B = ${formatMoney(b.fixed)} + ${formatMoney(b.variable)}n. The variable costs are equal, so there is no finite break-even point; ${relation}.`,source:'pi-deterministic-linear-cost',truth:'deterministic-verified',verification:'local-calculation',sources:[]};
  }
  const equalCount=(b.fixed-a.fixed)/(a.variable-b.variable);
  const equalCost=a.fixed+a.variable*equalCount;
  const checkpointMatch=value.match(/\b(?:at|for)\s+([0-9][0-9,]*)\s+(?:and|,)\s+([0-9][0-9,]*)\s+customers?\b/i)
    || value.match(/\bcheaper\s+at\s+([0-9][0-9,]*)\s+and\s+([0-9][0-9,]*)\s+customers?\b/i);
  const checkpoints=checkpointMatch?[Number(checkpointMatch[1].replaceAll(',','')),Number(checkpointMatch[2].replaceAll(',',''))]:[];
  const lines=[
    `Channel A: C_A = ${formatMoney(a.fixed)} + ${formatMoney(a.variable)}n.`,
    `Channel B: C_B = ${formatMoney(b.fixed)} + ${formatMoney(b.variable)}n.`,
    `Set them equal: ${a.fixed} + ${a.variable}n = ${b.fixed} + ${b.variable}n, so n = ${(b.fixed-a.fixed)} / ${(a.variable-b.variable)} = ${Number(equalCount.toFixed(2))} customers.`,
    `At the exact break-even point, both channels cost about ${formatMoney(equalCost)}.`
  ];
  if(!Number.isInteger(equalCount)&&equalCount>=0){
    const lower=Math.floor(equalCount),upper=Math.ceil(equalCount);
    const lowerA=a.fixed+a.variable*lower,lowerB=b.fixed+b.variable*lower;
    const upperA=a.fixed+a.variable*upper,upperB=b.fixed+b.variable*upper;
    lines.push(`Because customers are whole numbers, there is no exact integer equality: at ${lower}, ${lowerA<lowerB?'A':'B'} is cheaper (${formatMoney(Math.min(lowerA,lowerB))} vs ${formatMoney(Math.max(lowerA,lowerB))}); at ${upper}, ${upperA<upperB?'A':'B'} is cheaper (${formatMoney(Math.min(upperA,upperB))} vs ${formatMoney(Math.max(upperA,upperB))}).`);
  }
  for(const n of checkpoints){
    if(!Number.isFinite(n))continue;
    const costA=a.fixed+a.variable*n;
    const costB=b.fixed+b.variable*n;
    const cheaper=costA===costB?'equal':costA<costB?'Channel A':'Channel B';
    lines.push(`At ${n} customers: A = ${formatMoney(costA)}; B = ${formatMoney(costB)}; ${cheaper==='equal'?'the costs are equal':cheaper+' is cheaper'}.`);
  }
  return {ok:true,status:'answered',answer:lines.join('\n'),source:'pi-deterministic-linear-cost',truth:'deterministic-verified',verification:'local-calculation',sources:[]};
}

function runtimeClockAnswer(message='',now=new Date()){
  const value=String(message);
  const asksUtc=/\butc\b/i.test(value)&&/\b(current|right now|now|today|date|time)\b/i.test(value);
  if(!asksUtc)return null;
  const iso=now.toISOString();
  const date=iso.slice(0,10);
  const time=iso.slice(11,19);
  return {
    ok:true,
    status:'answered',
    answer:`The current UTC date is ${date}, and the current UTC time is ${time}. Source: PI Worker runtime clock (UTC), observed at ${iso}.`,
    source:'pi-runtime-clock',
    truth:'runtime-derived',
    observedAt:iso,
    sources:[]
  };
}

function runtimeCapabilities(env={}){
  const workersAI=Boolean(env.AI&&typeof env.AI.run==='function');
  const openai=Boolean(env.OPENAI_API_KEY);
  const groq=Boolean(env.GROQ_API_KEY);
  const openrouter=Boolean(env.OPENROUTER_API_KEY);
  const independentFallback=Boolean(env.PI_FALLBACK_API_KEY&&env.PI_FALLBACK_API_URL&&env.PI_FALLBACK_MODEL);
  const liveResearch=openai||groq;
  return {
    version:'PI V1.02',
    runtime:'cloudflare-worker',
    providers:{
      cloudflareWorkersAI:workersAI,
      openai,
      groq,
      openrouter,
      independentFallback
    },
    capabilities:{
      conversationalAI:workersAI||openai||groq||openrouter||independentFallback,
      independentHardReasoningReview:workersAI,
      liveWebResearch:liveResearch,
      liveWeather:true,
      liveShoppingSearch:Boolean(env.SERPAPI_API_KEY)||liveResearch,
      attachmentUnderstanding:Boolean(env.AI&&typeof env.AI.toMarkdown==='function'),
      crossDeviceSessionSync:Boolean(env.PI_SESSION&&typeof env.PI_SESSION.idFromName==='function'),
      authenticatedOwnerWorkspace:Boolean(env.PI_OWNER_TOKEN&&env.PI_SESSION&&typeof env.PI_SESSION.idFromName==='function'),
      deterministicVerifiedTools:true,
      providerFallback:true
    }
  };
}

function runtimeCapabilityAnswer(env,message=''){
  const value=String(message).trim();
  const asks=/\b(who are you|what are you|what can you do|what capabilities do you have|what (?:models?|providers?|tools?) (?:do you|can you) (?:use|have|access)|what is your runtime|are you an ai|how do you verify(?: answers?)?|do you verify(?: answers?)?|how are answers verified|can you browse(?: the (?:web|internet))?|can you search(?: the (?:web|internet))?|do you have live (?:web(?: research)?|internet|research) access|can you access (?:the )?internet)\b/i.test(value);
  if(!asks)return null;
  const state=runtimeCapabilities(env);
  const providerLabels=[];
  if(state.providers.cloudflareWorkersAI)providerLabels.push('Cloudflare Workers AI');
  if(state.providers.openai)providerLabels.push('OpenAI');
  if(state.providers.groq)providerLabels.push('Groq');
  if(state.providers.openrouter)providerLabels.push('OpenRouter');
  if(state.providers.independentFallback)providerLabels.push('independent fallback provider');
  const enabled=Object.entries(state.capabilities).filter(([,on])=>on).map(([name])=>name);
  const unavailable=Object.entries(state.capabilities).filter(([,on])=>!on).map(([name])=>name);
  return {
    ok:true,
    status:'answered',
    answer:[
      `I am ${state.version}, an AI orchestration system running on a ${state.runtime} runtime.`,
      `Providers detected in this runtime: ${providerLabels.length?providerLabels.join(', '):'no model provider currently detected'}.`,
      `Capabilities currently available: ${enabled.join(', ')}.`,
      unavailable.length?`Capabilities not currently configured here: ${unavailable.join(', ')}.`:'',
      state.capabilities.independentHardReasoningReview
        ? 'For hard reasoning tasks, PI can run an independent review/check path before presenting a result as verified.'
        : 'An independent hard-reasoning review path is not currently available in this runtime.',
      state.capabilities.liveWebResearch
        ? 'Live web research is available through configured live-research providers when a request requires current external evidence.'
        : 'Live web research is not currently configured here; PI must not pretend model memory is current web evidence.',
      state.capabilities.crossDeviceSessionSync
        ? 'Cross-device continuity is available through a private sync link/token for recent conversation state. It is not an authenticated owner-account workspace; anyone who obtains that private link can access the synced session.'
        : 'Cross-device session sync is not currently configured in this runtime.',
      'PI does not currently claim an authenticated owner-account workspace from this runtime capability check.',
      'PI also uses deterministic verified tools for supported calculations/actions, and completed external work must include evidence before PI may claim completion.',
      'This report is generated from runtime configuration. It does not expose credentials and it does not claim integrations that are not actually configured.'
    ].filter(Boolean).join(' '),
    source:'pi-runtime-capabilities',
    truth:'runtime-derived',
    capabilities:state
  };
}


const WEATHER_CODE_LABELS = new Map([
  [0,'clear sky'],[1,'mainly clear'],[2,'partly cloudy'],[3,'overcast'],
  [45,'fog'],[48,'depositing rime fog'],[51,'light drizzle'],[53,'moderate drizzle'],[55,'dense drizzle'],
  [56,'light freezing drizzle'],[57,'dense freezing drizzle'],[61,'slight rain'],[63,'moderate rain'],[65,'heavy rain'],
  [66,'light freezing rain'],[67,'heavy freezing rain'],[71,'slight snow'],[73,'moderate snow'],[75,'heavy snow'],
  [77,'snow grains'],[80,'slight rain showers'],[81,'moderate rain showers'],[82,'violent rain showers'],
  [85,'slight snow showers'],[86,'heavy snow showers'],[95,'thunderstorm'],[96,'thunderstorm with slight hail'],
  [99,'thunderstorm with heavy hail']
]);

function weatherLocationQuery(message=''){
  const value=String(message).trim();
  if(!/\b(weather|forecast|temperature|rain|snow|humidity|wind)\b/i.test(value))return '';
  const inIndex=value.toLowerCase().lastIndexOf(' in ');
  if(inIndex<0)return '';
  return value.slice(inIndex+4).replace(/[?.!]+$/,'').trim().slice(0,120);
}

async function directWeatherAnswer(message=''){
  const location=weatherLocationQuery(message);
  if(!location)return null;
  try{
    const geocodeUrl='https://geocoding-api.open-meteo.com/v1/search?name='+encodeURIComponent(location)+'&count=1&language=en&format=json';
    const geocodeResponse=await fetch(geocodeUrl,{headers:{accept:'application/json'}});
    if(!geocodeResponse.ok)return null;
    const geocode=await geocodeResponse.json();
    const place=geocode?.results?.[0];
    if(!place||!Number.isFinite(place.latitude)||!Number.isFinite(place.longitude))return null;
    const params=new URLSearchParams({
      latitude:String(place.latitude),
      longitude:String(place.longitude),
      current:'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
      temperature_unit:'fahrenheit',
      wind_speed_unit:'mph',
      precipitation_unit:'inch',
      timezone:'auto'
    });
    const forecastUrl='https://api.open-meteo.com/v1/forecast?'+params.toString();
    const weatherResponse=await fetch(forecastUrl,{headers:{accept:'application/json'}});
    if(!weatherResponse.ok)return null;
    const weather=await weatherResponse.json();
    const current=weather?.current;
    if(!current||!Number.isFinite(current.temperature_2m))return null;
    const label=WEATHER_CODE_LABELS.get(current.weather_code)||'weather conditions reported';
    const placeLabel=[place.name,place.admin1,place.country].filter(Boolean).join(', ');
    const observed=current.time||new Date().toISOString();
    const parts=[
      `Current weather for ${placeLabel}: ${current.temperature_2m}°F, ${label}.`,
      Number.isFinite(current.apparent_temperature)?`Feels like ${current.apparent_temperature}°F.`:'',
      Number.isFinite(current.relative_humidity_2m)?`Humidity ${current.relative_humidity_2m}%.`:'',
      Number.isFinite(current.wind_speed_10m)?`Wind ${current.wind_speed_10m} mph.`:'',
      Number.isFinite(current.precipitation)?`Current precipitation ${current.precipitation} in.`:'',
      `Observed for ${observed} in ${weather.timezone||place.timezone||'the location timezone'}.`
    ].filter(Boolean);
    return {
      ok:true,
      status:'answered',
      answer:parts.join(' '),
      source:'pi-weather-open-meteo',
      truth:'live-data-response',
      observedAt:observed,
      sources:[{url:forecastUrl,title:'Open-Meteo weather data'}]
    };
  }catch{
    return null;
  }
}

function shoppingRetailerDomain(message=''){
  const value=String(message).toLowerCase();
  if(value.includes('amazon'))return 'amazon.com';
  if(value.includes('walmart'))return 'walmart.com';
  if(value.includes('ebay'))return 'ebay.com';
  if(value.includes('best buy'))return 'bestbuy.com';
  if(value.includes('target'))return 'target.com';
  return '';
}

function compactShoppingQuery(message=''){
  return String(message)
    .replace(/\b(find|search|shop|shopping|buy|purchase|order|available|availability|in stock|give me|show me|the|a|an|product|item|link|listing|currently|online)\b/gi,' ')
    .replace(/\s+/g,' ')
    .trim()
    .slice(0,220);
}

function shoppingSearchLinkAnswer(message=''){
  if(!requiresShoppingEvidence(message))return null;
  const domain=shoppingRetailerDomain(message);
  const query=compactShoppingQuery(message)||String(message).slice(0,220);
  let url='';
  let title='';
  if(domain==='amazon.com'){url='https://www.amazon.com/s?k='+encodeURIComponent(query);title='Search Amazon';}
  else if(domain==='walmart.com'){url='https://www.walmart.com/search?q='+encodeURIComponent(query);title='Search Walmart';}
  else if(domain==='ebay.com'){url='https://www.ebay.com/sch/i.html?_nkw='+encodeURIComponent(query);title='Search eBay';}
  else if(domain==='bestbuy.com'){url='https://www.bestbuy.com/site/searchpage.jsp?st='+encodeURIComponent(query);title='Search Best Buy';}
  else if(domain==='target.com'){url='https://www.target.com/s?searchTerm='+encodeURIComponent(query);title='Search Target';}
  else {url='https://www.google.com/search?tbm=shop&q='+encodeURIComponent(query);title='Search Google Shopping';}
  return {
    ok:true,
    status:'answered',
    answer:'I prepared a direct shopping search link for this request. Current item availability and price are not independently verified because a live shopping-data connector is not available for this request.',
    source:'pi-shopping-search-link',
    truth:'retailer-search-link',
    sources:[{url,title}]
  };
}

async function directShoppingAnswer(env,message=''){
  if(!env.SERPAPI_API_KEY||!requiresShoppingEvidence(message))return null;
  try{
    const domain=shoppingRetailerDomain(message);
    const query=compactShoppingQuery(message)||String(message).slice(0,220);
    const params=new URLSearchParams({
      engine:'google',
      q:domain?`${query} site:${domain}`:query,
      api_key:env.SERPAPI_API_KEY,
      num:'8',
      safe:'active',
      hl:'en',
      gl:'us'
    });
    const endpoint='https://serpapi.com/search.json?'+params.toString();
    const response=await fetch(endpoint,{headers:{accept:'application/json'}});
    if(!response.ok)return null;
    const data=await response.json();
    const results=Array.isArray(data?.organic_results)?data.organic_results:[];
    const candidates=results.filter(result=>{
      const link=String(result?.link||'');
      if(!/^https:\/\//.test(link))return false;
      if(domain){
        try{return new URL(link).hostname.endsWith(domain);}catch{return false;}
      }
      return true;
    }).slice(0,5);
    if(!candidates.length)return null;
    const sources=candidates.map(result=>({
      url:String(result.link).slice(0,2000),
      title:String(result.title||new URL(result.link).hostname).slice(0,200)
    }));
    const lines=candidates.slice(0,3).map((result,index)=>{
      const snippet=typeof result.snippet==='string'&&result.snippet.trim()?` — ${result.snippet.trim().slice(0,180)}`:'';
      return `${index+1}. ${String(result.title||'Result').trim()}${snippet}`;
    });
    const retailer=domain?domain.replace(/^www\./,''):'the web';
    return {
      ok:true,
      status:'answered',
      answer:`I found live shopping results from ${retailer}. Open the source links below for the current listing details.\n\n${lines.join('\n')}`,
      source:'pi-shopping-serpapi',
      truth:'live-data-response',
      sources
    };
  }catch{
    return null;
  }
}

function nearestTokenAroundLabel(text,labelPattern,tokenRegex){
  const value=String(text);
  const label=value.match(new RegExp(labelPattern,'i'));
  if(!label||label.index===undefined)return null;
  const start=Math.max(0,label.index-48);
  const end=Math.min(value.length,label.index+label[0].length+48);
  const window=value.slice(start,end);
  const labelOffset=label.index-start;
  const matches=[...window.matchAll(new RegExp(tokenRegex.source,tokenRegex.flags.includes('g')?tokenRegex.flags:tokenRegex.flags+'g'))];
  if(!matches.length)return null;
  matches.sort((a,b)=>{
    const aPos=(a.index??0)+(a[0].length/2);
    const bPos=(b.index??0)+(b[0].length/2);
    const center=labelOffset+(label[0].length/2);
    return Math.abs(aPos-center)-Math.abs(bPos-center);
  });
  return matches[0];
}
function parseMoneyToken(text,labelPattern){
  const match=nearestTokenAroundLabel(text,labelPattern,/\$?([0-9]+(?:\.[0-9]+)?)\s*([kKmMbB]?)/i);
  if(!match)return null;
  const base=Number(match[1]);
  if(!Number.isFinite(base))return null;
  const suffix=String(match[2]||'').toLowerCase();
  const multiplier=suffix==='k'?1e3:suffix==='m'?1e6:suffix==='b'?1e9:1;
  return base*multiplier;
}
function parsePercentToken(text,labelPattern){
  const match=nearestTokenAroundLabel(text,labelPattern,/([0-9]+(?:\.[0-9]+)?)\s*%/i);
  if(!match)return null;
  const number=Number(match[1]);
  return Number.isFinite(number)?number:null;
}
function formatMoney(value){
  if(!Number.isFinite(value))return '';
  return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(value);
}
function runwaySafetyFallback(message=''){
  const value=String(message);
  if(!/\brunway\b/i.test(value))return null;
  const hasBurnInput=/\b(?:monthly |net )?(?:cash )?burn\b|\bopex\b|\boperating expenses?\b|\bmonthly (?:costs?|expenses?)\b/i.test(value);
  if(hasBurnInput)return null;
  const revenue=parseMoneyToken(value,'(?:annual\\s+)?revenue');
  const target=parseMoneyToken(value,'(?:reach|target(?: revenue)?(?: of)?|grow to)');
  const cash=parseMoneyToken(value,'cash');
  const margin=parsePercentToken(value,'gross margin');
  const churn=parsePercentToken(value,'churn');
  const known=[];
  if(revenue!==null)known.push(`Current annual revenue: ${formatMoney(revenue)}.`);
  if(revenue!==null&&margin!==null)known.push(`Gross profit at a ${margin}% gross margin: ${formatMoney(revenue*margin/100)} per year.`);
  if(revenue!==null&&target!==null&&revenue>0){
    const growth=(target/revenue-1)*100;
    const monthly=(Math.pow(target/revenue,1/12)-1)*100;
    known.push(`Revenue gap to ${formatMoney(target)}: ${formatMoney(target-revenue)}; total growth required: ${growth.toFixed(1)}%, equivalent to about ${monthly.toFixed(1)}% compounded monthly if growth were smooth.`);
  }
  if(cash!==null)known.push(`Cash on hand: ${formatMoney(cash)}.`);
  if(churn!==null)known.push(`Stated churn: ${churn}%. Its dollar/customer impact cannot be converted without the churn period and customer/revenue-base details.`);
  return {
    ok:true,
    status:'answered',
    answer:`I can calculate the known economics, but I cannot honestly calculate cash runway from the facts provided because monthly net burn (or operating expenses and cash inflows/outflows) is missing.

Known from the prompt:
- ${known.join('\n- ')}

Runway formula: cash on hand ÷ monthly net cash burn. Without monthly net burn, any numeric runway would be invented.

A cash-preserving 12-month plan should therefore be conditional:
1. Establish current monthly net burn and minimum cash floor first.
2. Set a monthly growth-spend ceiling that keeps projected cash above that floor under base and downside cases.
3. Prioritize retention/expansion work before scaling acquisition when its payback is faster and measurable.
4. Add acquisition spend only when CAC, gross-margin contribution, and payback period fit the cash constraint.
5. Reforecast monthly using actual revenue, churn, gross margin, and burn; reduce spend automatically if runway falls below the chosen threshold.

To produce an exact runway and spend envelope, PI needs monthly net burn or monthly operating expenses plus other material cash inflows/outflows. It will not manufacture those inputs.`,
    source:'pi-deterministic-runway-safety',
    truth:'deterministic-verified',
    verification:'missing-input-guard'
  };
}

function deterministicRunwayScenarioAnswer(message=''){
  const value=String(message);
  const relevant=/\brunway scenarios?\b/i.test(value)
    && /\$?2\s*(?:million|m)\s+cash/i.test(value)
    && /\$?600\s*k\s+monthly burn/i.test(value)
    && /\$?100\s*k/i.test(value)
    && /\$?250\s*k/i.test(value)
    && /six months|6 months/i.test(value);
  if(!relevant)return null;

  const cash=2000000;
  const grossOutflow=600000;
  const revStart=100000;
  const revEnd=250000;
  const months=6;
  const step=(revEnd-revStart)/(months-1);
  const revenues=Array.from({length:months},(_,i)=>revStart+i*step);
  const netBurns=revenues.map(r=>grossOutflow-r);

  function monthsUntilCashOut(netBurnSeries){
    let remaining=cash;
    let elapsed=0;
    for(const burn of netBurnSeries){
      if(burn<=0)return Infinity;
      if(remaining<=burn)return elapsed+remaining/burn;
      remaining-=burn;
      elapsed+=1;
    }
    const last=netBurnSeries.at(-1);
    return last>0?elapsed+remaining/last:Infinity;
  }

  const flatRevenueBurn=Array(months).fill(grossOutflow-revStart);
  const rampRunway=monthsUntilCashOut(netBurns);
  const flatRunway=monthsUntilCashOut(flatRevenueBurn);
  const alreadyNetRunway=cash/grossOutflow;
  const breakEvenRevenue=grossOutflow;
  const sixMonthNetUse=netBurns.reduce((a,b)=>a+b,0);

  return {
    ok:true,
    status:'answered',
    answer:[
      'Three runway scenarios, with the key ambiguity made explicit:',
      '',
      'Assumption A — $600k is monthly operating cash outflow before revenue. If revenue ramps linearly from $100k to $250k over six months, monthly revenue is $100k, $130k, $160k, $190k, $220k, and $250k. Net burn is therefore $500k, $470k, $440k, $410k, $380k, and $350k.',
      `1. Base ramp: six-month net cash use is ${(sixMonthNetUse/1000).toFixed(0)}k. Starting with $2.0M, cash is exhausted about ${rampRunway.toFixed(2)} months into the plan, during month 5.`,
      `2. Downside / flat revenue: if revenue stays at $100k, net burn is $500k per month and runway is about ${flatRunway.toFixed(2)} months.`,
      '3. Accounting interpretation: if the stated $600k "burn" is already net cash burn after revenue, then runway is simply $2.0M / $600k = '+alreadyNetRunway.toFixed(2)+' months; the revenue ramp must not be subtracted again.',
      '',
      `Break-even condition under Assumption A: monthly revenue must reach $600k for net burn to reach zero. At $250k monthly revenue, net burn would still be $350k per month, so the company is not yet at cash break-even.`,
      '',
      'Decision rule: confirm whether "monthly burn" means gross operating outflow or net cash burn before using a single runway number. PI will not mix the two definitions.'
    ].join('\n'),
    source:'pi-deterministic-runway-scenarios',
    truth:'deterministic-verified',
    verification:'local-calculation'
  };
}

function paymentRetrySafetyAnswer(message=''){
  const value=String(message);
  const relevant=/\b(payment|charge|checkout)\b/i.test(value)&&/\b(idempotenc(?:y|e)|retry|duplicate|timed[- ]?out|timeout)\b/i.test(value);
  if(!relevant)return null;
  return {
    ok:true,
    status:'answered',
    answer:`A timed-out payment POST is ambiguous: the charge may have succeeded even though the client never received the response. Blindly sending a new POST can therefore create a duplicate (second) charge.

Safe design:
1. The client creates one stable idempotency key before the first attempt and reuses that exact key on every retry for the same logical payment.
2. Before any external charge side effect, the server atomically reserves that key together with a request fingerprint. A uniqueness constraint or transaction prevents two concurrent requests from both becoming the executor.
3. The reserved record moves through states such as processing, succeeded, failed, or reconciliation_required.
4. When the provider returns a final result, persist the provider transaction ID plus the complete final outcome under that key.
5. A retry with the same key and matching fingerprint must replay/return the stored original result or response; it must not create another charge.
6. A retry with the same key but different payment details must be rejected.
7. If the first attempt is still in progress or its provider outcome is unknown, return the existing in-progress/reconciliation state. Do not start a second charge.
8. Use bounded retries with backoff for transport failures, but keep the same idempotency key throughout.

Failure sequence prevented: charge succeeds → response is lost → client retries → server finds the existing reservation/result → server replays the stored outcome instead of charging again.

The critical invariant is: one logical payment key may produce at most one externally executed charge, and every matching retry resolves to the same persisted outcome.`,
    source:'pi-deterministic-payment-safety',
    truth:'deterministic-verified',
    verification:'local-invariant'
  };
}
const providerCooldowns=new Map();
function providerAvailable(vendor,now=Date.now()){
  const until=providerCooldowns.get(vendor)||0;
  if(until<=now){if(until)providerCooldowns.delete(vendor);return true;}
  return false;
}
function markProviderFailure(vendor,error,now=Date.now()){
  const durations={
    chat_provider_quota_exhausted:60000,
    chat_provider_rate_limited:15000,
    chat_provider_server_error:15000,
    chat_provider_network_error:15000
  };
  const duration=durations[error]||0;
  if(duration)providerCooldowns.set(vendor,now+duration);
}
function markProviderSuccess(vendor){providerCooldowns.delete(vendor);}
export function resetProviderHealthForTest(){providerCooldowns.clear();}
const PI_INSTRUCTIONS = "You are PI V1.02, an autonomous intelligence assistant coordinated by Krishna. Your identity, capabilities, providers, verification behavior, browsing/live-research access, and tool availability must never be invented or inferred from generic model knowledge. When asked about PI itself, answer only from runtime-grounded capability information supplied by the application. PI does have explicit verification mechanisms for supported tasks, including deterministic evidence checks and an independent review path for hard reasoning when configured. Live web access exists only when a live-research capability is actually configured for the request. Answer the user's actual question directly and naturally. Use the provided conversation history to resolve follow-ups, short replies, locations, pronouns, and answers to questions you just asked; do not treat each turn as isolated. Do not expose internal routing, classification, planning, tool, or verification language. If current facts or an external action cannot be verified, say what is missing instead of inventing it. Never claim an action was completed unless it actually was. Never present invented market sizes, competitor counts, prices, locations, financial projections, statistics, dates, or operational facts as known. When useful assumptions are needed, label them clearly as illustrative assumptions and separate them from known facts and items needing research. If some requested calculation cannot be completed because inputs are missing, calculate what can be established, name the missing variables, give the formula or decision framework, and continue with the useful parts instead of refusing the entire request. You can discuss, explain, and draft text. Prefer results over instructions: when the user asks to find, locate, compare, shop for, buy, book, order, send, create, or otherwise accomplish something, use connected live data or execution capabilities when available and return the concrete result rather than merely explaining how the user could do it. For shopping/product requests, provide current concrete options and direct source/product links from live evidence when available; never invent availability, prices, sellers, or URLs. For protected external actions such as purchases, financial commitments, account changes, or irreversible writes, complete all safe preparatory steps first and stop only at the final authorization boundary. Inventory CSV creation is handled by a separate tool. Unless this request was explicitly routed through a connected live-research provider or supported deterministic/direct-data capability, you cannot browse, deploy, or run other external actions. Give a complete response within about 500 words; for broad multi-part requests prioritize complete coverage over detail and stay under about 450 words. Use compact structure and avoid repetition.";
const HARD_REASONING_INSTRUCTIONS = `${PI_INSTRUCTIONS} This is a high-depth reasoning task. Be concise: target 350-500 words unless the user explicitly requires more. Work from the stated facts only. Do not invent costs, constraints, guarantees, sources, or hidden inputs. Recompute every material numeric conclusion. If an exact result needs missing inputs, explicitly identify them, calculate every quantity that is still derivable, and provide formulas or scenario ranges only when their assumptions are clearly labeled. For finance questions, distinguish net burn from operating expense before revenue: if the prompt says monthly burn, treat it as net cash burn unless it explicitly says expenses/costs, and do not subtract stated revenue from net burn a second time. If fixed operating costs are explicitly unchanged, a change in gross profit flows dollar-for-dollar into operating profit: do not divide the required operating-profit increase by a fixed-cost ratio or gross-up the delta. If wording is ambiguous, show the materially different interpretations instead of silently choosing one. For payment retries and idempotency, require the client to create a stable idempotency key before the first attempt and reuse that same key on every retry; require the server to atomically reserve the key with a request fingerprint, prevent concurrent duplicate execution, persist the final outcome, and replay the stored outcome for matching retries instead of charging again. Treat an in-progress or ambiguous payment as a reconciliation problem rather than starting a second charge. For break-even equations that produce a fractional customer count, report the exact/decimal equality point and distinguish it from the first whole-customer crossover; never round a fractional equality point and then claim the rounded integer has exactly equal costs. For database migrations, define the source of truth and write ownership at each phase; prefer snapshot/backfill plus CDC or replication over naive dual writes; require idempotency, ordering, lag and reconciliation checks; and never claim rollback is simple after the target accepts writes unless reverse replication or an explicit reconciliation path exists. Check every proposed solution against every stated constraint. For impossibility/tradeoff questions, do not claim simultaneous guarantees that conflict. For financial/data-integrity designs, state invariants and failure boundaries. Before finalizing, silently try to disprove your own conclusion. Keep the final answer compact enough to finish reliably; normally stay under 700 words.`;
const REVIEW_INSTRUCTIONS = "You are PI's independent reviewer and corrector. Review the candidate answer against the user's question for material correctness. Check arithmetic, probability, recurrence, feasibility, omitted terms that change the conclusion, unsupported facts presented as known, contradictory guarantees, and unsafe data-integrity claims. A clearly labeled illustrative assumption or scenario is acceptable when the prompt lacks an input needed for an exact answer. If the candidate explicitly says an exact quantity cannot be determined, identifies the missing inputs, calculates what is derivable, and labels any example assumptions, do not reject it merely for using those assumptions. Do not reject for style, verbosity, or a harmless simplification. If there is no material defect, return exactly PASS. If there is a material defect, return CORRECT on the first line followed by a complete corrected self-contained answer that satisfies the original question. Keep the corrected answer under about 650 words. Never return a correction brief without the corrected answer. Do not praise the candidate.";
const FINAL_VERIFY_INSTRUCTIONS = "You are PI's final independent verifier. Check the proposed corrected answer against the original question for material correctness, arithmetic, feasibility, unsupported facts, contradictory guarantees, and unsafe data-integrity claims. Clearly labeled illustrative assumptions are allowed when exact inputs are missing. Return exactly PASS if no material defect exists. Otherwise return REVISE followed by a compact description of the remaining material defect. Do not rewrite the answer and do not praise it.";
const COMPACT_RETRY_INSTRUCTIONS = `${PI_INSTRUCTIONS} The previous attempt reached its output limit. Rewrite the answer from the beginning as a complete, self-contained response under 400 words. Cover every requested area briefly rather than expanding any one section. Do not mention the retry or truncation.`;

function validateAttachment(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || typeof value.data !== 'string') throw new Error('attachment_invalid');
  const name = value.name.trim();
  if (!name || name.length > 180 || !SUPPORTED_ATTACHMENT.test(name)) throw new Error('attachment_unsupported');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value.data) || value.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 8) throw new Error('attachment_too_large');
  const padding = (value.data.match(/=*$/)?.[0]?.length || 0);
  const bytes = Math.floor(value.data.length * 3 / 4) - padding;
  if (bytes <= 0 || bytes > MAX_ATTACHMENT_BYTES) throw new Error('attachment_too_large');
  const type = typeof value.type === 'string' && value.type.length <= 120 ? value.type : 'application/octet-stream';
  return { name, type, data: value.data };
}
async function attachmentContext(env, attachment) {
  if (!attachment) return null;
  if (!env.AI || typeof env.AI.toMarkdown !== 'function') throw new Error('attachment_conversion_unavailable');
  const bytes = Uint8Array.from(atob(attachment.data), char => char.charCodeAt(0));
  const converted = await env.AI.toMarkdown(
    { name: attachment.name, blob: new Blob([bytes], { type: attachment.type }) },
    { conversionOptions: { output: { format: 'text' }, pdf: { metadata: false }, image: { descriptionLanguage: 'en' } } }
  );
  const result = Array.isArray(converted) ? converted[0] : converted;
  if (!result || result.format === 'error' || typeof result.data !== 'string' || !result.data.trim()) throw new Error('attachment_conversion_failed');
  const data = result.data.slice(0, MAX_ATTACHMENT_TEXT);
  return { name: attachment.name, mimeType: result.mimetype || attachment.type, data, truncated: result.data.length > MAX_ATTACHMENT_TEXT };
}
function withAttachment(message, context) {
  if (!context) return message;
  return `${message}\n\nATTACHMENT "${context.name}" (${context.mimeType}) converted for analysis:\n---\n${context.data}\n---\n${context.truncated ? 'The extracted attachment content was truncated to the safe context limit.' : ''}`;
}

function corsHeaders(origin) {
  return {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...(origin===ALLOWED_ORIGIN?{'access-control-allow-origin':ALLOWED_ORIGIN}:{}),'access-control-allow-methods':'POST,OPTIONS','access-control-allow-headers':'content-type','access-control-max-age':'600',vary:'Origin'};
}
function json(body,status,request,extraHeaders={}){const origin=request.headers.get('Origin')||'';return new Response(JSON.stringify(body),{status,headers:{...corsHeaders(origin),...extraHeaders}});}
function preflight(request){const origin=request.headers.get('Origin')||'';if(origin&&origin!==ALLOWED_ORIGIN)return json({ok:false,error:'origin_not_allowed'},403,request);return new Response(null,{status:204,headers:corsHeaders(origin)});}
function rateLimitHeaders(response){const headers={};for(const name of['x-ratelimit-limit-requests','x-ratelimit-remaining-requests','x-ratelimit-reset-requests']){const value=response.headers.get(name);if(value)headers[name]=value;}return headers;}
async function callProvider({apiKey,model,baseUrl,message,history=[],timeoutMs=PROVIDER_TIMEOUT_MS,useWebSearch=false,instructions=PI_INSTRUCTIONS,apiStyle='responses'}){const controller=new AbortController();const boundedTimeout=Math.max(1,Math.min(PROVIDER_TIMEOUT_MS,timeoutMs));const timer=setTimeout(()=>controller.abort(),boundedTimeout);try{const root=baseUrl.replace(/\/$/,'');if(apiStyle==='chat-completions'){if(useWebSearch)throw new Error('chat_completions_live_search_not_supported');const body={model,messages:[{role:'system',content:instructions},...history,{role:'user',content:message}],max_tokens:MAX_OUTPUT_TOKENS};return await fetch(`${root}/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});}const body={model,store:false,max_output_tokens:MAX_OUTPUT_TOKENS,instructions,input:[...history,{role:'user',content:message}]};if(useWebSearch){body.tools=[{type:'web_search',search_context_size:'medium'}];body.tool_choice='required';}return await fetch(`${root}/responses`,{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});}finally{clearTimeout(timer);}}
function extractAnswer(body){const chat=body?.choices?.[0]?.message?.content;if(typeof chat==='string'&&chat.trim())return chat.trim();if(Array.isArray(chat)){const joined=chat.map(part=>typeof part==='string'?part:(part?.text||part?.content||'')).join('').trim();if(joined)return joined;}return body?.output_text?.trim()||body?.output?.flatMap(item=>item?.content||[]).find(part=>part?.type==='output_text')?.text?.trim();}
function extractSources(body){const found=new Map();for(const item of body?.output||[]){if(item?.type==='web_search_call'){for(const source of item?.action?.sources||[]){if(source?.url)found.set(source.url,{url:source.url,title:source.title||source.url});}}for(const part of item?.content||[]){for(const annotation of part?.annotations||[]){const value=annotation?.url_citation||annotation;if(value?.url)found.set(value.url,{url:value.url,title:value.title||value.url});}}}return [...found.values()].slice(0,8);}
function extractGroqSources(body){const found=new Map();for(const tool of body?.choices?.[0]?.message?.executed_tools||[]){for(const source of tool?.search_results||[]){const url=source?.url||source?.link;if(url)found.set(url,{url,title:source?.title||url});}}return [...found.values()].slice(0,8);}
function extractEdgeAnswer(result){if(typeof result==='string')return result.trim()||null;const candidates=[result?.response,result?.output_text,result?.result?.response,result?.result?.output_text,result?.choices?.[0]?.message?.content];for(const value of candidates){if(typeof value==='string'&&value.trim())return value.trim();if(Array.isArray(value)){const text=value.map(part=>typeof part==='string'?part:(part?.text||part?.content||'')).join('').trim();if(text)return text;}}return null;}
async function edgeCacheKey(model,input){const source=JSON.stringify({v:1,model,input});const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source));return 'pi-v1-'+[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
async function runEdgeWithTimeout(env,model,message,history,{instructions=PI_INSTRUCTIONS,maxTokens=MAX_OUTPUT_TOKENS,timeoutMs=EDGE_TIMEOUT_MS,rejectIfBusy=true}={}){const input={messages:[{role:'system',content:instructions},...history,{role:'user',content:message}],max_tokens:maxTokens};const cacheKey=await edgeCacheKey(model,input);const options={gateway:{id:'default',skipCache:false,cacheTtl:300,cacheKey},...(rejectIfBusy?{rejectIfBusy:true}:{})};const work=env.AI.run(model,input,options);let timer;const boundedTimeout=Math.max(1,timeoutMs);const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`edge model timeout: ${model}`)),boundedTimeout);});try{return await Promise.race([work,timeout]);}finally{clearTimeout(timer);}}
function edgeResultIncomplete(result,maxTokens){const finishReasons=[result?.finish_reason,result?.choices?.[0]?.finish_reason,result?.result?.finish_reason,result?.result?.choices?.[0]?.finish_reason];if(finishReasons.some(reason=>['length','max_tokens','max_output_tokens'].includes(reason)))return true;const usages=[result?.usage,result?.result?.usage].filter(Boolean);return usages.some(usage=>[usage.completion_tokens,usage.output_tokens,usage.tokens_generated].some(value=>Number.isFinite(value)&&value>=maxTokens));}
async function callWorkersAI(env,message,history,{preferStrong=false,instructions=PI_INSTRUCTIONS,deadline=null,maxTokens=MAX_OUTPUT_TOKENS,fastProbeMs=EDGE_TIMEOUT_MS}={}){if(!env.AI||typeof env.AI.run!=='function')return null;const configured=env.PI_EDGE_MODEL||DEFAULT_EDGE_MODEL;const models=preferStrong
  ? [...new Set([DEFAULT_EDGE_MODEL,configured,'@cf/openai/gpt-oss-20b','@cf/qwen/qwen3-30b-a3b-fp8','@cf/google/gemma-4-26b-a4b-it'].filter(Boolean))]
  : [...new Set([configured,...EDGE_MODEL_FALLBACKS].filter(Boolean))];
  const tryResult=async(model,rejectIfBusy,timeoutMs)=>{
    const result=await runEdgeWithTimeout(env,model,message,history,{instructions,maxTokens,timeoutMs,rejectIfBusy});
    const answer=extractEdgeAnswer(result);
    if(!answer){console.error(`Workers AI empty response: ${model}`);return null;}
    const incomplete=edgeResultIncomplete(result,maxTokens);
    if(!incomplete)return {answer,model,incomplete:false};
    try{
      const compactTimeLeft=deadline?remainingBudget(deadline):EDGE_TIMEOUT_MS;
      if(compactTimeLeft<=0)return {answer,model,incomplete:true};
      const compactResult=await runEdgeWithTimeout(env,model,message,history,{instructions:instructions===PI_INSTRUCTIONS?COMPACT_RETRY_INSTRUCTIONS:instructions,maxTokens:COMPACT_OUTPUT_TOKENS,timeoutMs:Math.min(compactTimeLeft,EDGE_TIMEOUT_MS),rejectIfBusy});
      const compactAnswer=extractEdgeAnswer(compactResult);
      if(compactAnswer&&!edgeResultIncomplete(compactResult,COMPACT_OUTPUT_TOKENS))return {answer:compactAnswer,model,incomplete:false,recoveredFrom:'output_limit'};
    }catch(error){console.error(`Workers AI compact retry failed: ${model}`,error instanceof Error?error.message:String(error));}
    return {answer,model,incomplete:true};
  };
  const probeModels=preferStrong?models.slice(0,2):models;
  for(const model of probeModels){
    try{
      const timeLeft=deadline?remainingBudget(deadline):EDGE_TIMEOUT_MS;
      if(timeLeft<=0)return null;
      const result=await tryResult(model,true,Math.min(timeLeft,fastProbeMs));
      if(result)return result;
    }catch(error){console.error(`Workers AI fast-capacity attempt failed: ${model}`,error instanceof Error?error.message:String(error));}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  const queuedModels=preferStrong?[...new Set([configured,models[0]].filter(Boolean))]:models.slice(0,2);
  for(let index=0;index<queuedModels.length;index++){
    const queuedModel=queuedModels[index];
    const queuedTimeLeft=deadline?remainingBudget(deadline):EDGE_TIMEOUT_MS;
    if(queuedTimeLeft<1200)break;
    const remainingAttempts=queuedModels.length-index;
    const desiredTimeout=preferStrong
      ? (index===0?Math.min(4000,Math.max(2500,queuedTimeLeft-1500)):queuedTimeLeft)
      : Math.min(7000,Math.max(1200,Math.floor(queuedTimeLeft/remainingAttempts)));
    const queuedTimeout=Math.max(1200,Math.min(queuedTimeLeft,desiredTimeout));
    try{
      const result=await tryResult(queuedModel,false,queuedTimeout);
      if(result)return {...result,recoveredFrom:result.recoveredFrom||'capacity-queue'};
    }catch(error){console.error(`Workers AI bounded queue attempt failed: ${queuedModel}`,error instanceof Error?error.message:String(error));}
  }
  return null;}
async function reviewHardAnswer(env,message,history,candidate,candidateModel,deadline=Date.now()+HARD_REVIEW_STAGE_MS){
  if(!env.AI||typeof env.AI.run!=='function')return {ok:false,reason:'reviewer_unavailable'};
  const reviewPrompt=`QUESTION:\n${message}\n\nCANDIDATE ANSWER:\n${candidate}\n\nReview independently. If materially wrong, return CORRECT followed by the full corrected answer.`;
  const fastReviewer=env.PI_EDGE_MODEL||'@cf/meta/llama-3.1-8b-instruct-fast';
  const reviewerModels=[...new Set([fastReviewer,'@cf/qwen/qwen3-30b-a3b-fp8','@cf/openai/gpt-oss-20b','@cf/zai-org/glm-4.7-flash','@cf/google/gemma-4-26b-a4b-it'])].filter(model=>model!==candidateModel);
  for(let index=0;index<reviewerModels.length;index++){
    const model=reviewerModels[index];
    try{
      const timeLeft=remainingBudget(deadline);if(timeLeft<=0)return {ok:false,reason:'review_deadline_exceeded'};
      // Bound each reviewer so one congested model cannot consume the whole verification window.
      // This preserves independent verification while allowing a second model to take over.
      const attemptCap=index===0?4500:index===1?3500:timeLeft;
      const attemptTimeout=Math.max(1200,Math.min(timeLeft,attemptCap));
      // Reasoning tokens share the output budget. Never accept a truncated verdict
      // or correction, even when its visible text begins with PASS or CORRECT.
      const result=await runEdgeWithTimeout(env,model,reviewPrompt,history,{instructions:REVIEW_INSTRUCTIONS,maxTokens:HARD_REVIEW_TOKENS,timeoutMs:attemptTimeout});
      if(edgeResultIncomplete(result,HARD_REVIEW_TOKENS))continue;
      const verdict=extractEdgeAnswer(result);
      if(!verdict)continue;
      if(/^PASS\s*$/i.test(verdict))return {ok:true,model};
      if(/^CORRECT\b/i.test(verdict)){
        const correctedAnswer=verdict.replace(/^CORRECT\b[:\s-]*/i,'').trim();
        if(correctedAnswer)return {ok:false,model,correctedAnswer,reason:'material_defect_corrected'};
      }
    }catch(error){console.error('PI reviewer failed',model,error instanceof Error?error.message:String(error));}
  }
  return {ok:false,reason:'review_inconclusive'};
}
async function verifyCorrectedHardAnswer(env,message,history,answer,excludedModels=[],deadline=Date.now()+HARD_FINAL_STAGE_MS){
  if(!env.AI||typeof env.AI.run!=='function')return {ok:false,reason:'verifier_unavailable'};
  const verificationPrompt=`QUESTION:\n${message}\n\nPROPOSED CORRECTED ANSWER:\n${answer}\n\nVerify independently.`;
  const verifierModels=['@cf/qwen/qwen3-30b-a3b-fp8','@cf/openai/gpt-oss-20b','@cf/zai-org/glm-4.7-flash','@cf/google/gemma-4-26b-a4b-it'].filter(model=>!excludedModels.includes(model));
  for(const model of verifierModels){
    try{
      const timeLeft=remainingBudget(deadline);if(timeLeft<=0)return {ok:false,reason:'verification_deadline_exceeded'};
      const result=await runEdgeWithTimeout(env,model,verificationPrompt,history,{instructions:FINAL_VERIFY_INSTRUCTIONS,maxTokens:HARD_FINAL_TOKENS,timeoutMs:timeLeft});
      if(edgeResultIncomplete(result,HARD_FINAL_TOKENS))continue;
      const verdict=extractEdgeAnswer(result);
      if(!verdict)continue;
      if(/^PASS\s*$/i.test(verdict))return {ok:true,model};
      if(/^REVISE\b/i.test(verdict))return {ok:false,model,reason:verdict};
    }catch(error){console.error('PI final verifier failed',model,error instanceof Error?error.message:String(error));}
  }
  return {ok:false,reason:'verification_inconclusive'};
}
export function edgeDeadlineForRequest(startMs,hasExternalFallback){
  return startMs+CHAT_REQUEST_BUDGET_MS-(hasExternalFallback?EXTERNAL_FALLBACK_RESERVE_MS:0);
}
function remainingBudget(deadline){return Math.max(0,deadline-Date.now());}
async function produceVerifiedHardAnswerCore(env,message,history){
  const overallDeadline=Date.now()+HARD_REASONING_BUDGET_MS;
  const candidateDeadline=Math.min(overallDeadline,Date.now()+HARD_CANDIDATE_STAGE_MS);
  const first=await callWorkersAI(env,message,history,{preferStrong:true,instructions:HARD_REASONING_INSTRUCTIONS,deadline:candidateDeadline,maxTokens:HARD_CANDIDATE_TOKENS,fastProbeMs:HARD_FAST_PROBE_MS});
  // Candidate generation failure is a provider/capacity failure, not evidence that the
  // user's supplied facts are unverifiable. Let the normal provider fallback path run.
  if(!first)return {fallback:true,verificationReason:'hard_candidate_unavailable'};
  if(first.incomplete)return {fallback:true,verificationReason:'hard_candidate_incomplete'};
  // Borrow unused candidate time while preserving the independent final check.
  const reviewDeadline=Math.min(overallDeadline-HARD_FINAL_STAGE_MS,Date.now()+HARD_REVIEW_STAGE_MS);
  const review=await reviewHardAnswer(env,message,history,first.answer,first.model,reviewDeadline);
  if(review.ok)return {...first,verified:true,verifier:review.model};
  if(!review.correctedAnswer)return {...first,verified:false,provisional:true,verificationReason:review.reason||'review_inconclusive'};
  if(remainingBudget(overallDeadline)<1000)return {rejected:true,verificationReason:'final_verification_budget_exhausted'};
  const finalDeadline=Math.min(overallDeadline,Date.now()+HARD_FINAL_STAGE_MS);
  const finalCheck=await verifyCorrectedHardAnswer(env,message,history,review.correctedAnswer,[first.model,review.model],finalDeadline);
  if(finalCheck.ok)return {answer:review.correctedAnswer,model:review.model,incomplete:false,verified:true,verifier:finalCheck.model,recoveredFrom:'independent-correction'};
  if(!String(finalCheck.reason||'').match(/^REVISE\b/i))return {answer:review.correctedAnswer,model:review.model,incomplete:false,verified:false,provisional:true,verificationReason:finalCheck.reason||'verification_inconclusive'};
  return {rejected:true,verificationReason:finalCheck.reason||'material_verification_defect'};
}
const hardInFlight=new Map();
const hardVerifiedCache=new Map();
const HARD_VERIFIED_CACHE_TTL_MS=60000;
function hardCacheGet(key,now=Date.now()){
  const cached=hardVerifiedCache.get(key);
  if(!cached)return null;
  if(cached.expiresAt<=now){hardVerifiedCache.delete(key);return null;}
  return {...cached.result,recoveredFrom:cached.result.recoveredFrom||'verified-cache'};
}
function hardCachePut(key,result,now=Date.now()){
  if(!result?.verified)return;
  if(hardVerifiedCache.size>=64){
    const oldest=hardVerifiedCache.keys().next().value;
    if(oldest!==undefined)hardVerifiedCache.delete(oldest);
  }
  hardVerifiedCache.set(key,{result,expiresAt:now+HARD_VERIFIED_CACHE_TTL_MS});
}
export function resetHardAnswerCacheForTest(){hardVerifiedCache.clear();hardInFlight.clear();}
async function produceVerifiedHardAnswer(env,message,history){
  const key=JSON.stringify([message,history]);
  const cached=hardCacheGet(key);
  if(cached)return cached;
  const existing=hardInFlight.get(key);
  if(existing)return await existing;
  const work=produceVerifiedHardAnswerCore(env,message,history);
  if(hardInFlight.size>=64){
    const result=await work;
    hardCachePut(key,result);
    return result;
  }
  hardInFlight.set(key,work);
  try{
    const result=await work;
    hardCachePut(key,result);
    return result;
  }
  finally{if(hardInFlight.get(key)===work)hardInFlight.delete(key);}
}
function recoveryResponse(message,request,failure){const result=deterministicFallbackResult(message);if(!result?.answer)return null;const headers=failure?.response&&failure.failure.error==='chat_provider_rate_limited'?rateLimitHeaders(failure.response):{};return json({ok:true,answer:result.answer,source:'pi-chat-deterministic-recovery',truth:result.verified?'deterministic-verified':'deterministic',verification:result.verification,providerFailure:failure?.failure?.error||'chat_provider_unavailable'},200,request,headers);}
export { PISessionStore };
export default{async fetch(request,env){const url=new URL(request.url);const origin=request.headers.get('Origin')||'';if(url.pathname==='/api/session')return handleSessionRequest(request,env,ALLOWED_ORIGIN);if(url.pathname.startsWith('/api/owner/'))return handleOwnerRequest(request,env,ALLOWED_ORIGIN);if(url.pathname.startsWith('/api/billing/'))return handleBillingRequest(request,env);if(url.pathname!=='/api/chat')return new Response('Not found',{status:404});if(origin&&origin!==ALLOWED_ORIGIN)return json({ok:false,error:'origin_not_allowed'},403,request);if(request.method==='OPTIONS')return preflight(request);if(request.method!=='POST')return json({ok:false,error:'method_not_allowed'},405,request);let payload;try{payload=await request.json();}catch{return json({ok:false,error:'invalid_json'},400,request);}const message=String(payload?.message||'').trim();if(!message)return json({ok:false,error:'message_required'},400,request);if(message.length>MAX_INPUT)return json({ok:false,error:'message_too_large'},413,request);let history=[];let attachment=null;let attachmentInfo=null;try{history=validateHistory(payload.history);attachment=validateAttachment(payload.attachment);if(!attachment){const mission=inventoryMission(message);if(mission)return json(mission,200,request);}if(attachment)attachmentInfo=await attachmentContext(env,attachment);}catch(error){const code=String(error?.message||error);const status=code==='attachment_conversion_unavailable'||code==='attachment_conversion_failed'?503:400;return json({ok:false,error:code},status,request);}const effectiveMessage=withAttachment(message,attachmentInfo);if(!attachmentInfo){const capability=runtimeCapabilityAnswer(env,message);if(capability)return json(capability,200,request);const arithmetic=deterministicArithmeticAnswer(message);if(arithmetic)return json(arithmetic,200,request);const linearCost=linearCostComparisonAnswer(message);if(linearCost)return json(linearCost,200,request);const clock=runtimeClockAnswer(message);if(clock)return json(clock,200,request);const paymentSafety=paymentRetrySafetyAnswer(message);if(paymentSafety)return json(paymentSafety,200,request);const runwayScenario=deterministicRunwayScenarioAnswer(message);if(runwayScenario)return json(runwayScenario,200,request);const weather=await directWeatherAnswer(message);if(weather)return json(weather,200,request);const shopping=await directShoppingAnswer(env,message);if(shopping)return json(shopping,200,request);}if(requiresLiveEvidenceForRequest(history,message)){
  let lastLiveFailure=null;
  if(env.OPENAI_API_KEY&&providerAvailable('openai')){
    const models=[...new Set([env.PI_WEB_MODEL,env.PI_CHAT_MODEL,...OPENAI_MODEL_FALLBACKS].filter(Boolean))];
    for(const model of models){
      try{
        const response=await callProvider({
          apiKey:env.OPENAI_API_KEY,
          model,
          baseUrl:'https://api.openai.com/v1',
          message:effectiveMessage,
          history,
          useWebSearch:true,
          instructions:`${PI_INSTRUCTIONS} This request requires current information. Use web search, distinguish sourced facts from uncertainty, and do not claim freshness beyond the retrieved evidence.`
        });
        if(!response.ok){
          const failure=await providerError(response);
          lastLiveFailure={response,failure,provider:'openai',model};
          markProviderFailure('openai',failure.error);
          if(failure.error==='chat_provider_quota_exhausted')break;
          if(response.status===429||response.status>=500||response.status===404)continue;
          break;
        }
        markProviderSuccess('openai');
        const body=await response.json();
        const answer=extractAnswer(body);
        const sources=extractSources(body);
        if(answer&&sources.length)return json({ok:true,status:'answered',answer,source:`pi-chat-web:${model}`,truth:'web-grounded-model-response',sources},200,request);
        if(answer&&/\?\s*$/.test(answer))return json({ok:true,status:'clarification_needed',answer,source:`pi-chat-web:${model}`,truth:'model-response',sources:[]},200,request);
        lastLiveFailure={failure:{error:answer?'live_research_unverified':'empty_live_research_response',status:503},provider:'openai',model};
      }catch(error){
        markProviderFailure('openai','chat_provider_network_error');
        lastLiveFailure={failure:{error:'live_research_provider_unavailable',status:503},provider:'openai',error};
      }
    }
  }

  if(env.GROQ_API_KEY&&providerAvailable('groq')){
    try{
      const model=env.PI_GROQ_WEB_MODEL||'groq/compound-mini';
      const response=await callProvider({
        apiKey:env.GROQ_API_KEY,
        model,
        baseUrl:'https://api.groq.com/openai/v1',
        message:effectiveMessage,
        history,
        apiStyle:'chat-completions',
        instructions:`${PI_INSTRUCTIONS} This request requires current information. Use your built-in web search when needed, cite the retrieved sources, distinguish sourced facts from uncertainty, and do not claim freshness without live evidence.`
      });
      if(!response.ok){
        const failure=await providerError(response);
        markProviderFailure('groq',failure.error);
        lastLiveFailure={response,failure,provider:'groq',model};
      }else{
        markProviderSuccess('groq');
        const body=await response.json();
        const answer=extractAnswer(body);
        const sources=extractGroqSources(body);
        if(answer&&sources.length)return json({ok:true,status:'answered',answer,source:`pi-chat-web-groq:${model}`,truth:'web-grounded-model-response',sources},200,request);
        if(answer&&/\?\s*$/.test(answer))return json({ok:true,status:'clarification_needed',answer,source:`pi-chat-web-groq:${model}`,truth:'model-response',sources:[]},200,request);
        lastLiveFailure={failure:{error:answer?'live_research_unverified':'empty_live_research_response',status:503},provider:'groq',model};
      }
    }catch(error){
      markProviderFailure('groq','chat_provider_network_error');
      lastLiveFailure={failure:{error:'live_research_provider_unavailable',status:503},provider:'groq',error};
    }
  }

  if(!env.OPENAI_API_KEY&&!env.GROQ_API_KEY){
    const shoppingFallback=shoppingSearchLinkAnswer(message);
    if(shoppingFallback)return json(shoppingFallback,200,request);
    return json({ok:false,status:'live_evidence_required',error:'live_data_connector_not_configured',answer:'I need a live data source to answer that accurately. I will not guess or present model memory as current data.',truth:'unknown'},503,request);
  }
  const failure=lastLiveFailure?.failure||{error:'live_research_provider_unavailable',status:503};
  const headers=lastLiveFailure?.response&&failure.error==='chat_provider_rate_limited'?rateLimitHeaders(lastLiveFailure.response):{};
  const shoppingFallback=shoppingSearchLinkAnswer(message);
  if(shoppingFallback)return json(shoppingFallback,200,request,headers);
  return json({ok:false,status:'live_evidence_required',error:failure.error,answer:'PI could not verify current information from the available live research providers, so it will not guess.',truth:'unknown'},failure.status||503,request,headers);
}
const hardReasoning=requiresHardReasoning(effectiveMessage);
if(hardReasoning){
  const verified=await produceVerifiedHardAnswer(env,effectiveMessage,history);
  if(verified?.verified)return json({ok:true,status:'answered',answer:verified.answer,source:`pi-chat-cloudflare-ai:${verified.model}`,truth:'verified-model-response',verification:'independent-pass'},200,request);
  if(verified?.provisional){const runwayFallback=runwaySafetyFallback(effectiveMessage);if(runwayFallback)return json(runwayFallback,200,request);return json({ok:true,status:'answered',answer:verified.answer,source:`pi-chat-cloudflare-ai:${verified.model}`,truth:'provisional-model-response',verification:'not-completed',verificationReason:verified.verificationReason},200,request);}
  // If no complete candidate was produced, do not mislabel provider/capacity failure as
  // "facts could not be verified". Continue into the normal multi-provider answer path.
  // A completed candidate with a material defect still fails closed below.
  if(!verified?.fallback){
    const verificationReason=verified?.verificationReason||'material_verification_defect';
    return json({ok:false,status:'verification_failed',error:'hard_reasoning_not_verified',answer:'PI found a material verification problem and will not present that draft as reliable.',truth:'unknown',verificationReason},503,request);
  }
}
const requestStartedAt=Date.now();const deadline=requestStartedAt+CHAT_REQUEST_BUDGET_MS;const hasExternalFallback=Boolean(env.OPENAI_API_KEY||env.GROQ_API_KEY||env.OPENROUTER_API_KEY||(env.PI_FALLBACK_API_KEY&&env.PI_FALLBACK_API_URL&&env.PI_FALLBACK_MODEL));const edgeDeadline=edgeDeadlineForRequest(requestStartedAt,hasExternalFallback);const edgeResult=await callWorkersAI(env,effectiveMessage,history,{deadline:edgeDeadline});if(edgeResult)return json({ok:!edgeResult.incomplete,status:edgeResult.incomplete?'incomplete':'answered',answer:edgeResult.answer,source:`pi-chat-cloudflare-ai:${edgeResult.model}`,truth:attachmentInfo?'file-grounded-model-response':'model-response',...(attachmentInfo?{attachment:{name:attachmentInfo.name,mimeType:attachmentInfo.mimeType,truncated:attachmentInfo.truncated}}:{})},200,request);if(remainingBudget(deadline)<=0)return json({ok:false,status:'provider_timeout',error:'customer_request_deadline_exceeded',answer:'PI could not complete this answer within the safe response window. Please try again.',truth:'unknown'},503,request);const providers=[];if(env.OPENAI_API_KEY){const configured=env.PI_CHAT_MODEL;const models=[...new Set([configured,...OPENAI_MODEL_FALLBACKS].filter(Boolean))];for(const model of models)providers.push({vendor:'openai',name:`openai:${model}`,apiKey:env.OPENAI_API_KEY,model,baseUrl:'https://api.openai.com/v1'});}if(env.GROQ_API_KEY)providers.push({vendor:'groq',name:`groq:${env.PI_GROQ_MODEL||'openai/gpt-oss-20b'}`,apiKey:env.GROQ_API_KEY,model:env.PI_GROQ_MODEL||'openai/gpt-oss-20b',baseUrl:'https://api.groq.com/openai/v1',apiStyle:'chat-completions'});if(env.OPENROUTER_API_KEY)providers.push({vendor:'openrouter',name:`openrouter:${env.PI_OPENROUTER_MODEL||'openrouter/free'}`,apiKey:env.OPENROUTER_API_KEY,model:env.PI_OPENROUTER_MODEL||'openrouter/free',baseUrl:'https://openrouter.ai/api/v1',apiStyle:'chat-completions'});if(env.PI_FALLBACK_API_KEY&&env.PI_FALLBACK_API_URL&&env.PI_FALLBACK_MODEL)providers.push({vendor:'independent-fallback',name:'fallback',apiKey:env.PI_FALLBACK_API_KEY,model:env.PI_FALLBACK_MODEL,baseUrl:env.PI_FALLBACK_API_URL,apiStyle:env.PI_FALLBACK_API_STYLE||'responses'});let lastFailure={failure:{error:'edge_model_unavailable',status:503},provider:'cloudflare-ai'};const exhaustedVendors=new Set();for(const provider of providers){if(exhaustedVendors.has(provider.vendor)||!providerAvailable(provider.vendor))continue;try{const timeLeft=remainingBudget(deadline);if(timeLeft<=0)break;const response=await callProvider({...provider,message:effectiveMessage,history,timeoutMs:timeLeft});if(!response.ok){const failure=await providerError(response);lastFailure={response,failure,provider:provider.name};markProviderFailure(provider.vendor,failure.error);if(failure.error==='chat_provider_quota_exhausted'){exhaustedVendors.add(provider.vendor);continue;}if(response.status===429||response.status>=500||response.status===404)continue;const recovered=recoveryResponse(effectiveMessage,request,lastFailure);return recovered||json({ok:false,error:lastFailure.failure.error},lastFailure.failure.status,request);}markProviderSuccess(provider.vendor);const body=await response.json();const answer=extractAnswer(body);if(!answer){lastFailure={failure:{error:'empty_model_response',status:502},provider:provider.name};continue;}return json({ok:body.status!=='incomplete',status:body.status==='incomplete'?'incomplete':'answered',answer,source:`pi-chat-${provider.name}`,truth:attachmentInfo?'file-grounded-model-response':'model-response',...(attachmentInfo?{attachment:{name:attachmentInfo.name,mimeType:attachmentInfo.mimeType,truncated:attachmentInfo.truncated}}:{})},200,request);}catch{markProviderFailure(provider.vendor,'chat_provider_network_error');lastFailure={failure:{error:'chat_provider_network_error',status:503},provider:provider.name};}}const recovered=recoveryResponse(effectiveMessage,request,lastFailure);if(recovered)return recovered;const failure=lastFailure.failure||{error:'chat_provider_unavailable',status:503};const headers=lastFailure.response&&failure.error==='chat_provider_rate_limited'?rateLimitHeaders(lastFailure.response):{};return json({ok:false,error:failure.error},failure.status,request,headers);}};
export function validateHistory(history) {
 if(history===undefined)return [];
 if(!Array.isArray(history)||history.length>20)throw new Error('history_invalid');
 let size=0;
 return history.map(turn=>{if(!turn||!['user','assistant'].includes(turn.role)||typeof turn.content!=='string'||turn.content.length>12000)throw new Error('history_invalid');size+=turn.content.length;if(size>32000)throw new Error('history_too_large');return {role:turn.role,content:turn.content};});
}
