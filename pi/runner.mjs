import { createRuntime } from './runtime.mjs';
import { createFileStateAdapter } from './state-file.mjs';
import { planNoGpt, executeNoGptPlan } from './no-gpt-engine.mjs';
import { createOpenAIResponsesProvider, createModelProviderAdapters, createConfiguredModelProvider } from './model-adapters.mjs';
import { createModelRouter } from './model-router.mjs';
import { createPersonalAIV2 } from './personal-ai-v2.mjs';

const enabled = process.env.PI_AUTONOMOUS_ENABLED !== 'false';
const objective = process.env.PI_OBJECTIVE || 'Run a safe PI runtime health cycle';
const statePath = String(process.env.PI_STATE_FILE_PATH || '').trim();
const parsedMaxCycles = Number(process.env.PI_MAX_CYCLES || 3);
const maxCycles = Number.isInteger(parsedMaxCycles) && parsedMaxCycles > 0 ? Math.min(parsedMaxCycles, 10) : 3;
const personalAI = createPersonalAIV2();

// Zero-cost first: deterministic PI is the default intelligence path.
// Paid model providers are optional upgrades and never a core dependency.
const deterministic = createConfiguredModelProvider({
  name: 'deterministic',
  capabilities: ['reasoning', 'local-execution'],
  run: async input => executeNoGptPlan(planNoGpt(input?.objective || objective))
});
const openai = process.env.OPENAI_API_KEY ? createOpenAIResponsesProvider() : null;
const adapters = createModelProviderAdapters([deterministic, openai]);
const modelRouter = createModelRouter({ adapters, fallbackProviders: ['deterministic', 'openai'] });
const state = statePath ? createFileStateAdapter({ filePath: statePath }) : undefined;

const runtime = createRuntime({
  ...(state ? { state } : {}),
  execute: async mission => {
    const recalled = personalAI.recall(mission.objective);
    const routed = await modelRouter.run({ objective: mission.objective, missionId: mission.id, memory: recalled });
    if (!routed.ok) {
      const error = new Error(routed.reason || 'intelligence_providers_failed');
      error.code = routed.reason === 'all_model_providers_failed' ? 'provider_unavailable' : routed.reason;
      throw error;
    }
    return {
      ...routed.value,
      personalAI: personalAI.snapshot(),
      evidence: [
        ...(routed.value.evidence || []),
        { source: `model-router:${routed.provider}`, claim: JSON.stringify({ attempts: routed.attempts }) },
        { source: 'personal-ai-v2', claim: JSON.stringify({ recalledMemoryCount: recalled.length, stack: personalAI.snapshot() }) }
      ]
    };
  },
  alternatives: [
    { name: 'deterministic-pi', safe: true, execute: async mission => executeNoGptPlan(planNoGpt(mission.objective)) }
  ]
});

if (!enabled) {
  console.log(JSON.stringify({ status: 'paused', mode: 'zero-cost-first', maxCycles, providers: modelRouter.available(), state: statePath ? 'file' : 'memory', personalAI: personalAI.snapshot(), truth: 'verified' }, null, 2));
  process.exit(0);
}

// A scheduled autonomous invocation is a distinct run. Preserve idempotency for
// retries of the same GitHub Actions run, while preventing later scheduled runs
// from reusing an already-completed mission and going immediately idle.
const resumed = state ? await runtime.resumeUnfinished() : { resumed: 0, missionIds: [] };
const runIdentity = String(process.env.GITHUB_RUN_ID || process.env.PI_RUN_ID || Date.now());
let mission = null;
if (resumed.resumed === 0) {
  mission = await runtime.submit(objective, { idempotencyKey: `local-cycle:${objective}:${runIdentity}` });
}
const outcome = await runtime.runCycles({ maxCycles });
console.log(JSON.stringify({ mode: 'zero-cost-first', providers: modelRouter.available(), state: statePath ? 'file' : 'memory', maxCycles, resumed, missionId: mission?.id || resumed.missionIds[0] || null, ...outcome }, null, 2));
if (outcome.status !== 'completed') process.exit(1);