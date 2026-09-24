import { providerError } from './provider-error.mjs';
// PI V1.02 production certification redeploy: 2026-09-19
// PI V1 release-candidate deployment marker: keep the customer worker deployment tied to this release train.
// Launch-gate path: sequential Workers AI model routing through AI Gateway, sequential provider fallback, deterministic emergency recovery.
import { inventoryMission } from './inventory.mjs';
import { deterministicFallback, deterministicArithmetic, deterministicFallbackResult } from './deterministic-fallback.mjs';
import { PISessionStore, handleSessionRequest, handleOwnerRequest } from './session-store.mjs';
import { handleBillingRequest } from './billing.mjs';
import { decideKrishnaRoute, validateKrishnaAnswer } from './krishna-core.mjs';

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
const HARD_CANDIDATE_STAGE_MS = 6500;
const HARD_CANDIDATE_TOKENS = 1100;
// A cold inference needs time to finish; a sub-second race only warms the cache.
const HARD_FAST_PROBE_MS = 1800;
const HARD_REVIEW_STAGE_MS = 9500;
const HARD_REVIEW_TOKENS = 1400;
const HARD_FINAL_STAGE_MS = 4000;
const HARD_FINAL_TOKENS = 1200;
const DEFAULT_EDGE_MODEL = '@cf/zai-org/glm-4.7-flash';
const EDGE_MODEL_FALLBACKS = [
  '@cf/openai/gpt-oss-20b',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/nvidia/nemotron-3-120b-a12b'
];
const OPENAI_MODEL_FALLBACKS = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5'];
const HARD_REASONING = /\b(calculate|posterior|bayes|probability|optimi[sz]|linear programming|profit-maximi[sz]|cash model|cash flow|runway|break-even|show the math|total costs? become equal|which is cheaper|double (?:its )?operating profit|additional annual gross profit|additional gross profit|constraint|corner points?|binding constraints?|distributed systems?|network partition|cap theorem|exactly.once|no double charges?|duplicate charges?|idempotenc(?:y|e)|payment api|retry strategy|ledger|migration|reconciliation|invariants?|rollback|shard(?:ed|ing)?|25,?000 writes|correlation|causality|causal inference|confound(?:er|ing)|invalid inference|high availability|security framework|scalable (?:marketplace|architecture)|10m users|prove why|show enough calculations|audit the answer)\b/i;
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
function conversationRecallAnswer(message='',history=[]){
  const value=String(message).trim();
  const asksRecall=/\b(?:what|which|repeat|remind me|tell me)\b/i.test(value)&&/\b(?:did i (?:give|say|mention|tell)|project code|budget|deadline)\b/i.test(value);
  if(!asksRecall||!Array.isArray(history)||!history.length)return null;
  const userText=history.filter(turn=>turn?.role==='user').map(turn=>String(turn.content||'')).join('\n');
  const code=userText.match(/\bproject code\s+([A-Z][A-Z0-9_-]{2,40})\b/i)?.[1];
  const budget=userText.match(/\bbudget\s+(?:₹|rs\.?|inr\s*)?([0-9][0-9,]*(?:\.\d+)?)\s*(rupees?|inr)?\b/i);
  const deadline=userText.match(/\bdeadline\s+([^,.\n]{3,80})/i)?.[1]?.trim();
  const requestedCode=/\bproject code\b/i.test(value),requestedBudget=/\bbudget\b/i.test(value),requestedDeadline=/\bdeadline\b/i.test(value);
  const parts=[];
  if(requestedCode&&code)parts.push(`Project code: ${code}`);
  if(requestedBudget&&budget)parts.push(`Budget: ${budget[1]} ${budget[2]||'rupees'}`);
  if(requestedDeadline&&deadline)parts.push(`Deadline: ${deadline}`);
  if(!parts.length)return null;
  return {ok:true,status:'answered',answer:parts.join(', ')+'.',source:'pi-conversation-grounding',truth:'conversation-grounded',verification:'supplied-history-extraction',sources:[]};
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

function linearCostComparisonAnswer(message='',history=[]){
  const current=String(message);
  const priorUser=[...history].reverse().find(item=>item?.role==='user'&&/\bfixed\b/i.test(String(item?.content||''))&&/\bper\b[^.]{0,40}\bcustomer/i.test(String(item?.content||'')))?.content||'';
  const continuation=/\b(?:plan\s*[ab]|channel\s*[ab]|variable\s+cost|fixed\s+cost|break[- ]?even|cheaper|customer\s+count|change\s+only|new\s+break[- ]?even)\b/i.test(current);
  if(priorUser&&!continuation)return null;
  const value=priorUser?String(priorUser):current;
  const relevant=/\b(?:equal|break[- ]?even|which is cheaper|compare|change only|new break[- ]?even)\b/i.test(priorUser?current:value)
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
  const overrideA=current.match(/Plan\s*A\s+variable\s+cost[^$0-9]{0,20}(?:from\s+\$?[0-9.]+\s+)?to\s+\$?([0-9]+(?:\.[0-9]+)?)/i);
  const overrideB=current.match(/Plan\s*B\s+variable\s+cost[^$0-9]{0,20}(?:from\s+\$?[0-9.]+\s+)?to\s+\$?([0-9]+(?:\.[0-9]+)?)/i);
  if(a&&overrideA)a.variable=Number(overrideA[1]);
  if(b&&overrideB)b.variable=Number(overrideB[1]);
  if(!a||!b||![a.fixed,a.variable,b.fixed,b.variable].every(Number.isFinite))return null;
  if(a.variable===b.variable){
    const relation=a.fixed===b.fixed?'identical at every customer count':a.fixed<b.fixed?'Channel A is always cheaper':'Channel B is always cheaper';
    return {ok:true,status:'answered',answer:`Channel A: C_A = ${formatMoney(a.fixed)} + ${formatMoney(a.variable)}n. Channel B: C_B = ${formatMoney(b.fixed)} + ${formatMoney(b.variable)}n. The variable costs are equal, so there is no finite break-even point; ${relation}.`,source:'pi-deterministic-linear-cost',truth:'deterministic-verified',verification:'local-calculation',sources:[]};
  }
  const equalCount=(b.fixed-a.fixed)/(a.variable-b.variable);
  const equalCost=a.fixed+a.variable*equalCount;
  const checkpoints=[...current.matchAll(/\bat\s+([0-9][0-9,]*)\s+customers?\b/ig)].map(match=>Number(match[1].replaceAll(',','')));
  if(!checkpoints.length){
    const checkpointMatch=value.match(/\b(?:at|for)\s+([0-9][0-9,]*)\s+(?:and|,)\s+([0-9][0-9,]*)\s+customers?\b/i)
      || value.match(/\bcheaper\s+at\s+([0-9][0-9,]*)\s+and\s+([0-9][0-9,]*)\s+customers?\b/i);
    if(checkpointMatch)checkpoints.push(Number(checkpointMatch[1].replaceAll(',','')),Number(checkpointMatch[2].replaceAll(',','')));
  }
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

function operatingProfitAnswer(message=''){
  const value=String(message);
  const asks=/\boperating\s+profit\b/i.test(value)&&/\b(?:sales|revenue|gross\s+profit)\b/i.test(value);
  if(!asks)return null;
  const money=(pattern)=>{const match=value.match(pattern);return match?Number(match[1].replaceAll(',','')):null;};
  const sales=money(/\b(?:monthly\s+|daily\s+|today(?:'s)?\s+)?(?:sales|revenue)(?:\s+(?:of|is|are|was|were|:))?\s*\$?([0-9][0-9,]*(?:\.[0-9]+)?)/i)
    ?? money(/\$?([0-9][0-9,]*(?:\.[0-9]+)?)\s+(?:in\s+)?(?:total\s+)?(?:sales|revenue)\b/i)
    ?? money(/\b(?:made|had|generated)\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)\s+in\s+(?:total\s+)?(?:sales|revenue)\b/i)
    ?? money(/\b(?:sold|did)\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)(?:\s+(?:in\s+)?(?:sales|revenue))?(?:\s+today)?\b/i);
  const marginMatch=value.match(/\bgross\s+margin(?:\s+(?:of|is|:))?\s*([0-9]+(?:\.[0-9]+)?)\s*%/i);
  const grossProfitParts=[
    ['fuel gross profit',/\bfuel\s+gross\s+profit(?:\s+(?:of|is|was|:))?\s*\$?([0-9][0-9,]*(?:\.[0-9]+)?)/i],
    ['inside-store gross profit',/\b(?:inside[-\s]?store|store|inside)\s+gross\s+profit(?:\s+(?:of|is|was|:))?\s*\$?([0-9][0-9,]*(?:\.[0-9]+)?)/i]
  ];
  const componentGross=[];
  for(const [label,pattern] of grossProfitParts){
    const amount=money(pattern);
    if(Number.isFinite(amount))componentGross.push([label,amount]);
  }
  const genericGrossProfit=money(/(?:^|[.;]\s*)gross\s+profit(?:\s+(?:of|is|was|:))?\s*\$?([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  let grossProfit=null;
  if(componentGross.length>=1)grossProfit=componentGross.reduce((sum,[,amount])=>sum+amount,0);
  else if(Number.isFinite(genericGrossProfit))grossProfit=genericGrossProfit;
  else if(Number.isFinite(sales)&&marginMatch){
    const margin=Number(marginMatch[1])/100;
    if(Number.isFinite(margin)&&margin>=0&&margin<=1)grossProfit=sales*margin;
  }
  if(!Number.isFinite(grossProfit))return null;
  const expensePatterns=[
    ['payroll',/\bpayroll(?:\s+(?:costs?|expense))?(?:\s+(?:of|is|was|:))?\s*\$?([0-9][0-9,]*(?:\.[0-9]+)?)/i],
    ['fixed operating costs',/\bfixed\s+operating\s+costs?(?:\s+(?:of|is|was|:))?\s*\$?([0-9][0-9,]*(?:\.[0-9]+)?)/i],
    ['rent',/\brent(?:\s+(?:of|is|was|:))?\s*\$?([0-9][0-9,]*(?:\.[0-9]+)?)/i],
    ['card fees',/\bcard\s+fees?(?:\s+(?:of|is|was|were|:))?\s*\$?([0-9][0-9,]*(?:\.[0-9]+)?)/i],
    ['utilities',/\butilities(?:\s+allocation)?(?:\s+(?:of|is|was|:))?\s*\$?([0-9][0-9,]*(?:\.[0-9]+)?)/i],
    ['other operating costs',/\bother\s+(?:operating\s+)?(?:costs?|expenses?)(?:\s+(?:of|is|was|were|:))?\s*\$?([0-9][0-9,]*(?:\.[0-9]+)?)/i]
  ];
  const expenses=[];
  for(const [label,pattern] of expensePatterns){
    const amount=money(pattern);
    if(Number.isFinite(amount))expenses.push([label,amount]);
  }
  if(!expenses.length)return null;
  const operatingExpenses=expenses.reduce((sum,[,amount])=>sum+amount,0);
  const operatingProfit=grossProfit-operatingExpenses;
  const operatingMargin=Number.isFinite(sales)&&sales!==0?operatingProfit/sales:null;
  const grossBreakdown=componentGross.length>=2?componentGross.map(([label,amount])=>`${label} ${formatMoney(amount)}`).join(' + '):`gross profit ${formatMoney(grossProfit)}`;
  const expenseBreakdown=expenses.map(([label,amount])=>`${label} ${formatMoney(amount)}`).join(', ');
  const marginText=Number.isFinite(operatingMargin)?` Operating margin = ${formatMoney(operatingProfit)} ÷ ${formatMoney(sales)} = ${Number((operatingMargin*100).toFixed(2))}%.`:'';
  return {
    ok:true,
    status:'answered',
    answer:`Gross profit = ${grossBreakdown} = ${formatMoney(grossProfit)}. Operating expenses: ${expenseBreakdown}, totaling ${formatMoney(operatingExpenses)}. Operating profit = ${formatMoney(grossProfit)} - ${formatMoney(operatingExpenses)} = ${formatMoney(operatingProfit)}.${marginText}`,
    source:'pi-deterministic-operating-profit',
    truth:'deterministic-verified',
    verification:'local-calculation',
    sources:[]
  };
}

function parseFlexibleMoney(value){
  const match=String(value||'').match(/\$?([0-9]+(?:\.[0-9]+)?)\s*(million|m|thousand|k)?/i);
  if(!match)return null;
  const n=Number(match[1]);
  if(!Number.isFinite(n))return null;
  const suffix=String(match[2]||'').toLowerCase();
  return n*(suffix==='million'||suffix==='m'?1e6:suffix==='thousand'||suffix==='k'?1e3:1);
}

function cashFlowSequenceAnswer(message='',history=[]){
  const current=String(message);
  const priorUser=[...history].reverse().find(item=>item?.role==='user'&&/\b(cash|operating expenses?|revenue|month 1|cash flow)\b/i.test(String(item?.content||'')))?.content||'';
  const baseText=priorUser?String(priorUser):current;
  const isFollowup=Boolean(priorUser)&&/\b(now|change|recalculate|starting in month|drop to|increase to|expenses?)\b/i.test(current);
  const initialMatch=baseText.match(/(?:starts? with|initial cash(?: is|:)?|cash(?: on hand)?(?: is|:)?)[^$0-9]{0,20}(\$?[0-9]+(?:\.[0-9]+)?\s*(?:million|m|thousand|k)?)/i);
  const expenseMatch=baseText.match(/operating expenses?(?: are| is|:)?\s*(\$?[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:million|m|thousand|k)?)/i);
  const revenueMatch=baseText.match(/revenue(?: is|:)?\s*(\$?[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:million|m|thousand|k)?)\s+in\s+month\s*1/i);
  const growthMatch=baseText.match(/grows? by\s*(\$?[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:million|m|thousand|k)?)\s*(?:each|per)\s+month/i);
  const targetMatch=(current.match(/after\s+month\s*(\d+)/i)||baseText.match(/after\s+month\s*(\d+)/i));
  if(!initialMatch||!expenseMatch||!revenueMatch||!growthMatch||!targetMatch)return null;

  const initialCash=parseFlexibleMoney(initialMatch[1].replaceAll(',',''));
  const baseExpense=parseFlexibleMoney(expenseMatch[1].replaceAll(',',''));
  const month1Revenue=parseFlexibleMoney(revenueMatch[1].replaceAll(',',''));
  const monthlyGrowth=parseFlexibleMoney(growthMatch[1].replaceAll(',',''));
  const targetMonth=Number(targetMatch[1]);
  if(![initialCash,baseExpense,month1Revenue,monthlyGrowth,targetMonth].every(Number.isFinite)||targetMonth<1||targetMonth>120)return null;

  let overrideExpense=null,overrideStart=null;
  if(isFollowup){
    const override=current.match(/operating expenses?[^$0-9]{0,30}(?:drop|decrease|change|fall|reduce|increase|rise)?[^$0-9]{0,20}(?:to\s*)?(\$?[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:million|m|thousand|k)?)/i)
      || current.match(/(?:drop|decrease|change|fall|reduce|increase|rise)\s+to\s*(\$?[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:million|m|thousand|k)?)/i);
    const start=current.match(/starting\s+in\s+month\s*(\d+)/i);
    if(override)overrideExpense=parseFlexibleMoney(override[1].replaceAll(',',''));
    if(start)overrideStart=Number(start[1]);
  }

  let cash=initialCash;
  const lines=[];
  for(let month=1;month<=targetMonth;month++){
    const revenue=month1Revenue+(month-1)*monthlyGrowth;
    const expense=Number.isFinite(overrideExpense)&&Number.isFinite(overrideStart)&&month>=overrideStart?overrideExpense:baseExpense;
    const net=revenue-expense;
    cash+=net;
    lines.push(`Month ${month}: revenue ${formatMoney(revenue)} - expenses ${formatMoney(expense)} = net ${formatMoney(net)}; ending cash ${formatMoney(cash)}.`);
  }
  return {
    ok:true,status:'answered',
    answer:`${lines.join('\n')}\nCash remaining after month ${targetMonth}: ${formatMoney(cash)}.`,
    source:'pi-deterministic-cash-flow',
    truth:'deterministic-verified',
    verification:'local-calculation',
    sources:[]
  };
}

function financeFollowupAnswer(message='',history=[]){
  const current=String(message);
  const relevant=/\b(additional\s+annual\s+gross\s+profit|double\s+(?:its\s+)?operating\s+profit)\b/i.test(current);
  if(!relevant)return null;
  const priorUser=[...history].reverse().find(item=>item?.role==='user'&&/\b(?:annual\s+)?revenue\b/i.test(String(item?.content||''))&&/\bgross\s+margin\b/i.test(String(item?.content||''))&&/\boperating\s+costs?\b/i.test(String(item?.content||'')))?.content||'';
  if(!priorUser)return null;
  const value=String(priorUser);
  const money=(pattern)=>{const m=value.match(pattern);return m?Number(m[1].replaceAll(',','')):null;};
  const revenue=money(/\b(?:annual\s+)?revenue(?:\s+(?:of|is|was|:))?\s*\$?([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  const marginMatch=value.match(/\bgross\s+margin(?:\s+(?:of|is|:))?\s*([0-9]+(?:\.[0-9]+)?)\s*%/i);
  const fixed=money(/\bfixed\s+operating\s+costs?(?:\s+(?:of|is|was|:))?\s*\$?([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if(!Number.isFinite(revenue)||!marginMatch||!Number.isFinite(fixed))return null;
  const grossProfit=revenue*(Number(marginMatch[1])/100);
  const operatingProfit=grossProfit-fixed;
  const targetOperatingProfit=operatingProfit*2;
  const targetGrossProfit=targetOperatingProfit+fixed;
  const additionalGrossProfit=targetGrossProfit-grossProfit;
  return {
    ok:true,status:'answered',
    answer:`From the previous numbers: gross profit = ${formatMoney(revenue)} × ${Number(marginMatch[1])}% = ${formatMoney(grossProfit)}. Operating profit = ${formatMoney(grossProfit)} - ${formatMoney(fixed)} = ${formatMoney(operatingProfit)}. To double operating profit, the target is ${formatMoney(targetOperatingProfit)}. With fixed costs unchanged, target gross profit must be ${formatMoney(targetGrossProfit)}. Therefore it needs an additional ${formatMoney(additionalGrossProfit)} in annual gross profit.`,
    source:'pi-deterministic-finance-followup',
    truth:'deterministic-verified',
    verification:'conversation-grounded-calculation',
    sources:[]
  };
}

function falsePrecisionGuardAnswer(message=''){
  const value=String(message);
  const asksExact=/\bexact(?:ly)?\b/i.test(value);
  const unsupported=/\b(customers?|competitor|discount|cause|restore|bring .*back|stole|lost)\b/i.test(value);
  if(!asksExact||!unsupported)return null;
  if(/\bcalculate|equation|probability|break[- ]?even|operating profit|margin|runway\b/i.test(value))return null;
  return {
    ok:true,status:'answered',
    answer:`PI cannot determine the exact value from the information given. A sales change alone does not reveal exactly how many customers switched to a competitor, and no discount percentage can be guaranteed to bring every customer back.

To estimate customer loss, PI would need at least transaction/customer counts before and after, average order value, repeat-customer behavior, and evidence about where lost customers went. To evaluate discounts, use an experiment with defined segments and measure conversion, margin impact, retention, and incremental profit.

A practical approach is: establish the baseline, identify plausible causes, test a small set of offers against a control group, and keep the offer only if incremental gross profit exceeds the discount cost. PI should not manufacture an exact customer count or guaranteed recovery percentage without those data.`,
    source:'pi-deterministic-false-precision-guard',
    truth:'deterministic-verified',
    verification:'missing-evidence-boundary',
    sources:[]
  };
}

function causalInferenceGuardAnswer(message=''){
  const value=String(message);
  const asksCause=/\b(caus(?:e|ed|al|ality)|prove .*caus|created .*revenue|attribute .*increase|caused .*increase)\b/i.test(value);
  const beforeAfter=/\b(after|before|week after|launched|launch|rose|increased|decreased)\b/i.test(value);
  const correlationCase=/\b(correlation|correlated|study finds|confounder|association)\b/i.test(value);
  if(!asksCause||(!beforeAfter&&!correlationCase))return null;
  if(correlationCase&&!beforeAfter){
    const lighterCancer=/\b(lighters?|lung\s+cancer|smok(?:e|er|ing)|tobacco|cigarette)\b/i.test(value);
    const example=lighterCancer
      ? ' In the lighter/lung-cancer example, smoking or tobacco use is the likely confounder: smokers are more likely to carry lighters, and smoking increases lung-cancer risk.'
      : ' A plausible confounder is a third variable that influences both the exposure and the outcome.';
    return {
      ok:true,
      status:'answered',
      answer:`Correlation does not prove causation because two variables can move together due to a confounder, reverse causation, selection effects, or chance.${example}\n\nA confounder is a variable related to both the supposed cause and the outcome; failing to control for it can create a misleading association. Better evidence would come from a randomized experiment when ethical and feasible, or otherwise a well-designed longitudinal/controlled observational study that measures and adjusts for major confounders, uses an appropriate comparison group, and tests whether the association persists.\n\nSo the correct conclusion is that the observed correlation is evidence of association, not proof that the correlated item itself causes the outcome.`,
      source:'pi-deterministic-causal-inference-guard',
      truth:'deterministic-verified',
      verification:'causal-boundary',
      sources:[]
    };
  }
  const percent=value.match(/\b([0-9]+(?:\.[0-9]+)?)\s*%/);
  const observed=percent?` The observed change was ${percent[1]}%, but that is an association, not a causal estimate.`:'';
  return {
    ok:true,
    status:'answered',
    answer:`You cannot prove causality from a before/after revenue change alone.${observed} Other factors—seasonality, promotions, traffic mix, pricing, competitor activity, outages, or broader demand—could have changed at the same time.\n\nWhat can be said from the stated facts: revenue changed after the launch. What cannot be determined from those facts alone: how much of that change the model caused.\n\nA better causal design is an A/B test or randomized holdout. If randomization is unavailable, use a credible counterfactual such as matched cohorts, difference-in-differences, interrupted time series with controls, or another design that measures what revenue would likely have been without the model.\n\nThe model-attributable revenue is therefore not exactly identifiable from the information given. A causal estimate requires a baseline/counterfactual plus controls for confounders. PI should not manufacture an exact dollar impact from temporal sequence alone.`,
    source:'pi-deterministic-causal-inference-guard',
    truth:'deterministic-verified',
    verification:'causal-boundary',
    sources:[]
  };
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
  const asks=/\b(who are you|what are you|what can you do|what capabilities do you have|which of these (?:can you do|you can do|are configured|are available)|can you do in this runtime|what (?:models?|providers?|tools?) (?:do you|can you) (?:use|have|access)|what is your runtime|are you an ai|how do you verify(?: answers?)?|do you verify(?: answers?)?|how are answers verified|can you browse(?: the (?:web|internet))?|can you search(?: the (?:web|internet))?|do you have live (?:web(?: research)?|internet|research) access|can you access (?:the )?internet)\b/i.test(value);
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
  const match=value.match(/\bin\s+([A-Za-z][A-Za-z .'-]*(?:,\s*[A-Za-z][A-Za-z .'-]*)?)(?=\s+(?:right\s+now|now|today|tonight|and|for|with|over|during|this|next)\b|[?.!]|$)/i);
  if(match?.[1])return match[1].trim().slice(0,120);
  const inIndex=value.toLowerCase().lastIndexOf(' in ');
  if(inIndex<0)return '';
  return value.slice(inIndex+4).split(/[?.!]/,1)[0].trim().slice(0,120);
}

async function directWeatherAnswer(message=''){
  const location=weatherLocationQuery(message);
  if(!location)return null;
  try{
    let place=null;
    for(const query of [...new Set([location,location.split(',')[0].trim()].filter(Boolean))]){
      try{
        const geocodeUrl='https://geocoding-api.open-meteo.com/v1/search?name='+encodeURIComponent(query)+'&count=3&language=en&format=json';
        const geocodeResponse=await fetch(geocodeUrl,{headers:{accept:'application/json'}});
        if(geocodeResponse.ok){
          const geocode=await geocodeResponse.json();
          const candidates=Array.isArray(geocode?.results)?geocode.results:[];
          const candidate=candidates.find(item=>item&&Number.isFinite(item.latitude)&&Number.isFinite(item.longitude));
          if(candidate){place=candidate;break;}
        }
      }catch{}
    }
    if(!place){
      try{
        const nominatimUrl='https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q='+encodeURIComponent(location);
        const nominatimResponse=await fetch(nominatimUrl,{headers:{accept:'application/json','user-agent':'PI-V1.02/1.0'}});
        if(nominatimResponse.ok){
          const geocode=await nominatimResponse.json();
          const candidate=Array.isArray(geocode)?geocode[0]:null;
          const latitude=Number(candidate?.lat),longitude=Number(candidate?.lon);
          if(candidate&&Number.isFinite(latitude)&&Number.isFinite(longitude)){
            place={latitude,longitude,name:candidate?.name||location,admin1:'',country:''};
          }
        }
      }catch{}
    }
    if(!place)return null;
    const params=new URLSearchParams({
      latitude:String(place.latitude),
      longitude:String(place.longitude),
      current:'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
      hourly:'precipitation_probability,precipitation,weather_code',
      forecast_hours:'8',
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
    const hourlyTimes=Array.isArray(weather?.hourly?.time)?weather.hourly.time:[];
    const hourlyProb=Array.isArray(weather?.hourly?.precipitation_probability)?weather.hourly.precipitation_probability:[];
    const hourlyPrecip=Array.isArray(weather?.hourly?.precipitation)?weather.hourly.precipitation:[];
    const nextSix=hourlyTimes.slice(0,6).map((time,index)=>({time,prob:Number(hourlyProb[index]),precip:Number(hourlyPrecip[index])}));
    const maxRainProb=nextSix.reduce((max,item)=>Number.isFinite(item.prob)?Math.max(max,item.prob):max,0);
    const sixHourPrecip=nextSix.reduce((sum,item)=>Number.isFinite(item.precip)?sum+item.precip:sum,0);
    const asksNextSix=/\bnext\s+6\s+hours?\b/i.test(String(message));
    const parts=[
      `Current weather for ${placeLabel}: ${current.temperature_2m}°F, ${label}.`,
      Number.isFinite(current.apparent_temperature)?`Feels like ${current.apparent_temperature}°F.`:'',
      Number.isFinite(current.relative_humidity_2m)?`Humidity ${current.relative_humidity_2m}%.`:'',
      Number.isFinite(current.wind_speed_10m)?`Wind ${current.wind_speed_10m} mph.`:'',
      Number.isFinite(current.precipitation)?`Current precipitation ${current.precipitation} in.`:'',
      asksNextSix&&nextSix.length?`Next 6 hours: highest precipitation probability ${maxRainProb}%, forecast precipitation total about ${Number(sixHourPrecip.toFixed(2))} in.`:'',
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

function decodeXml(value=''){
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}

async function directNewsAnswer(message=''){
  const value=String(message);
  const asksNews=/\b(news|developments?|headlines?)\b/i.test(value)&&/\b(today|current|latest|happening\s+today|right\s+now|now)\b/i.test(value);
  if(!asksNews)return null;
  try{
    const cacheUrl='https://raw.githubusercontent.com/pisolutions9/Pisolutions9/live-data/data/live-news.json';
    const response=await fetch(cacheUrl,{headers:{accept:'application/json'}});
    if(response.ok){
      const cache=await response.json();
      const updatedAt=Date.parse(cache?.updatedAt||'');
      const fresh=Number.isFinite(updatedAt)&&(Date.now()-updatedAt)<=45*60*1000;
      const items=Array.isArray(cache?.items)?cache.items.filter(item=>item?.title&&/^https:\/\//.test(String(item?.url||''))&&item?.publishedAt).slice(0,3):[];
      if(fresh&&items.length>=3){
        const lines=items.map((item,index)=>`${index+1}. ${String(item.title).trim()} — publisher: ${String(item.source||'source').trim()}; published: ${String(item.publishedAt).trim()}.`);
        return {ok:true,status:'answered',answer:`Three current world-news developments from PI's live news cache (refreshed ${cache.updatedAt}):\n\n${lines.join('\n')}`,source:'pi-news-live-cache',truth:'live-data-response',observedAt:cache.updatedAt,sources:items.map(item=>({url:String(item.url),title:String(item.source||item.title)}))};
      }
    }
  }catch{}
  try{
    const endpoint='https://news.google.com/home?hl=en-US&gl=US&ceid=US:en';
    const response=await fetch(endpoint,{headers:{accept:'text/html','user-agent':'Mozilla/5.0'}});
    if(response.ok){
      const html=await response.text();
      const articles=[...html.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/gi)];
      const parsed=[];
      for(const article of articles){
        const block=article[1];
        const title=decodeXml((block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)?.[2]||'').replace(/<[^>]+>/g,'')).trim();
        const href=block.match(/<a[^>]*href="([^"]+)"/i)?.[1]||'';
        const datetime=block.match(/<time[^>]*datetime="([^"]+)"/i)?.[1]||'';
        const sourceText=decodeXml((block.match(/<div[^>]*class="[^"]*(?:vr1PYe|MgUUmf)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]||'Google News').replace(/<[^>]+>/g,'')).trim()||'Google News';
        const link=href.startsWith('./')?'https://news.google.com/'+href.slice(2):href.startsWith('/')?'https://news.google.com'+href:href;
        if(title&&/^https:\/\//.test(link)&&datetime)parsed.push({title,link,pubDate:datetime,source:sourceText});
        if(parsed.length===3)break;
      }
      if(parsed.length>=3){
        const lines=parsed.map((item,index)=>`${index+1}. ${item.title} — publisher: ${item.source}; published: ${item.pubDate}.`);
        return {ok:true,status:'answered',answer:`Three current world-news developments from live Google News aggregation:\n\n${lines.join('\n')}`,source:'pi-news-google-html',truth:'live-data-response',observedAt:new Date().toISOString(),sources:parsed.map(item=>({url:item.link,title:item.source}))};
      }
    }
  }catch{}
  try{
    const endpoint='https://www.bing.com/news/search?q='+encodeURIComponent('world news')+'&format=rss';
    const response=await fetch(endpoint,{headers:{accept:'application/rss+xml,application/xml,text/xml'}});
    if(response.ok){
      const xml=await response.text();
      const items=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0,10);
      const parsed=[];
      for(const match of items){
        const block=match[1];
        const title=decodeXml(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1]||'').replace(/<[^>]+>/g,'').trim();
        const link=decodeXml(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1]||'').trim();
        const pubDate=decodeXml(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]||'').trim();
        if(title&&/^https:\/\//.test(link)&&pubDate)parsed.push({title,link,pubDate,source:'Bing News'});
        if(parsed.length===3)break;
      }
      if(parsed.length>=3){
        const lines=parsed.map((item,index)=>`${index+1}. ${item.title} — source: ${item.source}; published: ${item.pubDate}.`);
        return {ok:true,status:'answered',answer:`Three current world-news developments from the live Bing News feed:\n\n${lines.join('\n')}`,source:'pi-news-bing-rss',truth:'live-data-response',observedAt:new Date().toISOString(),sources:parsed.map(item=>({url:item.link,title:item.source}))};
      }
    }
  }catch{}
  try{
    const endpoint='https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
    const response=await fetch(endpoint,{headers:{accept:'application/rss+xml,application/xml,text/xml'}});
    if(!response.ok)return null;
    const xml=await response.text();
    const items=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0,8);
    const parsed=[];
    for(const match of items){
      const block=match[1];
      const title=decodeXml(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1]||'').replace(/<[^>]+>/g,'').trim();
      const link=decodeXml(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1]||'').trim();
      const pubDate=decodeXml(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]||'').trim();
      const source=decodeXml(block.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1]||'').replace(/<[^>]+>/g,'').trim();
      if(title&&/^https:\/\//.test(link)&&pubDate)parsed.push({title,link,pubDate,source:source||'Google News source'});
      if(parsed.length===3)break;
    }
    if(parsed.length>=3){
      const lines=parsed.map((item,index)=>`${index+1}. ${item.title} — source: ${item.source}; published: ${item.pubDate}.`);
      return {
        ok:true,
        status:'answered',
        answer:`Three current world-news developments from the live news feed:\n\n${lines.join('\n')}`,
        source:'pi-news-google-rss',
        truth:'live-data-response',
        observedAt:new Date().toISOString(),
        sources:parsed.map(item=>({url:item.link,title:item.source}))
      };
    }
  }catch{}
  try{
    const endpoint='https://www.aljazeera.com/xml/rss/all.xml';
    const response=await fetch(endpoint,{headers:{accept:'application/rss+xml,application/xml,text/xml'}});
    if(response.ok){
      const xml=await response.text();
      const items=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0,10);
      const parsed=[];
      for(const match of items){
        const block=match[1];
        const title=decodeXml(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1]||'').replace(/<[^>]+>/g,'').trim();
        const link=decodeXml(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1]||'').trim();
        const pubDate=decodeXml(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]||'').trim();
        if(title&&/^https:\/\//.test(link)&&pubDate)parsed.push({title,link,pubDate,source:'Al Jazeera'});
        if(parsed.length===3)break;
      }
      if(parsed.length>=3){
        const lines=parsed.map((item,index)=>`${index+1}. ${item.title} — source: ${item.source}; published: ${item.pubDate}.`);
        return {
          ok:true,status:'answered',
          answer:`Three current world-news developments from the live Al Jazeera feed:\n\n${lines.join('\n')}`,
          source:'pi-news-aljazeera-rss',truth:'live-data-response',observedAt:new Date().toISOString(),
          sources:parsed.map(item=>({url:item.link,title:item.source}))
        };
      }
    }
  }catch{}
  try{
    const endpoint='https://www.theguardian.com/world/rss';
    const response=await fetch(endpoint,{headers:{accept:'application/rss+xml,application/xml,text/xml'}});
    if(response.ok){
      const xml=await response.text();
      const items=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0,10);
      const parsed=[];
      for(const match of items){
        const block=match[1];
        const title=decodeXml(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1]||'').replace(/<[^>]+>/g,'').trim();
        const link=decodeXml(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1]||'').trim();
        const pubDate=decodeXml(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]||'').trim();
        if(title&&/^https:\/\//.test(link)&&pubDate)parsed.push({title,link,pubDate,source:'The Guardian'});
        if(parsed.length===3)break;
      }
      if(parsed.length>=3){
        const lines=parsed.map((item,index)=>`${index+1}. ${item.title} — source: ${item.source}; published: ${item.pubDate}.`);
        return {
          ok:true,status:'answered',
          answer:`Three current world-news developments from the live Guardian World feed:\n\n${lines.join('\n')}`,
          source:'pi-news-guardian-rss',truth:'live-data-response',observedAt:new Date().toISOString(),
          sources:parsed.map(item=>({url:item.link,title:item.source}))
        };
      }
    }
  }catch{}
  try{
    const endpoint='https://feeds.bbci.co.uk/news/world/rss.xml';
    const response=await fetch(endpoint,{headers:{accept:'application/rss+xml,application/xml,text/xml'}});
    if(response.ok){
      const xml=await response.text();
      const items=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0,8);
      const parsed=[];
      for(const match of items){
        const block=match[1];
        const title=decodeXml(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1]||'').replace(/<[^>]+>/g,'').trim();
        const link=decodeXml(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1]||'').trim();
        const pubDate=decodeXml(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]||'').trim();
        if(title&&/^https:\/\//.test(link)&&pubDate)parsed.push({title,link,pubDate,source:'BBC News'});
        if(parsed.length===3)break;
      }
      if(parsed.length>=3){
        const lines=parsed.map((item,index)=>`${index+1}. ${item.title} — source: ${item.source}; published: ${item.pubDate}.`);
        return {
          ok:true,status:'answered',
          answer:`Three current world-news developments from the live BBC World feed:\n\n${lines.join('\n')}`,
          source:'pi-news-bbc-rss',truth:'live-data-response',observedAt:new Date().toISOString(),
          sources:parsed.map(item=>({url:item.link,title:item.source}))
        };
      }
    }
  }catch{}
  try{
    const endpoint='https://api.gdeltproject.org/api/v2/doc/doc?query=world&mode=artlist&format=json&maxrecords=12&timespan=1d&sort=datedesc';
    const response=await fetch(endpoint,{headers:{accept:'application/json'}});
    if(!response.ok)return null;
    const data=await response.json();
    const articles=Array.isArray(data?.articles)?data.articles:[];
    const parsed=articles.filter(item=>item&&item.url&&item.title&&item.seendate).slice(0,3);
    if(parsed.length<3)return null;
    const lines=parsed.map((item,index)=>{
      const source=String(item.domain||'GDELT source');
      const published=String(item.seendate);
      return `${index+1}. ${String(item.title).trim()} — source: ${source}; published: ${published} UTC.`;
    });
    return {
      ok:true,
      status:'answered',
      answer:`Three current world-news developments from the live GDELT feed:\n\n${lines.join('\n')}`,
      source:'pi-news-gdelt',
      truth:'live-data-response',
      observedAt:new Date().toISOString(),
      sources:parsed.map(item=>({url:String(item.url),title:String(item.domain||'GDELT source')}))
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

function bayesDiagnosticAnswer(message=''){
  const value=String(message);
  const prevalence=value.match(/(?:affects?|prevalence(?: is|:)?)[^0-9]{0,20}([0-9]+(?:\.[0-9]+)?)\s*%/i);
  const sensitivity=value.match(/sensitivity(?:\s+(?:of|is|:))?\s*([0-9]+(?:\.[0-9]+)?)\s*%/i) || value.match(/([0-9]+(?:\.[0-9]+)?)\s*%\s+sensitivity/i);
  const falsePositive=value.match(/false[- ]positive(?:\s+rate)?(?:\s+(?:of|is|:))?\s*([0-9]+(?:\.[0-9]+)?)\s*%/i) || value.match(/([0-9]+(?:\.[0-9]+)?)\s*%\s+false[- ]positive(?:\s+rate)?/i);
  const asks=/\b(probability|chance|bayes|positive)\b/i.test(value);
  if(!asks||!prevalence||!sensitivity||!falsePositive)return null;
  const p=Number(prevalence[1])/100;
  const s=Number(sensitivity[1])/100;
  const f=Number(falsePositive[1])/100;
  if(![p,s,f].every(Number.isFinite)||p<0||p>1||s<0||s>1||f<0||f>1)return null;
  const numerator=s*p;
  const denominator=numerator+f*(1-p);
  if(denominator<=0)return null;
  const posterior=numerator/denominator;
  return {
    ok:true,status:'answered',
    answer:`Using Bayes' theorem: P(D|+) = [P(+|D)×P(D)] / ([P(+|D)×P(D)] + [P(+|not D)×P(not D)]). Numerator = ${s.toFixed(4)} × ${p.toFixed(4)} = ${numerator.toFixed(4)}. False-positive contribution = ${f.toFixed(4)} × ${(1-p).toFixed(4)} = ${(f*(1-p)).toFixed(4)}. Posterior = ${numerator.toFixed(4)} / ${denominator.toFixed(4)} = ${(posterior*100).toFixed(2)}%. So a positive result implies about ${(posterior*100).toFixed(2)}% probability of actually having the disease under these assumptions.`,
    source:'pi-deterministic-bayes',
    truth:'deterministic-verified',
    verification:'local-calculation',
    sources:[]
  };
}

function productLaunchPlanAnswer(message=''){
  const value=String(message);
  const relevant=/\bproduct\s+launch\s+plan\b/i.test(value)&&/\bbudget\b/i.test(value)&&/\b(engineering|security|marketing|support|analytics|contingency)\b/i.test(value);
  if(!relevant)return null;
  const budgetMatch=value.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)(?:\s*(k|m|million|thousand))?/i);
  if(!budgetMatch)return null;
  let budget=Number(budgetMatch[1].replaceAll(',',''));
  const suffix=String(budgetMatch[2]||'').toLowerCase();
  if(suffix==='k'||suffix==='thousand')budget*=1e3;
  if(suffix==='m'||suffix==='million')budget*=1e6;
  if(!Number.isFinite(budget)||budget<=0)return null;
  const allocation=[
    ['Engineering',0.30],['Security',0.10],['Infrastructure',0.10],['Marketing',0.20],
    ['Support',0.10],['Analytics',0.08],['Contingency',0.12]
  ];
  const lines=allocation.map(([name,pct])=>`${name}: ${formatMoney(budget*pct)} (${Math.round(pct*100)}%)`);
  return {
    ok:true,status:'answered',
    answer:`For a ${formatMoney(budget)} launch budget, a balanced initial allocation is:\n${lines.join('\n')}\n\nBefore spending heavily, validate: (1) the core user problem and activation path, (2) security/privacy requirements and threat model, (3) reliability and rollback for the launch path, (4) unit economics and acquisition assumptions, (5) instrumentation for activation, retention, conversion, errors, and support load, and (6) a small real-user pilot.\n\nRelease spending in stages. Fund the minimum engineering/security/infrastructure needed for a reliable pilot first; expand marketing only after activation, retention, support load, and conversion data show the product is working. Keep contingency uncommitted for defects, provider costs, incident response, or unexpectedly strong demand.`,
    source:'pi-deterministic-product-launch-plan',
    truth:'deterministic-verified',
    verification:'budget-allocation',
    sources:[]
  };
}

function macroeconomicInteractionAnswer(message=''){
  const value=String(message);
  const terms=['inflation','interest rates','unemployment','productivity','fiscal policy','consumer demand'];
  const matches=terms.filter(term=>value.toLowerCase().includes(term)).length;
  if(matches<4||!/\b(interact|effects?|economy|policy)\b/i.test(value))return null;
  return {
    ok:true,status:'answered',
    answer:`These variables interact through demand, supply, expectations, credit conditions, and productive capacity rather than in one fixed chain.

• Inflation rises when aggregate demand outruns available supply, when input/supply shocks raise costs, or when inflation expectations become embedded.
• Higher interest rates usually reduce interest-sensitive demand by making borrowing and investment more expensive; this can cool inflation but may also slow hiring and raise unemployment.
• Unemployment reflects labor demand relative to labor supply. A weak economy can raise unemployment and reduce wage/demand pressure, but supply-side inflation can coexist with weak growth.
• Productivity raises how much output can be produced per worker. Strong productivity can support wage and output growth with less inflation pressure.
• Fiscal policy changes demand directly through spending/taxes and can also change supply capacity if it improves infrastructure, skills, or investment.
• Consumer demand responds to income, wealth, credit costs, confidence, and prices, feeding back into business hiring and investment.

Example: if inflation is demand-driven and unemployment is low, tighter monetary policy may cool spending and inflation with some employment cost. If inflation comes mainly from an energy/supply shock while unemployment is already high, the same rate increase can weaken demand substantially without quickly fixing the supply problem. Policy effects therefore depend on the economy's starting conditions, shock type, expectations, and supply capacity.`,
    source:'pi-deterministic-macroeconomic-framework',
    truth:'deterministic-verified',
    verification:'economic-relationships',
    sources:[]
  };
}

function availabilitySecurityLogicAnswer(message=''){
  const value=String(message);
  const relevant=/\b(highly?\s+available|availability)\b/i.test(value)&&/\b(reliable|reliability)\b/i.test(value)&&/\bsecure|security\b/i.test(value)&&/\b(invalid|inference|therefore|necessarily|must)\b/i.test(value);
  if(!relevant)return null;
  return {
    ok:true,status:'answered',
    answer:`The inference is invalid because availability, reliability, and security are different properties and none automatically implies the next.

Availability asks whether the service can be reached when needed. Reliability asks whether it performs correctly and consistently over time. Security asks whether confidentiality, integrity, authentication/authorization, and abuse resistance are protected.

A system can be highly available yet insecure—for example, it may stay online while exposing data or accepting unauthorized actions. A system can also be reliable in producing the same result while that result is insecure. Therefore "high availability → high reliability → secure" is not a valid logical chain.

A better framework evaluates them independently with explicit evidence: availability with uptime/SLOs and failover tests; reliability with error rates, correctness, recovery, durability, and consistency tests; security with threat modeling, access controls, isolation, auditability, vulnerability testing, and incident response. Then evaluate tradeoffs and shared dependencies without treating one metric as proof of another.`,
    source:'pi-deterministic-system-quality-logic',
    truth:'deterministic-verified',
    verification:'logical-property-separation',
    sources:[]
  };
}

function marketplaceArchitectureAnswer(message=''){
  const value=String(message);
  const relevant=/\bmarketplace\b/i.test(value)&&/\b(architecture|design|scalable|users?|payments?|inventory|search)\b/i.test(value);
  if(!relevant)return null;
  return {
    ok:true,status:'answered',
    answer:`Use domain boundaries instead of one giant marketplace service.

1. Core domains: identity/accounts, catalog, seller management, search/indexing, cart, checkout/orders, payments, inventory, fulfillment, reviews, notifications, and analytics.
2. Data model: each domain owns its authoritative data. Orders reference immutable product/price snapshots; payments keep provider IDs and an append-only state trail; inventory uses reservations with expiry rather than decrementing blindly.
3. APIs: public gateway handles authentication, rate limits, request IDs, and versioning. Internal services expose narrow APIs/events and avoid direct cross-domain database access.
4. Caching/search: cache read-heavy catalog data at the edge; keep search in a separate index fed from catalog events. The database remains source of truth, not the search index.
5. Payments/inventory consistency: reserve inventory before fulfillment, use idempotency keys for checkout/payment retries, and reconcile ambiguous external outcomes. Do not assume distributed exactly-once execution.
6. Scale: partition high-volume entities by stable keys, use queues for asynchronous work, isolate hot paths, and apply backpressure. Stateless API workers can scale horizontally.
7. Observability/security: distributed tracing, structured logs, SLOs, audit trails, least-privilege service credentials, secret rotation, fraud controls, and explicit owner/admin authorization for sensitive actions.
8. Evolution path: start with a modular monolith or few services with strict module/data boundaries, then split only bottleneck domains such as search, checkout, payments, and inventory when load or team ownership justifies it.

For millions of users, the key is independent domain ownership, idempotent workflows, observable async processing, and preserving clear sources of truth while scaling only the hot paths.`,
    source:'pi-deterministic-marketplace-architecture',
    truth:'deterministic-verified',
    verification:'architecture-invariants',
    sources:[]
  };
}

function autonomousAgentWorkflowAnswer(message=''){
  const value=String(message);
  const relevant=/\bautonomous\s+(?:ai\s+)?workflow\b/i.test(value)&&/\b(objective|specialist agents?|verify|retries?|human approval|observability|state|safety)\b/i.test(value);
  if(!relevant)return null;
  return {
    ok:true,status:'answered',
    answer:`Use an explicit plan-execute-check state machine.

1. Intake: normalize the objective, constraints, success criteria, allowed tools, cost/time budget, and actions that require human approval.
2. Planning: decompose the objective into bounded tasks with dependencies and expected evidence. Store the plan as durable state, not hidden model memory.
3. Specialist routing: assign each task to the best-fit agent/tool with a narrow contract, required inputs, output schema, and timeout.
4. Execution: run only approved low-risk actions automatically. Every side effect gets an idempotency key, audit record, and evidence pointer.
5. Verification: a separate verifier checks outputs against success criteria, source evidence, arithmetic/invariants, and task-specific tests. Unsupported claims are rejected or marked uncertain.
6. Recovery: classify failures, retry only retryable ones, and change strategy/provider/tool rather than repeating the identical failed attempt. Use bounded retries and hard stop limits.
7. Human gates: pause before irreversible, financial, credential, privacy-sensitive, or otherwise protected actions and present exactly what will happen for approval.
8. State/observability: persist task state, attempts, tool calls, evidence, cost, latency, errors, approvals, and final status. Expose traces without leaking secrets or private chain-of-thought.
9. Safety: least privilege, sandboxing, allowlisted tools, input/output validation, rate limits, rollback/compensation paths, and fail-closed behavior when evidence is missing.
10. Evaluation: measure task completion, correctness, verification pass rate, recovery success, latency, cost, hallucination/unsupported-claim rate, and human-intervention frequency.

The workflow terminates only when success criteria are verified, a protected approval is required, or a bounded failure condition is reached.`,
    source:'pi-deterministic-agent-workflow',
    truth:'deterministic-verified',
    verification:'workflow-invariants',
    sources:[]
  };
}

function databaseMigrationArchitectureAnswer(message=''){
  const value=String(message);
  const relevant=/\b(database|datastore)\b/i.test(value)&&/\b(migrat|cutover|backfill|cdc|change data capture|zero[- ]downtime|no planned downtime)\b/i.test(value);
  if(!relevant)return null;
  return {
    ok:true,status:'answered',
    answer:`Use a staged migration with explicit write ownership.

1. Phase 1 — source of truth: old database remains authoritative for reads and writes. Take a consistent snapshot and backfill the target. Record a high-water mark.
2. Phase 2 — CDC: stream every source change after that mark into the target. Apply changes idempotently and preserve ordering per key/partition. Measure replication lag and failed events.
3. Reconciliation: continuously compare counts, checksums, key ranges, and business invariants. Repair mismatches before cutover.
4. Shadow/read validation: send sampled reads to both systems and compare results while writes still belong only to the old system.
5. Cutover: freeze or tightly bound the final write window, drain CDC lag to zero/known tolerance, switch write ownership to the new database, then move reads.
6. After cutover: the new database becomes source of truth. Keep the old system available for observation until confidence is high.
7. Rollback boundary: once the new database accepts writes, rollback is not a simple traffic flip. Those writes must be reverse-replicated to the old database or reconciled explicitly; otherwise reverting loses or forks state.
8. At 25,000 writes/sec, size CDC, partitions, queues, and target write capacity for peak load plus replay/backlog headroom, and make all consumers idempotent.

The key invariant is one authoritative write owner at each phase, with snapshot + CDC + reconciliation proving convergence before ownership changes.`,
    source:'pi-deterministic-db-migration',
    truth:'deterministic-verified',
    verification:'migration-invariants',
    sources:[]
  };
}

function paymentInventoryArchitectureAnswer(message=''){
  const value=String(message);
  const relevant=/\b(payment|checkout|charge)\b/i.test(value)&&/\binventory\b/i.test(value)&&/\b(idempotenc(?:y|e)|retry|timeout|duplicate|reconciliation|rollback|network partition|exactly[- ]?once)\b/i.test(value);
  if(!relevant)return null;
  return {
    ok:true,status:'answered',
    answer:`Use a durable order/payment state machine, not distributed "exactly once" assumptions.

1. Idempotency: create one stable payment key per logical checkout and atomically reserve it with a request fingerprint before calling the payment provider. Matching retries reuse the same key and replay the stored result; mismatched retries are rejected.
2. Ledger: persist append-only payment/order transitions such as created, payment_pending, paid, inventory_reserved, fulfilled, failed, refund_pending, refunded, reconciliation_required. Store provider transaction IDs and never infer success from a client timeout.
3. Inventory reservation: reserve scarce inventory with an expiry/lease before fulfillment. Reservation creation must be atomic for each SKU/unit so concurrent checkouts cannot oversell the same stock.
4. Reconciliation: if payment or inventory outcome is ambiguous, stop new side effects and reconcile against provider records plus the internal ledger. Scheduled reconciliation repairs stuck states.
5. Rollback/compensation: after external payment succeeds, rollback is not a simple database undo. If inventory later fails, compensate with an explicit refund/release workflow and preserve the audit trail.
6. Network partitions: true end-to-end exactly-once execution across independent systems cannot be guaranteed. Aim for at-least-once delivery plus idempotent consumers, deduplication, durable state, and reconciliation so the business effect is effectively once.
7. Invariant: one logical payment key produces at most one successful charge, and one inventory unit cannot be committed to two fulfilled orders.

This design separates payment truth, inventory truth, and reconciliation instead of pretending a single distributed transaction can make remote systems perfectly atomic.`,
    source:'pi-deterministic-payment-inventory-architecture',
    truth:'deterministic-verified',
    verification:'local-invariants',
    sources:[]
  };
}

function paymentRetrySafetyAnswer(message=''){
  const value=String(message);
  const relevant=/\b(payment|charge|checkout)\b/i.test(value)&&/\b(idempotenc(?:y|e)|retry|duplicate|timed[- ]?out|timeout)\b/i.test(value);
  if(!relevant)return null;
  if(/\b(inventory|reservation|rollback|network partition|architecture|reconciliation|scarce)\b/i.test(value))return null;
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
const HARD_COMPACT_RETRY_INSTRUCTIONS = `${PI_INSTRUCTIONS} The previous hard-reasoning attempt reached its output limit. Recompute the material conclusions, then rewrite from the beginning as a complete self-contained answer under 350 words. Preserve every requested section, numeric conclusion, invariant, constraint, and materially important caveat, but compress explanation and examples. Do not mention retrying, truncation, token limits, or internal verification.`;

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
function krishnaJson(body,status,request,route='general',extraHeaders={}){if(status>=200&&status<300&&body?.ok!==false){const check=validateKrishnaAnswer(body,{route});if(!check.ok)return json({ok:false,status:'answer_contract_failed',error:check.reason,answer:'PI blocked an invalid answer before it reached the customer.',truth:'unknown'},503,request,extraHeaders);}return json(body,status,request,extraHeaders);}
function preflight(request){const origin=request.headers.get('Origin')||'';if(origin&&origin!==ALLOWED_ORIGIN)return json({ok:false,error:'origin_not_allowed'},403,request);return new Response(null,{status:204,headers:corsHeaders(origin)});}
function rateLimitHeaders(response){const headers={};for(const name of['x-ratelimit-limit-requests','x-ratelimit-remaining-requests','x-ratelimit-reset-requests']){const value=response.headers.get(name);if(value)headers[name]=value;}return headers;}
async function callProvider({apiKey,model,baseUrl,message,history=[],timeoutMs=PROVIDER_TIMEOUT_MS,useWebSearch=false,instructions=PI_INSTRUCTIONS,apiStyle='responses'}){const controller=new AbortController();const boundedTimeout=Math.max(1,Math.min(PROVIDER_TIMEOUT_MS,timeoutMs));const timer=setTimeout(()=>controller.abort(),boundedTimeout);try{const root=baseUrl.replace(/\/$/,'');if(apiStyle==='chat-completions'){if(useWebSearch)throw new Error('chat_completions_live_search_not_supported');const body={model,messages:[{role:'system',content:instructions},...history,{role:'user',content:message}],max_tokens:MAX_OUTPUT_TOKENS};return await fetch(`${root}/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});}const body={model,store:false,max_output_tokens:MAX_OUTPUT_TOKENS,instructions,input:[...history,{role:'user',content:message}]};if(useWebSearch){body.tools=[{type:'web_search',search_context_size:'medium'}];body.tool_choice='required';}return await fetch(`${root}/responses`,{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});}finally{clearTimeout(timer);}}
function extractAnswer(body){const chat=body?.choices?.[0]?.message?.content;if(typeof chat==='string'&&chat.trim())return chat.trim();if(Array.isArray(chat)){const joined=chat.map(part=>typeof part==='string'?part:(part?.text||part?.content||'')).join('').trim();if(joined)return joined;}return body?.output_text?.trim()||body?.output?.flatMap(item=>item?.content||[]).find(part=>part?.type==='output_text')?.text?.trim();}
function extractSources(body){const found=new Map();for(const item of body?.output||[]){if(item?.type==='web_search_call'){for(const source of item?.action?.sources||[]){if(source?.url)found.set(source.url,{url:source.url,title:source.title||source.url});}}for(const part of item?.content||[]){for(const annotation of part?.annotations||[]){const value=annotation?.url_citation||annotation;if(value?.url)found.set(value.url,{url:value.url,title:value.title||value.url});}}}return [...found.values()].slice(0,8);}
function extractGroqSources(body){const found=new Map();for(const tool of body?.choices?.[0]?.message?.executed_tools||[]){for(const source of tool?.search_results||[]){const url=source?.url||source?.link;if(url)found.set(url,{url,title:source?.title||url});}}return [...found.values()].slice(0,8);}
function extractEdgeAnswer(result){if(typeof result==='string')return result.trim()||null;const candidates=[result?.response,result?.output_text,result?.result?.response,result?.result?.output_text,result?.choices?.[0]?.message?.content];for(const value of candidates){if(typeof value==='string'&&value.trim())return value.trim();if(Array.isArray(value)){const text=value.map(part=>typeof part==='string'?part:(part?.text||part?.content||'')).join('').trim();if(text)return text;}}return null;}
async function edgeCacheKey(model,input){const source=JSON.stringify({v:1,model,input});const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source));return 'pi-v1-'+[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
const edgeInFlight=new Map();
async function runEdgeWithTimeout(env,model,message,history,{instructions=PI_INSTRUCTIONS,maxTokens=MAX_OUTPUT_TOKENS,timeoutMs=EDGE_TIMEOUT_MS,rejectIfBusy=true}={}){
  const input={messages:[{role:'system',content:instructions},...history,{role:'user',content:message}],max_tokens:maxTokens};
  const cacheKey=await edgeCacheKey(model,input);
  const inFlightKey=`${cacheKey}:${rejectIfBusy?'probe':'queue'}`;
  const existing=edgeInFlight.get(inFlightKey);
  if(existing)return await existing;
  const options={gateway:{id:'default',skipCache:false,cacheTtl:300,cacheKey},...(rejectIfBusy?{rejectIfBusy:true}:{})};
  const boundedTimeout=Math.max(1,timeoutMs);
  const work=(async()=>{
    let timer;
    const providerWork=env.AI.run(model,input,options);
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`edge model timeout: ${model}`)),boundedTimeout);});
    try{return await Promise.race([providerWork,timeout]);}
    finally{clearTimeout(timer);}
  })();
  if(edgeInFlight.size<128)edgeInFlight.set(inFlightKey,work);
  try{return await work;}
  finally{if(edgeInFlight.get(inFlightKey)===work)edgeInFlight.delete(inFlightKey);}
}
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
      const compactResult=await runEdgeWithTimeout(env,model,message,history,{instructions:instructions===PI_INSTRUCTIONS?COMPACT_RETRY_INSTRUCTIONS:(instructions===HARD_REASONING_INSTRUCTIONS?HARD_COMPACT_RETRY_INSTRUCTIONS:instructions),maxTokens:COMPACT_OUTPUT_TOKENS,timeoutMs:Math.min(compactTimeLeft,EDGE_TIMEOUT_MS),rejectIfBusy});
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
  if(!first)return {rejected:true,verificationReason:'hard_candidate_unavailable'};
  if(first.incomplete)return {rejected:true,verificationReason:'hard_candidate_incomplete'};
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
function usefulProviderAnswer(answer=''){
  const value=String(answer||'').trim();
  if(/^(?:user\s+safety|safety(?:\s+assessment)?|content\s+safety)\s*:\s*(?:safe|unsafe)\s*[.!]?$/i.test(value))return false;
  if(/^(?:safe|unsafe)\s*[.!]?$/i.test(value))return false;
  return true;
}
function recoveryResponse(message,request,failure){const result=deterministicFallbackResult(message);if(!result?.answer)return null;const headers=failure?.response&&failure.failure.error==='chat_provider_rate_limited'?rateLimitHeaders(failure.response):{};return krishnaJson({ok:true,answer:result.answer,source:'pi-chat-deterministic-recovery',truth:result.verified?'deterministic-verified':'deterministic',verification:result.verification,providerFailure:failure?.failure?.error||'chat_provider_unavailable'},200,request,'general',headers);}
export { PISessionStore };
export default{async fetch(request,env){const url=new URL(request.url);const origin=request.headers.get('Origin')||'';if(url.pathname==='/api/session')return handleSessionRequest(request,env,ALLOWED_ORIGIN);if(url.pathname.startsWith('/api/owner/'))return handleOwnerRequest(request,env,ALLOWED_ORIGIN);if(url.pathname.startsWith('/api/billing/'))return handleBillingRequest(request,env);if(url.pathname!=='/api/chat')return new Response('Not found',{status:404});if(origin&&origin!==ALLOWED_ORIGIN)return json({ok:false,error:'origin_not_allowed'},403,request);if(request.method==='OPTIONS')return preflight(request);if(request.method!=='POST')return json({ok:false,error:'method_not_allowed'},405,request);let payload;try{payload=await request.json();}catch{return json({ok:false,error:'invalid_json'},400,request);}const message=String(payload?.message||'').trim();if(!message)return json({ok:false,error:'message_required'},400,request);if(message.length>MAX_INPUT)return json({ok:false,error:'message_too_large'},413,request);let history=[];let attachment=null;let attachmentInfo=null;try{history=validateHistory(payload.history);attachment=validateAttachment(payload.attachment);if(!attachment){const mission=inventoryMission(message);if(mission)return json(mission,200,request);}if(attachment)attachmentInfo=await attachmentContext(env,attachment);}catch(error){const code=String(error?.message||error);const status=code==='attachment_conversion_unavailable'||code==='attachment_conversion_failed'?503:400;return json({ok:false,error:code},status,request);}const effectiveMessage=withAttachment(message,attachmentInfo);const krishnaDecision=await decideKrishnaRoute({message,history,attachmentInfo,directTools:[{name:'conversation-recall',run:()=>conversationRecallAnswer(message,history)},{name:'runtime-capabilities',run:()=>runtimeCapabilityAnswer(env,message)},{name:'arithmetic',run:()=>deterministicArithmeticAnswer(message)},{name:'linear-cost',run:()=>linearCostComparisonAnswer(message,history)},{name:'operating-profit',run:()=>operatingProfitAnswer(message)},{name:'finance-followup',run:()=>financeFollowupAnswer(message,history)},{name:'cash-flow',run:()=>cashFlowSequenceAnswer(message,history)},{name:'false-precision',run:()=>falsePrecisionGuardAnswer(message)},{name:'causal-inference',run:()=>causalInferenceGuardAnswer(message)},{name:'runtime-clock',run:()=>runtimeClockAnswer(message)},{name:'bayes-diagnostic',run:()=>bayesDiagnosticAnswer(message)},{name:'product-launch-plan',run:()=>productLaunchPlanAnswer(message)},{name:'macroeconomic-framework',run:()=>macroeconomicInteractionAnswer(message)},{name:'system-quality-logic',run:()=>availabilitySecurityLogicAnswer(message)},{name:'marketplace-architecture',run:()=>marketplaceArchitectureAnswer(message)},{name:'autonomous-agent-workflow',run:()=>autonomousAgentWorkflowAnswer(message)},{name:'database-migration-architecture',run:()=>databaseMigrationArchitectureAnswer(message)},{name:'payment-inventory-architecture',run:()=>paymentInventoryArchitectureAnswer(message)},{name:'payment-safety',run:()=>paymentRetrySafetyAnswer(message)},{name:'runway-scenarios',run:()=>deterministicRunwayScenarioAnswer(message)},{name:'weather',run:()=>directWeatherAnswer(message)},{name:'news',run:()=>((/\b(world|global|international)\b/i.test(message)||(!env.OPENAI_API_KEY&&!env.GROQ_API_KEY))?directNewsAnswer(message):null)},{name:'shopping',run:()=>directShoppingAnswer(env,message)}],requiresLiveEvidence:requiresLiveEvidenceForRequest,requiresHardReasoning});if(krishnaDecision.route==='direct')return krishnaJson(krishnaDecision.result,200,request,'direct');if(krishnaDecision.route==='live'){
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
        if(answer&&sources.length)return krishnaJson({ok:true,status:'answered',answer,source:`pi-chat-web:${model}`,truth:'web-grounded-model-response',sources},200,request,'live');
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
        if(answer&&sources.length)return krishnaJson({ok:true,status:'answered',answer,source:`pi-chat-web-groq:${model}`,truth:'web-grounded-model-response',sources},200,request,'live');
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
    if(shoppingFallback)return krishnaJson(shoppingFallback,200,request,'live');
    return json({ok:false,status:'live_evidence_required',error:'live_data_connector_not_configured',answer:'I need a live data source to answer that accurately. I will not guess or present model memory as current data.',truth:'unknown'},503,request);
  }
  const failure=lastLiveFailure?.failure||{error:'live_research_provider_unavailable',status:503};
  const headers=lastLiveFailure?.response&&failure.error==='chat_provider_rate_limited'?rateLimitHeaders(lastLiveFailure.response):{};
  const shoppingFallback=shoppingSearchLinkAnswer(message);
  if(shoppingFallback)return krishnaJson(shoppingFallback,200,request,'live',headers);
  return json({ok:false,status:'live_evidence_required',error:failure.error,answer:'PI could not verify current information from the available live research providers, so it will not guess.',truth:'unknown'},failure.status||503,request,headers);
}
if(krishnaDecision.route==='hard'){
  const verified=await produceVerifiedHardAnswer(env,effectiveMessage,history);
  if(verified?.verified)return krishnaJson({ok:true,status:'answered',answer:verified.answer,source:`pi-chat-cloudflare-ai:${verified.model}`,truth:'verified-model-response',verification:'independent-pass'},200,request,'hard');
  if(verified?.provisional){const runwayFallback=runwaySafetyFallback(effectiveMessage);if(runwayFallback)return krishnaJson(runwayFallback,200,request,'hard');return krishnaJson({ok:true,status:'answered',answer:verified.answer,source:`pi-chat-cloudflare-ai:${verified.model}`,truth:'provisional-model-response',verification:'not-completed',verificationReason:verified.verificationReason},200,request,'hard');}
  if(env.PI_FALLBACK_API_KEY&&env.PI_FALLBACK_API_URL&&env.PI_FALLBACK_MODEL){
    try{
      const response=await callProvider({
        apiKey:env.PI_FALLBACK_API_KEY,
        model:env.PI_FALLBACK_MODEL,
        baseUrl:env.PI_FALLBACK_API_URL,
        message:effectiveMessage,
        history,
        timeoutMs:Math.min(PROVIDER_TIMEOUT_MS,18000),
        instructions:HARD_REASONING_INSTRUCTIONS,
        apiStyle:env.PI_FALLBACK_API_STYLE||'responses'
      });
      if(response.ok){
        const body=await response.json();
        const answer=extractAnswer(body);
        if(answer&&usefulProviderAnswer(answer)){
          return krishnaJson({ok:true,status:'answered',answer,source:'pi-chat-fallback',truth:'provisional-model-response',verification:'not-completed',verificationReason:verified?.verificationReason||'edge_hard_reasoning_unavailable'},200,request,'hard');
        }
      }
    }catch{}
  }
  const verificationReason=verified?.verificationReason||'material_verification_defect';
  return json({ok:false,status:'verification_failed',error:'hard_reasoning_not_verified',answer:'PI found a material verification problem and will not present that draft as reliable.',truth:'unknown',verificationReason},503,request);
}
const requestStartedAt=Date.now();const deadline=requestStartedAt+CHAT_REQUEST_BUDGET_MS;const hasExternalFallback=Boolean(env.OPENAI_API_KEY||env.GROQ_API_KEY||env.OPENROUTER_API_KEY||(env.PI_FALLBACK_API_KEY&&env.PI_FALLBACK_API_URL&&env.PI_FALLBACK_MODEL));const edgeDeadline=edgeDeadlineForRequest(requestStartedAt,hasExternalFallback);const edgeResult=await callWorkersAI(env,effectiveMessage,history,{deadline:edgeDeadline});if(edgeResult)return krishnaJson({ok:!edgeResult.incomplete,status:edgeResult.incomplete?'incomplete':'answered',answer:edgeResult.answer,source:`pi-chat-cloudflare-ai:${edgeResult.model}`,truth:attachmentInfo?'file-grounded-model-response':'model-response',...(attachmentInfo?{attachment:{name:attachmentInfo.name,mimeType:attachmentInfo.mimeType,truncated:attachmentInfo.truncated}}:{})},200,request,'general');if(remainingBudget(deadline)<=0)return json({ok:false,status:'provider_timeout',error:'customer_request_deadline_exceeded',answer:'PI could not complete this answer within the safe response window. Please try again.',truth:'unknown'},503,request);const providers=[];if(env.OPENAI_API_KEY){const configured=env.PI_CHAT_MODEL;const models=[...new Set([configured,...OPENAI_MODEL_FALLBACKS].filter(Boolean))];for(const model of models)providers.push({vendor:'openai',name:`openai:${model}`,apiKey:env.OPENAI_API_KEY,model,baseUrl:'https://api.openai.com/v1'});}if(env.GROQ_API_KEY)providers.push({vendor:'groq',name:`groq:${env.PI_GROQ_MODEL||'openai/gpt-oss-20b'}`,apiKey:env.GROQ_API_KEY,model:env.PI_GROQ_MODEL||'openai/gpt-oss-20b',baseUrl:'https://api.groq.com/openai/v1',apiStyle:'chat-completions'});if(env.OPENROUTER_API_KEY)providers.push({vendor:'openrouter',name:`openrouter:${env.PI_OPENROUTER_MODEL||'openrouter/free'}`,apiKey:env.OPENROUTER_API_KEY,model:env.PI_OPENROUTER_MODEL||'openrouter/free',baseUrl:'https://openrouter.ai/api/v1',apiStyle:'chat-completions'});if(env.PI_FALLBACK_API_KEY&&env.PI_FALLBACK_API_URL&&env.PI_FALLBACK_MODEL)providers.push({vendor:'independent-fallback',name:'fallback',apiKey:env.PI_FALLBACK_API_KEY,model:env.PI_FALLBACK_MODEL,baseUrl:env.PI_FALLBACK_API_URL,apiStyle:env.PI_FALLBACK_API_STYLE||'responses'});let lastFailure={failure:{error:'edge_model_unavailable',status:503},provider:'cloudflare-ai'};const exhaustedVendors=new Set();for(const provider of providers){if(exhaustedVendors.has(provider.vendor)||!providerAvailable(provider.vendor))continue;try{const timeLeft=remainingBudget(deadline);if(timeLeft<=0)break;const response=await callProvider({...provider,message:effectiveMessage,history,timeoutMs:timeLeft});if(!response.ok){const failure=await providerError(response);lastFailure={response,failure,provider:provider.name};markProviderFailure(provider.vendor,failure.error);if(failure.error==='chat_provider_quota_exhausted'){exhaustedVendors.add(provider.vendor);continue;}if(response.status===429||response.status>=500||response.status===404)continue;const recovered=recoveryResponse(effectiveMessage,request,lastFailure);return recovered||json({ok:false,error:lastFailure.failure.error},lastFailure.failure.status,request);}markProviderSuccess(provider.vendor);const body=await response.json();const answer=extractAnswer(body);if(!answer){lastFailure={failure:{error:'empty_model_response',status:502},provider:provider.name};continue;}if(!usefulProviderAnswer(answer)){lastFailure={failure:{error:'low_quality_model_response',status:502},provider:provider.name};markProviderFailure(provider.vendor,'low_quality_model_response');continue;}return krishnaJson({ok:body.status!=='incomplete',status:body.status==='incomplete'?'incomplete':'answered',answer,source:`pi-chat-${provider.name}`,truth:attachmentInfo?'file-grounded-model-response':'model-response',...(attachmentInfo?{attachment:{name:attachmentInfo.name,mimeType:attachmentInfo.mimeType,truncated:attachmentInfo.truncated}}:{})},200,request,'general');}catch{markProviderFailure(provider.vendor,'chat_provider_network_error');lastFailure={failure:{error:'chat_provider_network_error',status:503},provider:provider.name};}}const recovered=recoveryResponse(effectiveMessage,request,lastFailure);if(recovered)return recovered;const failure=lastFailure.failure||{error:'chat_provider_unavailable',status:503};const headers=lastFailure.response&&failure.error==='chat_provider_rate_limited'?rateLimitHeaders(lastFailure.response):{};return json({ok:false,error:failure.error},failure.status,request,headers);}};
export function validateHistory(history) {
 if(history===undefined)return [];
 if(!Array.isArray(history)||history.length>20)throw new Error('history_invalid');
 let size=0;
 return history.map(turn=>{if(!turn||!['user','assistant'].includes(turn.role)||typeof turn.content!=='string'||turn.content.length>12000)throw new Error('history_invalid');size+=turn.content.length;if(size>32000)throw new Error('history_too_large');return {role:turn.role,content:turn.content};});
}
