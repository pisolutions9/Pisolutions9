"use strict";
const $=id=>document.getElementById(id);
const safe=(v,f="—")=>typeof v==="string"&&v.trim()?v.trim():f;
const list=(el,items)=>{el.replaceChildren();const xs=Array.isArray(items)?items:[];if(!xs.length){el.textContent="No verified items reported.";return;}const ul=document.createElement("ul");for(const x of xs){const li=document.createElement("li");li.textContent=typeof x==="string"?x:safe(x?.title||x?.summary);ul.append(li);}el.append(ul);};
async function load(){
 $("syncState").textContent="Loading verified private state…"; $("dashboard").hidden=true; $("locked").hidden=false;
 try{
  const r=await fetch("/.netlify/functions/owner-status",{credentials:"same-origin",headers:{"Accept":"application/json"}});
  if(!r.ok) throw new Error(r.status===401||r.status===403?"Owner authentication required":"Verified state unavailable");
  const d=await r.json(); if(!d||d.verified!==true) throw new Error("Unverified state rejected");
  $("release").textContent=safe(d.release?.status); $("releaseDetail").textContent=safe(d.release?.detail);
  $("runtime").textContent=safe(d.runtime?.status); $("runtimeDetail").textContent=safe(d.runtime?.detail);
  $("tests").textContent=safe(d.tests?.status); $("testsDetail").textContent=safe(d.tests?.detail);
  $("ownerAction").textContent=safe(d.owner_action?.status,"None verified"); $("ownerActionDetail").textContent=safe(d.owner_action?.detail);
  list($("today"),d.today); list($("blockers"),d.blockers);
  $("updatedAt").textContent=d.generated_at?"Verified "+new Date(d.generated_at).toLocaleString():"Timestamp unavailable";
  $("locked").hidden=true; $("dashboard").hidden=false; $("syncState").textContent="Showing verified canonical state.";
 }catch(e){$("locked").querySelector("p").textContent=e.message+". No owner telemetry was exposed."; $("syncState").textContent="Private state locked.";}}
$("refresh").addEventListener("click",load); load(); setInterval(load,60000);