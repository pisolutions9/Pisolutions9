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
function saveDraft() { try { sessionStorage.setItem(DRAFT_KEY, command.value); } catch {} }
function restoreDraft(text) {
  // Preserve any new text the owner typed while the previous request was running.
  if (!command.value.trim()) command.value = text;
  saveDraft();
  command.style.height = 'auto';
  command.style.height = Math.min(command.scrollHeight, 140) + 'px';
}
try { command.value = sessionStorage.getItem(DRAFT_KEY) || sessionStorage.getItem(PENDING_KEY) || ''; } catch {}
setStatus(navigator.onLine ? 'Ready to ask' : 'Offline', navigator.onLine ? 'idle' : 'blocked');
window.addEventListener('offline', () => setStatus('Offline', 'blocked'));
window.addEventListener('online', () => { if (!run.disabled) setStatus('Connection restored'); });


const HISTORY_KEY = 'pi-v1-conversation';
let conversation = [];
const artifactUrls = [];
try { const saved = JSON.parse(sessionStorage.getItem(HISTORY_KEY) || '[]'); if (Array.isArray(saved)) conversation = saved.filter(t => t && ['user','assistant'].includes(t.role) && typeof t.content === 'string').slice(-20); } catch {}
function historyWindow() {
  const result = []; let size = 0;
  for (const turn of [...conversation].reverse()) { if (turn.content.length > 12000 || size + turn.content.length > 30000) break; result.unshift(turn); size += turn.content.length; }
  return result.slice(-20);
}
function rememberTurn(role, content, artifacts = []) {
  const savedArtifacts = artifacts.filter(isDownloadableArtifact).slice(0, 1).map(({ filename, mimeType, content }) => ({ filename, mimeType, content }));
  conversation.push({ role, content, ...(savedArtifacts.length ? { artifacts: savedArtifacts } : {}) }); conversation = historyWindow();
  try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(conversation)); } catch {}
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
for (const turn of conversation) {
  const card = addTranscript(turn.role, turn.content);
  if (turn.role === 'assistant' && Array.isArray(turn.artifacts)) for (const artifact of turn.artifacts.slice(0, 1)) downloadArtifact(artifact, card);
}
document.querySelector('#clearChat').addEventListener('click', () => { conversation = []; try { sessionStorage.removeItem(HISTORY_KEY); sessionStorage.removeItem(PENDING_KEY); } catch {} document.querySelector('#transcript').replaceChildren(); for (const url of artifactUrls) URL.revokeObjectURL(url); artifactUrls.length = 0; mission.classList.add('hidden'); syncWelcome(); setStatus(navigator.onLine ? 'Ready to ask' : 'Offline', navigator.onLine ? 'idle' : 'blocked'); });

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
  try { sessionStorage.setItem(PENDING_KEY, text); } catch {}
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
    const response = await fetch(chatApiUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text, history, ...(attachment ? { attachment } : {}) }), signal: controller.signal });
    const body = await response.json();
    const outcome = chatOutcome(response, body);
    const card = addTranscript('assistant', outcome.answer);
    const note = document.createElement('small');
    note.textContent = outcome.note;
    card.append(note);
    for (const artifact of outcome.artifacts) downloadArtifact(artifact, card);
    renderSources(outcome.sources, card);
    if (outcome.remember) { rememberTurn('user', attachment ? `${text}\n[Attached file: ${attachment.name}]` : text); rememberTurn('assistant', outcome.answer, outcome.artifacts); }
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
  } finally { clearTimeout(timer); pending.remove(); try { sessionStorage.removeItem(PENDING_KEY); } catch {} document.querySelector('#clearChat').disabled = false; run.disabled = false; }
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
