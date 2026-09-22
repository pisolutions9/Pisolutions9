import { chatOutcome, transportOutcome } from './pi/customer-response.mjs';

const command = document.querySelector('#command');
const mission = document.querySelector('#mission');
const missionTitle = document.querySelector('#missionTitle');
const steps = document.querySelector('#steps');
const confidence = document.querySelector('#confidence');
const run = document.querySelector('#run');
const ownerToken = document.querySelector('#ownerToken');
const systemStatus = document.querySelector('#systemStatus');
const attachFile = document.querySelector('#attachFile');
const fileInput = document.querySelector('#fileInput');
const attachmentStatus = document.querySelector('#attachmentStatus');
const syncDevice = document.querySelector('#syncDevice');
const syncNotice = document.querySelector('#syncNotice');
const ownerAccess = document.querySelector('#ownerAccess');
const ownerDialog = document.querySelector('#ownerDialog');
const ownerLoginForm = document.querySelector('#ownerLoginForm');
const ownerSecret = document.querySelector('#ownerSecret');
const ownerLoginError = document.querySelector('#ownerLoginError');
const billingAction = document.querySelector('#billingAction');
const ownerCommandCenter = document.querySelector('#ownerCommandCenter');
const ownerRefresh = document.querySelector('#ownerRefresh');
const ownerPiStatus = document.querySelector('#ownerPiStatus');
const ownerTeamStatus = document.querySelector('#ownerTeamStatus');
const ownerBlockers = document.querySelector('#ownerBlockers');
const ownerActions = document.querySelector('#ownerActions');
const ownerSnapshotNote = document.querySelector('#ownerSnapshotNote');
const ownerHistorySummary = document.querySelector('#ownerHistorySummary');
const ownerReleaseStatus = document.querySelector('#ownerReleaseStatus');
const ownerPaymentStatus = document.querySelector('#ownerPaymentStatus');
const ownerRecentActivity = document.querySelector('#ownerRecentActivity');
const ownerProgressChart = document.querySelector('#ownerProgressChart');
const ownerChartLegend = document.querySelector('#ownerChartLegend');
const ownerChartTooltip = document.querySelector('#ownerChartTooltip');
const ownerGrowthPercent = document.querySelector('#ownerGrowthPercent');
const ownerDailyGrowth = document.querySelector('#ownerDailyGrowth');
const ownerSecurityStatus = document.querySelector('#ownerSecurityStatus');
const ownerSignOut = document.querySelector('#ownerSignOut');
const ownerLastUpdated = document.querySelector('#ownerLastUpdated');
const ownerActionList = document.querySelector('#ownerActionList');
let attachedFile = null;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

function clearAttachment() {
  attachedFile = null;
  fileInput.value = '';
  attachmentStatus.replaceChildren();
  attachmentStatus.classList.add('hidden');
}
function showAttachment(name) {
  attachmentStatus.replaceChildren();
  const text = document.createElement('span'); text.textContent = `Attached: ${name}`;
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.addEventListener('click', clearAttachment);
  attachmentStatus.append(text, remove); attachmentStatus.classList.remove('hidden');
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '').split(',')[1] || ''); reader.onerror = () => reject(reader.error || new Error('file_read_failed')); reader.readAsDataURL(file); });
}
attachFile.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0]; if (!file) return;
  if (file.size > MAX_ATTACHMENT_BYTES) { clearAttachment(); setStatus('File must be 4 MB or smaller', 'blocked'); return; }
  try { attachedFile = { name: file.name, type: file.type || 'application/octet-stream', data: await fileToBase64(file) }; showAttachment(file.name); setStatus('Attachment ready'); }
  catch { clearAttachment(); setStatus('Could not read attachment', 'blocked'); }
});

function setStatus(label, state = 'idle') {
  systemStatus.textContent = label;
  systemStatus.closest('.status').dataset.state = state;
}
const DRAFT_KEY = 'pi-v1-draft';
const PENDING_KEY = 'pi-v1-pending-question';
const HISTORY_KEY = 'pi-v1-conversation';
const SYNC_KEY = 'pi-v1-sync-token';
const OWNER_SESSION_KEY = 'pi-v1-owner-session';
const BILLING_TOKEN_KEY = 'pi-v1-billing-access';
let ownerSession = '';
try { ownerSession = sessionStorage.getItem(OWNER_SESSION_KEY) || ''; } catch {}
let ownerMode = false;
let ownerRevision = 0;
let ownerSyncTimer = null;
function storageGet(key) {
  try {
    const persistent = localStorage.getItem(key);
    if (persistent !== null) return persistent;
  } catch {}
  try {
    const legacy = sessionStorage.getItem(key);
    if (legacy !== null) {
      try { localStorage.setItem(key, legacy); sessionStorage.removeItem(key); } catch {}
      return legacy;
    }
  } catch {}
  return null;
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); try { sessionStorage.removeItem(key); } catch {} return; } catch {}
  try { sessionStorage.setItem(key, value); } catch {}
}
function storageRemove(key) {
  try { localStorage.removeItem(key); } catch {}
  try { sessionStorage.removeItem(key); } catch {}
}
function validSyncToken(value) { return /^[A-Za-z0-9_-]{43}$/.test(String(value || '')); }
function importedSyncToken() {
  try {
    const match = String(window.location?.hash || '').match(/(?:^#|[&#])pi-sync=([A-Za-z0-9_-]{43})(?:&|$)/);
    if (!match) return '';
    storageSet(SYNC_KEY, match[1]);
    if (window.history?.replaceState) window.history.replaceState(null, '', (window.location.pathname || '/') + (window.location.search || ''));
    return match[1];
  } catch { return ''; }
}
let syncToken = importedSyncToken() || storageGet(SYNC_KEY) || '';
if (!validSyncToken(syncToken)) { syncToken = ''; storageRemove(SYNC_KEY); }
let syncTimer = null;
let applyingRemoteSession = false;
function syncApiUrl() {
  const configuredBase = window.PI_CHAT_API_BASE || document.documentElement.dataset.piChatApiBase || 'https://pi-chat.premchandyadlapati.workers.dev';
  return configuredBase.replace(/\/$/, '') + '/api/session';
}
function syncConversationPayload() { return historyWindow().map(({ role, content, sources, artifacts }) => ({ role, content, ...(Array.isArray(sources) && sources.length ? { sources } : {}), ...(Array.isArray(artifacts) && artifacts.length ? { artifacts } : {}) })); }
async function syncRequest(action, extra = {}) {
  if (!syncToken) return null;
  const response = await fetch(syncApiUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, token: syncToken, ...extra }) });
  if (!response.ok) throw new Error('session_sync_failed');
  return await response.json();
}
function ownerApiUrl(path) {
  const configuredBase = window.PI_CHAT_API_BASE || document.documentElement.dataset.piChatApiBase || 'https://pi-chat.premchandyadlapati.workers.dev';
  return configuredBase.replace(/\/$/, '') + path;
}
async function ownerRequest(path, { method='POST', body } = {}) {
  if (!ownerSession) throw new Error('owner_session_missing');
  const response = await fetch(ownerApiUrl(path), {
    method,
    headers: { 'content-type':'application/json', authorization:`Bearer ${ownerSession}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (response.status === 401) {
    try { sessionStorage.removeItem(OWNER_SESSION_KEY); } catch {}
    ownerSession = ''; ownerMode = false;
  }
  if (!response.ok) {
    const error = new Error(payload.error || 'owner_request_failed');
    error.code = payload.error || 'owner_request_failed';
    error.payload = payload;
    throw error;
  }
  return payload;
}
async function saveOwnerWorkspace() {
  if (!ownerMode || !ownerSession) return;
  const payload = await ownerRequest('/api/owner/workspace', {
    body: { action:'save', expectedRevision:ownerRevision, conversation:syncConversationPayload(), draft:command.value.slice(0,8000), preferences:{}, tasks:[], artifacts:[] }
  });
  ownerRevision = Number(payload?.workspace?.revision || ownerRevision);
}
function scheduleOwnerWorkspaceSync() {
  if (!ownerMode || applyingRemoteSession) return;
  clearTimeout(ownerSyncTimer);
  ownerSyncTimer = setTimeout(() => {
    saveOwnerWorkspace().catch(async error => {
      if (error?.code === 'workspace_revision_conflict') {
        try { await loadOwnerWorkspace(); updateSyncUi('Owner workspace refreshed after a device conflict.'); } catch {}
      }
    });
  }, 350);
}
function scheduleSessionSync() {
  if (ownerMode) { scheduleOwnerWorkspaceSync(); return; }
  if (!syncToken || applyingRemoteSession) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncRequest('save', { conversation: syncConversationPayload(), draft: command.value.slice(0, 8000) }).catch(() => {}); }, 350);
}
function saveDraft() {
  if (!ownerMode) storageSet(DRAFT_KEY, command.value);
  scheduleSessionSync();
}
function restoreDraft(text) {
  // Preserve any new text the owner typed while the previous request was running.
  if (!command.value.trim()) command.value = text;
  saveDraft();
  command.style.height = 'auto';
  command.style.height = Math.min(command.scrollHeight, 140) + 'px';
}
command.value = storageGet(DRAFT_KEY) || storageGet(PENDING_KEY) || '';
setStatus(navigator.onLine ? 'Ready to ask' : 'Offline', navigator.onLine ? 'idle' : 'blocked');
window.addEventListener('offline', () => setStatus('Offline', 'blocked'));
window.addEventListener('online', () => { if (!run.disabled) setStatus('Connection restored'); });


let conversation = [];
const artifactUrls = [];
try { const saved = JSON.parse(storageGet(HISTORY_KEY) || '[]'); if (Array.isArray(saved)) conversation = saved.filter(t => t && ['user','assistant'].includes(t.role) && typeof t.content === 'string').slice(-20); } catch {}
function historyWindow() {
  const result = []; let size = 0;
  for (const turn of [...conversation].reverse()) { if (turn.content.length > 12000 || size + turn.content.length > 30000) break; result.unshift(turn); size += turn.content.length; }
  return result.slice(-20);
}
function sanitizeSavedSources(sources = []) {
  return Array.isArray(sources) ? sources.filter(source => source && typeof source.url === 'string' && /^https:\/\//.test(source.url)).slice(0, 8).map(source => ({ url: source.url.slice(0, 2000), title: typeof source.title === 'string' ? source.title.slice(0, 200) : '' })) : [];
}
function rememberTurn(role, content, artifacts = [], sources = []) {
  const savedArtifacts = artifacts.filter(isDownloadableArtifact).slice(0, 1).map(({ filename, mimeType, content }) => ({ filename, mimeType, content }));
  const savedSources = role === 'assistant' ? sanitizeSavedSources(sources) : [];
  conversation.push({ role, content, ...(savedArtifacts.length ? { artifacts: savedArtifacts } : {}), ...(savedSources.length ? { sources: savedSources } : {}) }); conversation = historyWindow();
  if (!ownerMode) storageSet(HISTORY_KEY, JSON.stringify(conversation));
  scheduleSessionSync();
}
function syncWelcome() { const welcome = document.querySelector('#welcome'); if (welcome) welcome.classList.toggle('hidden', conversation.length > 0 || document.querySelector('#transcript').children.length > 0); }
function addTranscript(role, text) {
  const card = document.createElement('article'); card.className = 'chat-turn ' + role;
  const label = document.createElement('strong'); label.textContent = role === 'user' ? 'You' : 'PI';
  const content = document.createElement('div'); content.className = 'chat-content'; content.textContent = text;
  card.append(label, content); document.querySelector('#transcript').append(card); syncWelcome(); return card;
}
function isDownloadableArtifact(artifact) {
  return Boolean(artifact && artifact.filename === 'inventory.csv' && artifact.mimeType === 'text/csv;charset=utf-8' && typeof artifact.content === 'string' && artifact.content.length <= 100000);
}
function downloadArtifact(artifact, card) {
  if (!isDownloadableArtifact(artifact)) return;
  const url = URL.createObjectURL(new Blob([artifact.content], { type: artifact.mimeType })); artifactUrls.push(url);
  const link = document.createElement('a'); link.href = url; link.download = artifact.filename; link.textContent = 'Download ' + artifact.filename; link.className = 'download'; card.append(link);
}
function renderSources(sources, card) {
  if (!Array.isArray(sources) || !sources.length) return;
  const wrap = document.createElement('div'); wrap.className = 'sources';
  const label = document.createElement('small'); label.textContent = 'Sources'; wrap.append(label);
  for (const source of sources.slice(0, 8)) {
    if (!source || typeof source.url !== 'string' || !/^https:\/\//.test(source.url)) continue;
    const link = document.createElement('a'); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = source.title || new URL(source.url).hostname; wrap.append(link);
  }
  if (wrap.children.length > 1) card.append(wrap);
}
function renderConversation() {
  document.querySelector('#transcript').replaceChildren();
  for (const url of artifactUrls) URL.revokeObjectURL(url);
  artifactUrls.length = 0;
  for (const turn of conversation) {
    const card = addTranscript(turn.role, turn.content);
    if (turn.role === 'assistant' && Array.isArray(turn.artifacts)) for (const artifact of turn.artifacts.slice(0, 1)) downloadArtifact(artifact, card);
    if (turn.role === 'assistant') renderSources(turn.sources, card);
  }
  syncWelcome();
}
renderConversation();
function updateSyncUi(message = '') {
  if (!syncDevice || !syncNotice) return;
  syncDevice.textContent = syncToken ? 'Copy sync link' : 'Sync devices';
  if (message) { syncNotice.textContent = message; syncNotice.classList.remove('hidden'); }
  else syncNotice.classList.add('hidden');
}
function makeSyncToken() {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function privateSyncLink() {
  const origin = window.location?.origin || 'https://pisolutions9.github.io';
  const path = window.location?.pathname || '/Pisolutions9/';
  const search = window.location?.search || '';
  return origin + path + search + '#pi-sync=' + syncToken;
}
async function copySyncLink() {
  if (!syncToken) { syncToken = makeSyncToken(); storageSet(SYNC_KEY, syncToken); }
  await syncRequest('save', { conversation: syncConversationPayload(), draft: command.value.slice(0, 8000) });
  const link = privateSyncLink();
  try { await navigator.clipboard.writeText(link); updateSyncUi('Private sync link copied. Open it on your other device. Anyone with this link can access the synced recent conversation.'); }
  catch { updateSyncUi('Private sync link: ' + link); }
}
async function loadSyncedSession() {
  if (!syncToken) { updateSyncUi(); return; }
  const before = JSON.stringify({ conversation: syncConversationPayload(), draft: command.value });
  try {
    const body = await syncRequest('load');
    const remote = body?.session;
    if (!remote) { await syncRequest('save', { conversation: syncConversationPayload(), draft: command.value.slice(0, 8000) }); updateSyncUi('Private device sync is active.'); return; }
    const current = JSON.stringify({ conversation: syncConversationPayload(), draft: command.value });
    if (current !== before) { scheduleSessionSync(); return; }
    applyingRemoteSession = true;
    conversation = Array.isArray(remote.conversation) ? remote.conversation.filter(t => t && ['user','assistant'].includes(t.role) && typeof t.content === 'string').slice(-20) : [];
    command.value = typeof remote.draft === 'string' ? remote.draft.slice(0, 8000) : '';
    storageSet(HISTORY_KEY, JSON.stringify(conversation)); storageSet(DRAFT_KEY, command.value);
    renderConversation();
    command.style.height = 'auto'; command.style.height = Math.min(command.scrollHeight, 140) + 'px';
    updateSyncUi('Private device sync is active.');
  } catch { updateSyncUi('Device sync is temporarily unavailable; this browser still keeps your recent conversation.'); }
  finally { applyingRemoteSession = false; }
}
syncDevice?.addEventListener('click', () => { copySyncLink().catch(() => updateSyncUi('Could not create the sync link. Please try again.')); });
document.querySelector('#clearChat').addEventListener('click', () => {
  conversation = [];
  if (!ownerMode) storageRemove(HISTORY_KEY);
  storageRemove(PENDING_KEY);
  document.querySelector('#transcript').replaceChildren();
  for (const url of artifactUrls) URL.revokeObjectURL(url);
  artifactUrls.length = 0;
  mission.classList.add('hidden');
  syncWelcome();
  if (ownerMode) {
    ownerRequest('/api/owner/workspace', { body:{action:'clear'} }).then(() => { ownerRevision = 0; }).catch(() => {});
  } else if (syncToken) syncRequest('clear').catch(() => {});
  setStatus(navigator.onLine ? (ownerMode ? 'Owner workspace ready' : 'Ready to ask') : 'Offline', navigator.onLine ? 'idle' : 'blocked');
});

function billingApiUrl(path) {
  const configuredBase = window.PI_CHAT_API_BASE || document.documentElement.dataset.piChatApiBase || 'https://pi-chat.premchandyadlapati.workers.dev';
  return configuredBase.replace(/\/$/, '') + path;
}
function billingToken() {
  try { return localStorage.getItem(BILLING_TOKEN_KEY) || ''; } catch { return ''; }
}
async function billingStatus() {
  const token = billingToken();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { entitled:false, status:'none' };
  const response = await fetch(billingApiUrl('/api/billing/status'), { headers:{authorization:`Bearer ${token}`} });
  if (!response.ok) return { entitled:false, status:'unknown' };
  const body = await response.json();
  return body?.entitlement || { entitled:false, status:'none' };
}
async function refreshBillingUi() {
  if (!billingAction) return;
  try {
    const configResponse = await fetch(billingApiUrl('/api/billing/config'));
    const config = await configResponse.json();
    if (!configResponse.ok || config.billingReady !== true || !['test','live'].includes(config.billingMode)) { billingAction.hidden = true; return; }
    const entitlement = await billingStatus();
    billingAction.hidden = false;
    billingAction.textContent = entitlement.entitled ? 'Plan active' : 'Upgrade';
    billingAction.disabled = entitlement.entitled === true;
    billingAction.title = entitlement.entitled ? 'Paid access is active for this browser identity.' : 'Open secure Stripe Checkout.';
  } catch { billingAction.hidden = true; }
}
async function startBilling() {
  billingAction.disabled = true;
  const prior = billingAction.textContent;
  billingAction.textContent = 'Opening…';
  try {
    const response = await fetch(billingApiUrl('/api/billing/start'), { method:'POST', headers:{'content-type':'application/json'}, body:'{}' });
    const body = await response.json();
    if (!response.ok || !body.checkoutUrl || !body.customerToken) throw new Error(body.error || 'billing_start_failed');
    try { localStorage.setItem(BILLING_TOKEN_KEY, body.customerToken); } catch {}
    window.location.assign(body.checkoutUrl);
  } catch {
    billingAction.textContent = prior;
    billingAction.disabled = false;
    setStatus('Billing is temporarily unavailable', 'blocked');
  }
}
async function handleBillingReturn() {
  if (typeof URLSearchParams !== 'function') { await refreshBillingUi(); return; }
  const params = new URLSearchParams(window.location.search || '');
  const state = params.get('billing');
  if (!state) { await refreshBillingUi(); return; }
  if (window.history?.replaceState) {
    params.delete('billing'); params.delete('session_id');
    const qs = params.toString();
    window.history.replaceState(null,'',(window.location.pathname||'/')+(qs?'?'+qs:'')+(window.location.hash||''));
  }
  if (state === 'cancelled') { setStatus('Checkout cancelled'); await refreshBillingUi(); return; }
  if (state === 'success') {
    for (let attempt=0; attempt<6; attempt += 1) {
      const entitlement = await billingStatus();
      if (entitlement.entitled) { setStatus('Paid access active'); await refreshBillingUi(); return; }
      await new Promise(resolve => setTimeout(resolve, 900));
    }
    setStatus('Payment received; access verification is still processing', 'working');
    await refreshBillingUi();
  }
}
billingAction?.addEventListener('click', () => { startBilling(); });


function ownerLine(container, label, value, tone='') {
  if (!container) return;
  const p=document.createElement('p');
  if (tone) p.className=tone;
  const strong=document.createElement('strong'); strong.textContent=label+': ';
  p.append(strong, document.createTextNode(String(value ?? 'Unknown')));
  container.append(p);
}

function renderOwnerProgressChart(daily=[]) {
  if (!ownerProgressChart || !ownerChartLegend) return;
  ownerProgressChart.replaceChildren();
  ownerChartLegend.replaceChildren();
  ownerChartTooltip?.classList.add('hidden');
  const rows=(Array.isArray(daily)?daily:[]).filter(r=>r && typeof r.date==='string');
  if (rows.length < 1) return;

  let cumulativeCommits=0, cumulativePassed=0;
  const enriched=rows.map((r,index)=>{
    const commits=Math.max(0,Number(r.commits||0));
    const passed=Math.max(0,Number(r.workflowsPassed||0));
    cumulativeCommits += commits;
    cumulativePassed += passed;
    return {...r,index,commits,passed,cumulativeCommits,cumulativePassed};
  });
  const baseCommits=Math.max(1,enriched[0].cumulativeCommits);
  const basePassed=Math.max(1,enriched[0].cumulativePassed);
  enriched.forEach((r,index)=>{
    r.growthIndex=((r.cumulativeCommits/baseCommits)+(r.cumulativePassed/basePassed))*50;
    r.growthSinceDay1=r.growthIndex-100;
    r.dailyGrowth=index===0 ? 0 : r.growthIndex-enriched[index-1].growthIndex;
  });

  const latest=enriched.at(-1);
  if (ownerGrowthPercent) ownerGrowthPercent.textContent=(latest.growthSinceDay1>=0?'+':'')+latest.growthSinceDay1.toFixed(1)+'%';
  if (ownerDailyGrowth) ownerDailyGrowth.textContent=(latest.dailyGrowth>=0?'+':'')+latest.dailyGrowth.toFixed(1)+' pts';

  const width=360, height=180, left=34, right=12, top=18, bottom=30;
  const innerW=width-left-right, innerH=height-top-bottom;
  const maxGrowth=Math.max(110,...enriched.map(r=>r.growthIndex));
  const minGrowth=Math.min(100,...enriched.map(r=>r.growthIndex));
  const span=Math.max(10,maxGrowth-minGrowth);
  const chartMin=Math.max(0,minGrowth-span*.08), chartMax=maxGrowth+span*.08;
  const ns='http://www.w3.org/2000/svg';
  const make=(tag,attrs={})=>{const el=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));return el;};
  const xAt=i=>left+(enriched.length===1?innerW/2:innerW*i/(enriched.length-1));
  const yAt=value=>top+innerH-(innerH*((value-chartMin)/(chartMax-chartMin)));

  for(let i=0;i<4;i++){
    const y=top+(innerH*i/3);
    ownerProgressChart.append(make('line',{x1:left,y1:y,x2:width-right,y2:y,class:'owner-chart-grid'}));
    const value=chartMax-(chartMax-chartMin)*(i/3);
    const label=make('text',{x:left-5,y:y+3,'text-anchor':'end',class:'owner-chart-label'});
    label.textContent=Math.round(value);
    ownerProgressChart.append(label);
  }
  ownerProgressChart.append(make('line',{x1:left,y1:top,x2:left,y2:height-bottom,class:'owner-chart-axis'}));
  ownerProgressChart.append(make('line',{x1:left,y1:height-bottom,x2:width-right,y2:height-bottom,class:'owner-chart-axis'}));

  const points=enriched.map((r,i)=>[xAt(i),yAt(r.growthIndex)]);
  const poly=make('polyline',{points:points.map(([x,y])=>x+','+y).join(' '),class:'owner-chart-line owner-chart-growth'});
  ownerProgressChart.append(poly);
  points.forEach(([x,y])=>ownerProgressChart.append(make('circle',{cx:x,cy:y,r:3,class:'owner-chart-dot owner-chart-growth'})));

  enriched.forEach((r,i)=>{
    const showLabel=enriched.length<=10 || i===0 || i===enriched.length-1 || i%Math.ceil(enriched.length/7)===0;
    if (!showLabel) return;
    const t=make('text',{x:xAt(i),y:height-8,'text-anchor':'middle',class:'owner-chart-label'});
    t.textContent=r.date.slice(5);
    ownerProgressChart.append(t);
  });

  const guide=make('line',{x1:left,y1:top,x2:left,y2:height-bottom,class:'owner-chart-guide'});
  const focus=make('circle',{cx:left,cy:yAt(enriched[0].growthIndex),r:5,class:'owner-chart-focus'});
  guide.style.display='none'; focus.style.display='none';
  ownerProgressChart.append(guide,focus);

  const showPoint=index=>{
    const r=enriched[Math.max(0,Math.min(enriched.length-1,index))];
    const x=xAt(r.index), y=yAt(r.growthIndex);
    guide.setAttribute('x1',x);guide.setAttribute('x2',x);guide.style.display='';
    focus.setAttribute('cx',x);focus.setAttribute('cy',y);focus.style.display='';
    if (ownerChartTooltip) {
      ownerChartTooltip.replaceChildren();
      const title=document.createElement('strong'); title.textContent=r.date;
      const values=document.createElement('span');
      values.textContent='Growth index '+r.growthIndex.toFixed(1)+' · Since Day 1 '+(r.growthSinceDay1>=0?'+':'')+r.growthSinceDay1.toFixed(1)+'% · Day '+(r.dailyGrowth>=0?'+':'')+r.dailyGrowth.toFixed(1)+' pts · Commits '+r.commits+' · Passed workflows '+r.passed;
      ownerChartTooltip.append(title,values);
      ownerChartTooltip.classList.remove('hidden');
    }
  };
  const pointFromClientX=clientX=>{
    const rect=ownerProgressChart.getBoundingClientRect();
    const svgX=(clientX-rect.left)*(width/Math.max(1,rect.width));
    if(enriched.length===1) return 0;
    return Math.round(((svgX-left)/innerW)*(enriched.length-1));
  };
  ownerProgressChart.onpointerdown=e=>{ownerProgressChart.setPointerCapture?.(e.pointerId);showPoint(pointFromClientX(e.clientX));};
  ownerProgressChart.onpointermove=e=>{if(e.pointerType==='mouse' || ownerProgressChart.hasPointerCapture?.(e.pointerId))showPoint(pointFromClientX(e.clientX));};
  ownerProgressChart.onpointerup=e=>{ownerProgressChart.releasePointerCapture?.(e.pointerId);showPoint(pointFromClientX(e.clientX));};
  ownerProgressChart.onkeydown=e=>{
    const current=Number(ownerProgressChart.dataset.focusIndex||enriched.length-1);
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){
      e.preventDefault();
      const next=Math.max(0,Math.min(enriched.length-1,current+(e.key==='ArrowRight'?1:-1)));
      ownerProgressChart.dataset.focusIndex=String(next);showPoint(next);
    }
  };
  ownerProgressChart.dataset.focusIndex=String(enriched.length-1);

  const legend=document.createElement('span');
  legend.className='owner-chart-growth';
  const key=document.createElement('i');
  legend.append(key,document.createTextNode('Verified engineering growth index'));
  ownerChartLegend.append(legend);
}

async function refreshOwnerCommandCenter() {
  if (!ownerMode || !ownerSession || !ownerCommandCenter) return;
  ownerRefresh.disabled=true;
  try {
    const body=await ownerRequest('/api/owner/dashboard',{method:'GET'});
    const history=body?.history || {};
    const readiness=body?.readiness || {};
    const daily=Array.isArray(history.daily)?history.daily:[];
    const latest=daily.at(-1) || {};
    const totals=history.totals || {};
    const actions=Array.isArray(body?.ownerActions)?body.ownerActions:[];
    const security=body?.security || {};
    ownerCommandCenter.classList.remove('hidden');
    document.body.classList.add('owner-mode');
    ownerPiStatus.textContent = readiness.productionActivationVerified ? 'Production activation verified' : 'Engineering ready; production activation not verified';
    ownerPiStatus.className = readiness.productionActivationVerified ? 'owner-good' : 'owner-warn';
    ownerTeamStatus.textContent = (body?.team?.currentFocus || []).join(' · ') || 'Verified owner workspace active';
    const actionable = actions.filter(x=>!/^No .*action detected/i.test(String(x)));
    ownerBlockers.textContent = String(actionable.length);
    ownerActions.textContent = actionable.length ? `${actionable.length} action(s) — review below` : 'No verified owner action';
    if (ownerSecurityStatus) {
      const layers=[security.originRestricted,security.bearerSessionRequired,security.noStore,security.loginRateLimited].filter(Boolean).length;
      ownerSecurityStatus.textContent = layers >= 4 ? '4 layers active' : `${layers}/4 layers active`;
      ownerSecurityStatus.className = layers >= 4 ? 'owner-good' : 'owner-warn';
    }
    ownerSnapshotNote.textContent = latest.snapshotPartialDay ? 'Latest day is a partial verified snapshot; newer repository activity may exist.' : 'Verified repository/configuration snapshot.';
    ownerHistorySummary.replaceChildren();
    ownerActionList?.replaceChildren();
    if (ownerLastUpdated) ownerLastUpdated.textContent = `Last refreshed ${new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}`;
    if (ownerActionList) {
      if (!actions.length) ownerLine(ownerActionList,'Action','No owner action detected','owner-good');
      else actions.forEach((action,index)=>ownerLine(ownerActionList,`#${index+1}`,action,/No credential/.test(action)?'owner-good':'owner-warn'));
    }
    renderOwnerProgressChart(daily);
    ownerLine(ownerHistorySummary,'Day 1',history.verifiedDay1?.date || 'Unknown');
    ownerLine(ownerHistorySummary,'Commits',totals.commits ?? 'Unknown');
    ownerLine(ownerHistorySummary,'Issues open',totals.issuesOpen ?? totals.currentOpenIssues ?? 'Unknown');
    ownerLine(ownerHistorySummary,'Workflow runs',totals.workflowRuns ?? 'Unknown');
    ownerLine(ownerHistorySummary,'Code volume','Unknown until exhaustive diff collection', 'owner-warn');
    ownerReleaseStatus.replaceChildren();
    ownerLine(ownerReleaseStatus,'Owner auth',readiness.ownerAuthConfigured ? 'Configured' : 'Not configured',readiness.ownerAuthConfigured?'owner-good':'owner-bad');
    ownerLine(ownerReleaseStatus,'Production activation',readiness.productionActivationVerified ? 'Verified' : 'Not verified',readiness.productionActivationVerified?'owner-good':'owner-warn');
    ownerLine(ownerReleaseStatus,'Customer charging',readiness.customerChargingVerified ? 'Verified' : 'Not verified',readiness.customerChargingVerified?'owner-good':'owner-warn');
    ownerPaymentStatus.replaceChildren();
    ownerLine(ownerPaymentStatus,'Billing config',readiness.billingConfigured ? 'Configured' : 'Incomplete',readiness.billingConfigured?'owner-good':'owner-warn');
    ownerLine(ownerPaymentStatus,'Stripe secret',readiness.stripe?.secretConfigured ? 'Configured' : 'Missing');
    ownerLine(ownerPaymentStatus,'Webhook secret',readiness.stripe?.webhookConfigured ? 'Configured' : 'Missing');
    ownerLine(ownerPaymentStatus,'Price ID',readiness.stripe?.priceConfigured ? 'Configured' : 'Missing');
    ownerRecentActivity.replaceChildren();
    const milestones=Array.isArray(history.milestoneExamples)?history.milestoneExamples.slice(-5).reverse():[];
    if (!milestones.length) ownerLine(ownerRecentActivity,'Activity','No verified milestones available');
    for(const item of milestones) ownerLine(ownerRecentActivity,item.date || 'Date',item.message || 'Verified repository activity');
  } catch {
    ownerCommandCenter.classList.remove('hidden');
    document.body.classList.add('owner-mode');
    ownerPiStatus.textContent='Owner dashboard data unavailable';
    ownerPiStatus.className='owner-bad';
    ownerSnapshotNote.textContent='Authenticated owner session is active, but dashboard data could not be loaded.';
  } finally { ownerRefresh.disabled=false; }
}
ownerRefresh?.addEventListener('click',()=>{ refreshOwnerCommandCenter(); });
ownerSignOut?.addEventListener('click',()=>{ signOutOwner(); });

async function loadOwnerWorkspace() {
  const body = await ownerRequest('/api/owner/workspace', { body:{action:'load'} });
  const workspace = body?.workspace;
  applyingRemoteSession = true;
  try {
    ownerMode = true;
    ownerRevision = Number(workspace?.revision || 0);
    conversation = Array.isArray(workspace?.conversation) ? workspace.conversation.filter(t => t && ['user','assistant'].includes(t.role) && typeof t.content === 'string').slice(-20) : [];
    command.value = typeof workspace?.draft === 'string' ? workspace.draft.slice(0,8000) : '';
    renderConversation();
    command.style.height = 'auto';
    command.style.height = Math.min(command.scrollHeight, 140) + 'px';
    ownerAccess.textContent = 'Owner dashboard';
    syncDevice.disabled = true;
    syncDevice.title = 'Owner workspace sync is automatic';
    updateSyncUi('Authenticated owner workspace is active. Changes sync automatically across signed-in devices.');
    setStatus('Owner workspace ready');
    await refreshOwnerCommandCenter();
    ownerCommandCenter?.scrollIntoView({behavior:'smooth',block:'start'});
  } finally { applyingRemoteSession = false; }
}
async function restoreOwnerSession() {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ownerSession)) return false;
  try {
    await ownerRequest('/api/owner/status', { method:'GET' });
    await loadOwnerWorkspace();
    return true;
  } catch {
    ownerSession = '';
    try { sessionStorage.removeItem(OWNER_SESSION_KEY); } catch {}
    return false;
  }
}
async function signInOwner(secret) {
  const response = await fetch(ownerApiUrl('/api/owner/login'), {
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({secret})
  });
  let body={}; try { body=await response.json(); } catch {}
  if (!response.ok || !body.sessionToken) throw new Error(body.error || 'owner_login_failed');
  ownerSession = body.sessionToken;
  try { sessionStorage.setItem(OWNER_SESSION_KEY, ownerSession); } catch {}
  await loadOwnerWorkspace();
}
async function signOutOwner() {
  try { await ownerRequest('/api/owner/logout', { body:{} }); } catch {}
  ownerSession = ''; ownerMode = false; ownerRevision = 0;
  try { sessionStorage.removeItem(OWNER_SESSION_KEY); } catch {}
  ownerAccess.textContent = 'Owner sign in';
  ownerCommandCenter?.classList.add('hidden');
  document.body.classList.remove('owner-mode');
  syncDevice.disabled = false;
  syncDevice.title = '';
  try {
    const saved = JSON.parse(storageGet(HISTORY_KEY) || '[]');
    conversation = Array.isArray(saved) ? saved.filter(t => t && ['user','assistant'].includes(t.role) && typeof t.content === 'string').slice(-20) : [];
  } catch { conversation = []; }
  command.value = storageGet(DRAFT_KEY) || '';
  renderConversation();
  updateSyncUi(syncToken ? 'Private device sync is active.' : '');
  setStatus('Signed out');
}
ownerAccess?.addEventListener('click', async () => {
  if (ownerMode) {
    ownerCommandCenter?.scrollIntoView({behavior:'smooth',block:'start'});
    return;
  }
  ownerLoginError.classList.add('hidden');
  ownerSecret.value = '';
  ownerDialog.showModal();
  ownerSecret.focus();
});
document.querySelector('#ownerCancel')?.addEventListener('click', () => ownerDialog.close());
ownerLoginForm?.addEventListener('submit', async event => {
  event.preventDefault();
  ownerLoginError.classList.add('hidden');
  try {
    await signInOwner(ownerSecret.value);
    ownerSecret.value = '';
    ownerDialog.close();
  } catch (error) {
    ownerLoginError.textContent = error?.message === 'owner_auth_not_configured' ? 'Owner sign-in is not configured on this deployment yet.' : 'Owner sign-in failed.';
    ownerLoginError.classList.remove('hidden');
  }
});

const DOMAIN_RULES = [
  { name: 'business', pattern: /business|market|sales|customer|revenue|export|import|price|profit|investment/i, tasks: ['define_business_goal', 'identify_constraints', 'build_decision_matrix'] },
  { name: 'earth', pattern: /earth|satellite|land|crop|agriculture|map|geospatial|location|farm/i, tasks: ['define_area_of_interest', 'identify_data_sources', 'build_evidence_checklist'] },
  { name: 'engineering', pattern: /build|code|deploy|software|app|github|netlify|feature|fix|test/i, tasks: ['inspect_system', 'change_code', 'run_tests', 'verify_change'] },
  { name: 'research', pattern: /research|compare|find|learn|analyze|study|investigate/i, tasks: ['decompose_question', 'collect_available_evidence', 'compare_findings'] }
];

const CONVERSATIONAL_RULES = [
  { name: 'greeting', pattern: /^(hi|hello|hey|good morning|good afternoon|good evening|namaste)\b[!. ]*$/i },
  { name: 'math', pattern: /^(what is|calculate|solve)\s+[-+*/(). 0-9]+\??$/i },
  { name: 'weather', pattern: /\b(weather|forecast|temperature|rain|snow|wind|humidity)\b/i },
  { name: 'time', pattern: /\b(what time|current time|time is it)\b/i },
  { name: 'conversion', pattern: /\b(convert|conversion)\b/i },
  { name: 'explanation', pattern: /^(what is|what are|who is|why is|how does|explain|define)\b/i }
];

const TASK_LABELS = {
  understand_request: ['Understand the request', 'Identify the conversational intent before choosing a workflow.'],
  respond_or_request_required_data: ['Respond or request data', 'Answer directly when possible; request or retrieve verified data when required.'],
  define_business_goal: ['Define the business goal', 'Clarify the outcome, target user and measurable success condition.'],
  identify_constraints: ['Identify constraints', 'Capture budget, timing, location, resources and other limits.'],
  build_decision_matrix: ['Build a decision matrix', 'Structure the options, trade-offs and evidence needed before a decision.'],
  define_area_of_interest: ['Define the area of interest', 'Pin down the exact land, location or geographic scope.'],
  identify_data_sources: ['Identify evidence sources', 'List the maps, satellite data or other sources required.'],
  build_evidence_checklist: ['Build an evidence checklist', 'Define what must be verified before drawing conclusions.'],
  inspect_system: ['Inspect the system', 'Identify the relevant files, components and current behavior.'],
  change_code: ['Implement the change', 'Apply the smallest safe change that satisfies the objective.'],
  run_tests: ['Run tests', 'Exercise the affected behavior and check for regressions.'],
  verify_change: ['Verify the result', 'Separate confirmed behavior from anything not directly tested.'],
  decompose_question: ['Break down the question', 'Turn the objective into answerable sub-questions.'],
  collect_available_evidence: ['Collect available evidence', 'Gather the evidence needed to support each conclusion.'],
  compare_findings: ['Compare findings', 'Identify agreements, conflicts, gaps and remaining uncertainty.'],
  define_objective: ['Define the objective', 'Turn the request into a concrete outcome.'],
  verify_available_evidence: ['Verify available evidence', 'Identify what can and cannot be established from available evidence.']
};

function localIntent(text) {
  return CONVERSATIONAL_RULES.find(rule => rule.pattern.test(text))?.name || null;
}

function localMath(text) {
  const expression = text.replace(/^(what is|calculate|solve)\s+/i, '').replace(/[?=]+$/g, '').trim();
  if (!/^[0-9+*/().\s-]+$/.test(expression) || !/[0-9]/.test(expression)) return null;
  try {
    const value = Function(`"use strict"; return (${expression})`)();
    return Number.isFinite(value) ? `${expression} = ${value}` : null;
  } catch { return null; }
}

function localResponse(text, intent) {
  if (intent === 'greeting') return { title: 'Hello', message: 'Hi — Krishna is ready. Give me a question or objective and I’ll route it to the right path.' };
  if (intent === 'math') return { title: 'Answer', message: localMath(text) || 'I can calculate that, but I need a valid arithmetic expression.' };
  return null;
}

function planLocal(text) {
  const intent = localIntent(text);
  if (intent) return { route: 'conversation', intent, domains: [intent], tasks: ['understand_request', 'respond_or_request_required_data'] };
  const matched = DOMAIN_RULES.filter(rule => rule.pattern.test(text));
  const domains = matched.length ? matched.map(rule => rule.name) : ['general'];
  const tasks = [...new Set(matched.flatMap(rule => rule.tasks))];
  if (!tasks.length) tasks.push('define_objective', 'identify_constraints', 'verify_available_evidence');
  return { route: 'mission', domains, tasks };
}

function showCustomerResponse(text, response, plan, source) {
  missionTitle.textContent = response.title;
  steps.replaceChildren();
  const step = document.createElement('div');
  step.className = 'step';
  const number = document.createElement('i');
  number.textContent = '01';
  const content = document.createElement('div');
  const answer = document.createElement('strong');
  answer.textContent = response.message;
  const meta = document.createElement('small');
  meta.textContent = source;
  content.append(answer, meta);
  step.append(number, content);
  steps.append(step);
  confidence.textContent = source;
  mission.classList.remove('hidden');
  mission.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function showMission(text, plan, status, source) {
  missionTitle.textContent = text;
  steps.replaceChildren();
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  tasks.forEach((task, index) => {
    const [label, detail] = TASK_LABELS[task] || [String(task || 'planned step').replaceAll('_', ' '), 'Planned step.'];
    const step = document.createElement('div');
    step.className = 'step';
    const number = document.createElement('i');
    number.textContent = String(index + 1).padStart(2, '0');
    const content = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = label;
    const description = document.createElement('small');
    description.textContent = detail;
    content.append(title, description);
    step.append(number, content);
    steps.append(step);
  });
  confidence.textContent = `${status} · ${source}`;
  mission.classList.remove('hidden');
  mission.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function runLocalMission(text, note = 'Local zero-cost mode') {
  const plan = planLocal(text);
  const response = plan.route === 'conversation' ? localResponse(text, plan.intent) : null;
  if (response) {
    showCustomerResponse(text, response, plan, 'PI local');
  } else {
    showCustomerResponse(text, { title: 'PI', message: 'PI’s live answer service is temporarily unavailable. Please try again in a moment.' }, plan, 'PI');
  }
  setStatus('Local reply only', 'limited');
}

function chatApiUrl() {
  const configuredBase = window.PI_CHAT_API_BASE || document.documentElement.dataset.piChatApiBase || 'https://pi-chat.premchandyadlapati.workers.dev';
  const base = configuredBase.replace(/\/$/, '');
  return `${base}/api/chat`;
}

async function runCustomerChat(text, attachment = null) {
  storageSet(PENDING_KEY, text);
  run.disabled = true;
  document.querySelector('#clearChat').disabled = true;
  setStatus('PI working…', 'working');
  const history = historyWindow().map(({ role, content }) => ({ role, content }));
  const userCard = addTranscript('user', text);
  const pending = document.createElement('p');
  pending.className = 'pending-response'; pending.textContent = 'PI is working on your request…';
  pending.setAttribute('role', 'status'); userCard.append(pending);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 65000);
  try {
    const requestInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text, history, ...(attachment ? { attachment } : {}) }), signal: controller.signal };
    let response = await fetch(chatApiUrl(), requestInit);
    if ([502, 503, 504].includes(response.status) && !controller.signal.aborted) {
      await new Promise(resolve => setTimeout(resolve, 700));
      response = await fetch(chatApiUrl(), requestInit);
    }
    let body;
    try { body = await response.json(); }
    catch { body = { ok: false, error: response.ok ? 'invalid_provider_response' : 'chat_provider_server_error' }; }
    const outcome = chatOutcome(response, body);
    const card = addTranscript('assistant', outcome.answer);
    const note = document.createElement('small');
    note.textContent = outcome.note;
    card.append(note);
    for (const artifact of outcome.artifacts) downloadArtifact(artifact, card);
    renderSources(outcome.sources, card);
    if (outcome.remember) { rememberTurn('user', attachment ? `${text}\n[Attached file: ${attachment.name}]` : text); rememberTurn('assistant', outcome.answer, outcome.artifacts, outcome.sources); }
    if (outcome.complete && attachment) clearAttachment();
    if (outcome.restoreDraft) restoreDraft(text);
    mission.classList.add('hidden');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setStatus(outcome.label, outcome.state);
    return outcome.complete;
  } catch (error) {
    const outcome = transportOutcome(error, navigator.onLine);
    addTranscript('assistant', outcome.answer);
    restoreDraft(text);
    setStatus(outcome.label, outcome.state);
    return false;
  } finally { clearTimeout(timer); pending.remove(); storageRemove(PENDING_KEY); document.querySelector('#clearChat').disabled = false; run.disabled = false; }
}

async function runCloudMission(text, attachment = null) {
  const token = ownerToken.value.trim();
  if (!token) {
    await runCustomerChat(text, attachment);
    return;
  }
  run.disabled = true;
  systemStatus.textContent = 'Krishna running…';
  try {
    const response = await fetch('/api/pi', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ objective: text }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'cloud_request_failed');
    if (body.result?.customerResponse) showCustomerResponse(body.plan.objective, body.result.customerResponse, body.plan, 'Cloud PI');
    else showMission(body.plan.objective, body.plan, 'Cloud plan verified', 'Deterministic PI runtime');
    systemStatus.textContent = 'Cloud runtime ready';
  } catch (error) {
    runLocalMission(text, 'Cloud unavailable — automatic fallback');
  } finally { run.disabled = false; }
}

document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => { command.value = button.dataset.command; saveDraft(); command.focus(); }));
run.addEventListener('click', () => {
  const text = command.value.trim();
  if ((!text && !attachedFile) || run.disabled) { command.focus(); return; }
  const attachment = attachedFile;
  const prompt = text || 'Describe and analyze this attachment.';
  command.value = '';
  saveDraft();
  command.style.height = 'auto';
  runCloudMission(prompt, attachment);
});

command.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); run.click(); } });
command.addEventListener('input', () => { saveDraft(); command.style.height = 'auto'; command.style.height = Math.min(command.scrollHeight, 140) + 'px'; });
syncWelcome();
(async () => {
  const restored = await restoreOwnerSession();
  if (!restored) loadSyncedSession();
  await handleBillingReturn();
})();
