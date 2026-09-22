"use strict";
const $=id=>document.getElementById(id);
const OWNER_SESSION_KEY="pi-v1-owner-session";
const API_BASE=(window.PI_CHAT_API_BASE||document.documentElement.dataset.piChatApiBase||"https://pi-chat.premchandyadlapati.workers.dev").replace(/\/$/,"");
const safe=(v,f="—")=>typeof v==="string"&&v.trim()?v.trim():f;
function session(){try{return sessionStorage.getItem(OWNER_SESSION_KEY)||"";}catch{return "";}}
function item(title,detail,tone=""){const d=document.createElement("div");d.className="feed-item "+tone;const s=document.createElement("strong");s.textContent=title;const p=document.createElement("span");p.textContent=detail;d.append(s,p);return d;}
function lock(message="Owner authentication required"){$("dashboard").hidden=true;$("locked").hidden=false;$("logout").hidden=true;$("locked").querySelector("p").textContent=message+". No owner telemetry was exposed.";$("syncState").textContent="Private owner state locked.";}
function renderHistory(history){
 const rows=Array.isArray(history?.daily)?history.daily.slice(-7):[]; $("today").replaceChildren();
 if(!rows.length)$("today").append(item("No verified history","No repository/workflow history was returned.","warn"));
 for(const r of [...rows].reverse()) $("today").append(item(String(r.date||"Unknown date"),"commits "+String(r.commits??"unknown")+" · workflows "+String(r.workflowRuns??"unknown")+" · passed "+String(r.workflowsPassed??"unknown")+" · failed "+String(r.workflowsFailed??"unknown")+(r.snapshotPartialDay?" · partial day":""),Number(r.workflowsFailed||0)>0?"warn":"good"));
 const total=k=>rows.reduce((n,r)=>n+(Number(r?.[k])||0),0);
 $("sumCommits").textContent=total("commits");$("sumRuns").textContent=total("workflowRuns");$("sumPassed").textContent=total("workflowsPassed");$("sumFailed").textContent=total("workflowsFailed");$("sumPages").textContent=total("pagesPassed");$("sumWorker").textContent=total("workerPassed");$("historyScope").textContent=safe(history?.scope,"verified engineering evidence");
}
function renderActions(actions){$("blockers").replaceChildren();const xs=Array.isArray(actions)?actions:[];if(!xs.length){$("blockers").append(item("No owner action reported","Authenticated backend returned no owner action.","good"));return;}for(const x of xs)$("blockers").append(item(String(x),"Requires owner attention only if still applicable.",/No credential|No owner action/i.test(String(x))?"good":"warn"));}
function renderTeam(team){$("team").replaceChildren();$("teamMode").textContent=safe(team?.mode);$("team").append(item(safe(team?.orchestrator,"Krishna"),safe(team?.note,"Verified team state unavailable."),"working"));for(const x of Array.isArray(team?.currentFocus)?team.currentFocus:[])$("team").append(item(String(x),"Current authenticated dashboard focus.","working"));}
async function load(){
 const token=session();if(!/^[A-Za-z0-9_-]{43}$/.test(token)){lock();return;}
 $("syncState").textContent="Loading authenticated owner state…";
 try{
  const r=await fetch(API_BASE+"/api/owner/dashboard",{method:"GET",headers:{"Accept":"application/json","Authorization":"Bearer "+token},cache:"no-store",referrerPolicy:"no-referrer"});
  let d={};try{d=await r.json();}catch{}
  if(r.status===401){try{sessionStorage.removeItem(OWNER_SESSION_KEY);}catch{};throw new Error("Owner session expired");}
  if(!r.ok||d?.ok!==true)throw new Error("Verified owner state unavailable");
  const ready=d.readiness||{},security=d.security||{};
  $("release").textContent=ready.ownerAuthConfigured===true?"Configured":"Action needed";$("releaseDetail").textContent="Server-side owner authentication";
  $("tests").textContent=security.bearerSessionRequired&&security.originRestricted&&security.noStore&&security.loginRateLimited?"Protected":"Check required";$("testsDetail").textContent="Bearer · origin · no-store · rate limit";
  $("runtime").textContent=ready.billingConfigured===true?"Configured":"Incomplete";$("runtimeDetail").textContent="Configuration only; not proof of charging";
  $("production").textContent=ready.productionActivationVerified===true?"Verified":"Not verified";$("productionDetail").textContent=ready.customerChargingVerified===true?"Customer charging verified":"No customer-charging claim";
  const secure=ready.ownerAuthConfigured===true&&security.bearerSessionRequired&&security.originRestricted&&security.noStore;
  $("overall").textContent=secure?"Owner control online":"Owner attention required";$("overallDetail").textContent=secure?"Authenticated private control plane is responding. Unverified production claims remain explicitly blocked.":"One or more verified owner-control requirements need attention.";
  const actions=Array.isArray(d.ownerActions)?d.ownerActions:[];$("ownerAction").textContent=actions.length?String(actions[0]):"None";$("ownerActionDetail").textContent=actions.length>1?String(actions.length)+" verified actions reported":"Authenticated backend state";
  renderHistory(d.history);renderActions(actions);renderTeam(d.team);
  $("updatedAt").textContent="Refreshed "+new Date().toLocaleString();$("locked").hidden=true;$("dashboard").hidden=false;$("logout").hidden=false;$("syncState").textContent="Authenticated owner-only evidence. Auto-refreshes every 60 seconds.";
 }catch(e){lock(e?.message||"Verified owner state unavailable");}
}
async function logout(){const token=session();try{if(token)await fetch(API_BASE+"/api/owner/logout",{method:"POST",headers:{"Authorization":"Bearer "+token},cache:"no-store",referrerPolicy:"no-referrer"});}catch{}try{sessionStorage.removeItem(OWNER_SESSION_KEY);}catch{}lock("Owner session locked");}
$("refresh").addEventListener("click",load);$("logout").addEventListener("click",logout);load();setInterval(load,60000);