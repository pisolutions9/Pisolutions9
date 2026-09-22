"use strict";
const $=id=>document.getElementById(id);
const OWNER_SESSION_KEY="pi-v1-owner-session";
const API_BASE=(window.PI_CHAT_API_BASE||document.documentElement.dataset.piChatApiBase||"https://pi-chat.premchandyadlapati.workers.dev").replace(/\/$/,"");
const safe=(v,f="—")=>typeof v==="string"&&v.trim()?v.trim():f;
const list=(el,items)=>{el.replaceChildren();const xs=Array.isArray(items)?items:[];if(!xs.length){el.textContent="No verified items reported.";return;}const ul=document.createElement("ul");for(const x of xs){const li=document.createElement("li");li.textContent=typeof x==="string"?x:safe(x?.title||x?.summary);ul.append(li);}el.append(ul);};
function session(){try{return sessionStorage.getItem(OWNER_SESSION_KEY)||"";}catch{return "";}}
function lock(message="Owner authentication required"){
 $("dashboard").hidden=true;$("locked").hidden=false;$("locked").querySelector("p").textContent=message+". No owner telemetry was exposed.";$("syncState").textContent="Private state locked.";
}
async function load(){
 const token=session(); if(!/^[A-Za-z0-9_-]{43}$/.test(token)){lock();return;}
 $("syncState").textContent="Loading authenticated owner state…";$("dashboard").hidden=true;$("locked").hidden=false;
 try{
  const r=await fetch(API_BASE+"/api/owner/dashboard",{method:"GET",headers:{"Accept":"application/json","Authorization":"Bearer "+token},cache:"no-store",referrerPolicy:"no-referrer"});
  let d={};try{d=await r.json();}catch{}
  if(r.status===401){try{sessionStorage.removeItem(OWNER_SESSION_KEY);}catch{};throw new Error("Owner session expired");}
  if(!r.ok||d?.ok!==true)throw new Error("Verified owner state unavailable");
  const ready=d.readiness||{},security=d.security||{};
  $("release").textContent=ready.ownerAuthConfigured===true?"Configured":"Not configured";$("releaseDetail").textContent="Server-side owner authentication";
  $("runtime").textContent=ready.billingConfigured===true?"Configured":"Not fully configured";$("runtimeDetail").textContent="Billing configuration only; this does not prove customer charging.";
  $("tests").textContent=security.bearerSessionRequired&&security.originRestricted&&security.noStore?"Protected":"Check required";$("testsDetail").textContent="Bearer session · origin restriction · no-store · login rate limit";
  $("ownerAction").textContent=ready.productionActivationVerified===true?"Verified":"Not verified";$("ownerActionDetail").textContent=ready.customerChargingVerified===true?"Customer charging verified":"No production/customer-charging claim";
  const daily=Array.isArray(d.history?.daily)?d.history.daily.slice(-7).map(x=>String(x.date||"")+" · commits "+String(x.commits??"unknown")+" · workflows "+String(x.workflowRuns??"unknown")):[];
  list($("today"),daily);list($("blockers"),d.ownerActions);
  $("locked").hidden=true;$("dashboard").hidden=false;$("syncState").textContent="Showing authenticated owner-only repository/configuration evidence.";
 }catch(e){lock(e?.message||"Verified owner state unavailable");}
}
$("refresh").addEventListener("click",load);load();setInterval(load,60000);