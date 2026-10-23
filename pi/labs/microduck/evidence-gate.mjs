import { evidenceRecord } from '../../evidence.mjs';

const MICRODUCK = '942e58e3aa6dbb28e7037203fff11866122c7567';
const RL = 'b02fdea4902c2b93b7d34a83a6f05da4ececb7d3';
const RUN = 'https://github.com/pisolutions9/Pisolutions9/actions/runs/40010913525';
const BAD_POLICY = 'b0e1204240bd7d73a19ceb6c21df8c8b0e3a20285c619eee2840bf426cf64c57';

function health(command) {
  try { return JSON.parse(command?.stdout)?.robot; } catch { return null; }
}

// Attestation must come from a separate workflow API read, never from the report itself.
export function verifyMicroduckReport(report, attestation) {
  const h = report?.upstream_health ?? {};
  const o = report?.independent_observation ?? {};
  const f = report?.faults ?? {};
  const baseline = health(h.baseline);
  const disconnected = health(h.after_disconnect);
  const reconnected = health(h.after_reconnect);
  const malformed = health(h.after_malformed_policy);
  const rate = o.body_rate;
  const checks = {
    external_run: report?.workflow_run === RUN && attestation?.url === RUN && attestation?.conclusion === 'success' && attestation?.event === 'pull_request' && attestation?.head_sha === attestation?.expected_head_sha && /^[a-f0-9]{40}$/.test(attestation?.head_sha ?? ''),
    pinned_sources: report?.source_commits?.microduck === MICRODUCK && report?.source_commits?.microduck_rl === RL,
    no_blockers: Array.isArray(report?.blockers) && report.blockers.length === 0,
    baseline: report?.startup?.exit_code === 0 && h.baseline?.exit_code === 0 && baseline?.healthy === true && baseline?.control_loop?.target_hz === 50 && baseline?.control_loop?.ticks > 0 && baseline?.control_loop?.missed === 0,
    body_pacing: o.body_port_open_after_start === true && rate?.hello === '{"protocol": 1}' && rate?.sim_delta_s >= 3 && rate?.wall_delta_s > 0 && Math.abs(rate.sim_delta_s / rate.wall_delta_s - rate.sim_per_wall) < 0.001 && rate.sim_per_wall >= 0.95 && rate.sim_per_wall <= 1.05,
    disconnect: Number.isInteger(f.body_disconnect?.pid) && f.body_disconnect.pid > 0 && /mjlab_microduck\.sim\.body_server/.test(f.body_disconnect?.verified_cmdline ?? '') && f.body_disconnect?.port_closed === true && o.robotd_alive_after_disconnect === true && h.after_disconnect?.exit_code === 5 && disconnected?.healthy === false && disconnected?.bus?.consecutive_errors > 0,
    reconnect: Number.isInteger(f.body_reconnect?.new_pid) && f.body_reconnect.new_pid > 0 && f.body_reconnect.new_pid !== f.body_disconnect?.pid && f.body_reconnect?.port_reopened === true && h.after_reconnect?.exit_code === 0 && reconnected?.healthy === true && reconnected?.bus?.consecutive_errors === 0,
    malformed_policy: f.malformed_policy?.sha256 === BAD_POLICY && f.malformed_policy?.fixture === 'duck-control/tests/fixtures/bad_action_count.onnx' && f.malformed_policy?.load_attempt?.exit_code === 5 && /tensor shape is output:.*expected/.test(f.malformed_policy?.load_attempt?.stderr ?? '') && h.after_malformed_policy?.exit_code === 0 && malformed?.healthy === true,
    cleanup: report?.cleanup?.exit_code === 0,
  };
  const passed = Object.values(checks).every(Boolean);
  return Object.freeze({
    passed,
    checks: Object.freeze(checks),
    evidence: evidenceRecord({
      source: RUN,
      claim: 'Pinned official Microduck headless simulation completed startup, pacing, body-disconnect recovery, and malformed-policy rejection checks.',
      confidence: passed ? 'verified' : 'unknown',
      limitations: [
        'Simulation only; no physical driver, actuator, power, or hardware safety evidence.',
        '50 Hz control-loop timing is the upstream runtime self-report; independent measurement covers body pacing only.',
        'Official downloaded policy file hashes were not recorded; one run does not establish repeatability.',
      ],
    }),
  });
}
