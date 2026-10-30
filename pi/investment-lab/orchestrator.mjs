// PI Investment Lab — Krishna mission orchestration.
// Krishna sequences bounded specialists; it never calls the broker directly and never
// grants itself execution authority. Each step is traced with the existing pi.trace.v1.

import { createExecutionTrace, appendTrace, traceSummary } from '../../worker/src/execution-trace.mjs';
import { researchAgent, quantAgent, riskAgent, simulationAgent, verificationAgent, reportingAgent, AGENT_ROLES } from './agents.mjs';
import { EXECUTION_STATUS } from './execution-gate.mjs';

export async function runInvestmentMission({
  gateway,
  provenance,
  objective = 'Inspect the account read-only, analyse risk, and simulate proposed trades.',
  constraints = {},
  missionId = `lab_${Date.now()}`,
  now = () => Date.now()
} = {}) {
  if (!['synthetic-fixture', 'live-robinhood-mcp'].includes(provenance)) throw new Error('provenance_required');
  const trace = createExecutionTrace({ runId: missionId, now: now() });
  const base = { missionId, objective, constraints: { ...constraints } };
  const step = async (name, run) => {
    const started = now();
    const out = await run();
    appendTrace(trace, { type: 'specialist', component: `${name}:${AGENT_ROLES[name]}`, status: out.status === 'ok' ? 'success' : 'failure', latencyMs: now() - started, data: { truthLevel: out.truthLevel, failureClass: out.failureClass, problems: out.problems } }, { now: now() });
    return out;
  };

  const discovery = gateway.discovery() || await gateway.connect();
  appendTrace(trace, { type: 'discovery', component: 'gateway:Durga', status: 'success', data: { tools: discovery.tools.length, routes: discovery.routes } }, { now: now() });

  const research = await step('research', () => researchAgent({ ...base, context: {} }, { gateway }));
  if (research.status !== 'ok') {
    return { ok: false, stoppedAt: 'research', research, discovery, trace: traceSummary(trace), executionStatus: EXECUTION_STATUS };
  }
  const dataset = research.data;
  const quant = await step('quant', () => quantAgent({ ...base, context: { dataset } }));
  const risk = await step('risk', () => riskAgent({ ...base, context: { dataset, quant: quant.data } }));
  const simulation = await step('simulation', () => simulationAgent({ ...base, context: { dataset, risk: risk.data } }, { now }));
  const verification = await step('verification', () => verificationAgent({ ...base, context: { dataset, quant: quant.data, simulation: simulation.data, discovery } }, { gateway, now }));
  const audit = gateway.auditLog();
  const report = await step('reporting', () => reportingAgent({ ...base, context: { provenance, discovery, dataset, research, quant, risk, simulation, verification, audit, generatedAt: new Date(now()).toISOString() } }));

  return {
    ok: verification.status === 'ok',
    missionId,
    provenance,
    executionStatus: EXECUTION_STATUS,
    discovery,
    research, quant, risk, simulation, verification,
    report: report.result,
    audit,
    trace: traceSummary(trace)
  };
}
