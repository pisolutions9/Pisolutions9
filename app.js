const command = document.querySelector('#command');
const mission = document.querySelector('#mission');
const missionTitle = document.querySelector('#missionTitle');
const steps = document.querySelector('#steps');
const confidence = document.querySelector('#confidence');
const run = document.querySelector('#run');
const ownerToken = document.querySelector('#ownerToken');
const systemStatus = document.querySelector('#systemStatus');

const DOMAIN_RULES = [
  { name: 'business', pattern: /business|market|sales|customer|revenue|export|import|price|profit|investment/i, tasks: ['define_business_goal', 'identify_constraints', 'build_decision_matrix'] },
  { name: 'earth', pattern: /earth|satellite|land|crop|agriculture|map|geospatial|location|farm/i, tasks: ['define_area_of_interest', 'identify_data_sources', 'build_evidence_checklist'] },
  { name: 'engineering', pattern: /build|code|deploy|software|app|github|netlify|feature|fix|test/i, tasks: ['inspect_system', 'change_code', 'run_tests', 'verify_change'] },
  { name: 'research', pattern: /research|compare|find|learn|analyze|study|investigate/i, tasks: ['decompose_question', 'collect_available_evidence', 'compare_findings'] }
];

const TASK_LABELS = {
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

function planLocal(text) {
  const matched = DOMAIN_RULES.filter(rule => rule.pattern.test(text));
  const domains = matched.length ? matched.map(rule => rule.name) : ['general'];
  const tasks = [...new Set(matched.flatMap(rule => rule.tasks))];
  if (!tasks.length) tasks.push('define_objective', 'identify_constraints', 'verify_available_evidence');
  return { domains, tasks };
}

function showMission(text, plan, status, source) {
  missionTitle.textContent = text;
  steps.innerHTML = plan.tasks.map((task, i) => {
    const [label, detail] = TASK_LABELS[task] || [task.replaceAll('_', ' '), 'Planned step.'];
    return `<div class="step"><i>${String(i + 1).padStart(2, '0')}</i><div><strong>${label}</strong><small>${detail}</small></div></div>`;
  }).join('');
  confidence.textContent = `${status} · ${source} · ${plan.domains.join(' · ')}`;
  mission.classList.remove('hidden');
  mission.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function runLocalMission(text, note = 'Local zero-cost mode') {
  const plan = planLocal(text);
  showMission(text, plan, note, 'No external action claimed');
  systemStatus.textContent = 'Local PI ready';
}

async function runCloudMission(text) {
  const token = ownerToken.value.trim();
  if (!token) {
    runLocalMission(text);
    return;
  }

  run.disabled = true;
  systemStatus.textContent = 'Krishna running…';
  try {
    const response = await fetch('/api/pi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ objective: text })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'cloud_request_failed');
    showMission(body.plan.objective, body.plan, 'Cloud plan verified', 'Deterministic PI runtime');
    systemStatus.textContent = 'Cloud runtime ready';
  } catch (error) {
    runLocalMission(text, 'Cloud unavailable — automatic fallback');
  } finally {
    run.disabled = false;
  }
}

document.querySelectorAll('[data-command]').forEach(button => {
  button.addEventListener('click', () => { command.value = button.dataset.command; command.focus(); });
});

run.addEventListener('click', () => {
  const text = command.value.trim() || 'Build the next PI capability';
  runCloudMission(text);
});
