import { createHash } from 'node:crypto';
import { evidenceRecord } from '../../evidence.mjs';

const RUN_ID = '40014087452';
const RUN_URL = 'https://github.com/pisolutions9/Pisolutions9/actions/runs/' + RUN_ID;
const RUN_HEAD = 'd6531484095c4bff7f244166f89f6b5edb33609a';
const DIGEST = '1bc96b4f13ac8834a1bbee3999ed14c3fe0dfd7ce7db65aebec4f03ba443ea0f';
const MICRODUCK = '942e58e3aa6dbb28e7037203fff11866122c7567';
const RL = 'b02fdea4902c2b93b7d34a83a6f05da4ececb7d3';

function robot(command) {
  try { return JSON.parse(command?.stdout)?.robot; } catch { return null; }
}
function traceValid(trace) {
  const values = trace?.intervals_ms;
  if (!Array.isArray(values) || values.length < 100 || trace.packets !== values.length + 1 ||
      values.some(x => !Number.isFinite(x) || x <= 0)) return false;
  const ordered = [...values].sort((a, b) => a - b);
  const median = ordered.length % 2 ? ordered[(ordered.length - 1) / 2] :
    (ordered[ordered.length / 2 - 1] + ordered[ordered.length / 2]) / 2;
  const meanHz = 1000 * values.length / values.reduce((a, b) => a + b, 0);
  return Math.abs(trace.median_ms - median) < 0.002 &&
    trace.p95_ms === ordered[Math.floor(0.95 * (ordered.length - 1))] &&
    trace.p99_ms === ordered[Math.floor(0.99 * (ordered.length - 1))] &&
    trace.max_ms === ordered.at(-1) &&
    trace.over_30ms === values.filter(x => x > 30).length &&
    Math.abs(trace.observed_hz - meanHz) < 0.02;
}

export function verifyLoadedMicroduckReport(raw, run) {
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex');
  let report;
  try { report = JSON.parse(raw); } catch { report = {}; }
  const h = report.upstream_health ?? {};
  const f = report.faults ?? {};
  const hashes = report.policy_hashes;
  const names = Array.isArray(hashes) ? hashes.map(x => x.path) : [];
  const baseline = robot(h.baseline);
  const disconnected = robot(h.after_disconnect);
  const reconnected = robot(h.after_reconnect);
  const malformed = robot(h.after_malformed_policy);
  const checks = {
    digest: digest === DIGEST,
    workflow: run?.html_url === RUN_URL && run?.id === Number(RUN_ID) &&
      run?.conclusion === 'success' && run?.event === 'pull_request' &&
      run?.head_sha === RUN_HEAD && report.workflow?.run_id === RUN_ID &&
      report.workflow?.head_sha === RUN_HEAD,
    sources: report.source_commits?.microduck === MICRODUCK && report.source_commits?.microduck_rl === RL,
    policies: Array.isArray(hashes) && hashes.length === 10 && new Set(names).size === 10 &&
      ['alpha_stand.onnx', 'alpha_walking.onnx', 'alpha_sitstand.onnx'].every(x => names.includes(x)) &&
      hashes.every(x => x.bytes > 0 && /^[a-f0-9]{64}$/.test(x.sha256)),
    baseline_trace: traceValid(report.tick_traces?.baseline),
    loaded_trace: traceValid(report.tick_traces?.loaded),
    load: report.load?.definition === 'one Python CPU-bound worker, default Linux scheduler' &&
      report.load?.sample_wall_s >= 5 && report.load?.sample_cpu_s >= 2 &&
      report.load.sample_cpu_s / report.load.sample_wall_s >= 0.7,
    baseline: report.startup?.exit_code === 0 && h.baseline?.exit_code === 0 &&
      baseline?.healthy === true && baseline?.control_loop?.target_hz === 50,
    disconnect: Number.isInteger(f.body_disconnect?.pid) && f.body_disconnect.pid > 0 &&
      /mjlab_microduck\.sim\.body_server/.test(f.body_disconnect?.verified_cmdline ?? '') &&
      f.body_disconnect?.port_closed === true &&
      report.independent_observation?.robotd_alive_after_disconnect === true &&
      h.after_disconnect?.exit_code === 5 && disconnected?.healthy === false &&
      disconnected?.bus?.consecutive_errors > 0,
    reconnect: f.body_reconnect?.new_pid !== f.body_disconnect?.pid &&
      f.body_reconnect?.port_reopened === true && h.after_reconnect?.exit_code === 0 &&
      reconnected?.healthy === true && reconnected?.bus?.consecutive_errors === 0,
    malformed: f.malformed_policy?.sha256 === 'b0e1204240bd7d73a19ceb6c21df8c8b0e3a20285c619eee2840bf426cf64c57' &&
      f.malformed_policy?.load_attempt?.exit_code === 5 &&
      /tensor shape is output:.*expected/.test(f.malformed_policy?.load_attempt?.stderr ?? '') &&
      h.after_malformed_policy?.exit_code === 0 && malformed?.healthy === true,
    cleanup: report.cleanup?.exit_code === 0 && Array.isArray(report.blockers) && report.blockers.length === 0,
  };
  const passed = Object.values(checks).every(Boolean);
  return Object.freeze({
    passed, digest, checks: Object.freeze(checks),
    evidence: evidenceRecord({
      source: RUN_URL,
      claim: 'Official headless Microduck simulation sustained external 50 Hz body-read pacing under one CPU worker and recovered from injected body and policy faults.',
      confidence: passed ? 'verified' : 'unknown',
      limitations: [
        'Simulation only; no physical motor, power, or hardware safety evidence.',
        'The packet capture was summarized in the raw report; its pcap was not retained.',
        'One loaded run does not establish performance under other load shapes or on hardware.',
      ],
    }),
  });
}
