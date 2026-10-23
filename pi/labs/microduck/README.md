# PI Labs Microduck experiment 001

Status: **CPU smoke test and headless runtime fault probes verified on a public Linux runner** (2026-10-23).

This isolated lab adds no route, tool permission, production dependency, deployment, or robot command to PI. It follows PI's evidence and verification contracts: a passing local check is evidence only for the boundary it actually exercised.

## Source and integration decision

- PI repository baseline: `pisolutions9/Pisolutions9` commit `13c0c943cf75ddbf61fc568971426610e61e1985`. `pi/README.md` defines replaceable tools, evidence provenance, and a verifier. `PI_V1_VERIFICATION_STANDARD.md` requires direct and independent evidence for each boundary. This experiment belongs under `pi/labs/`, away from the customer and owner runtime.
- Official [microduck](https://github.com/pollen-robotics/microduck) holds the Rust 50 Hz onboard control loop. Its [simulation guide](https://github.com/pollen-robotics/microduck/blob/main/docs/robot/simulation.md) says `scripts/duck-sim` drives real daemons against a MuJoCo body supplied by the RL repository. It explicitly excludes physical driver coverage.
- Official [microduck_rl](https://github.com/pollen-robotics/microduck_rl) holds MJCF models, training tasks, policy inference, and ONNX export. The 61 observation / 14 action contract and 50 Hz policy rate come from its README. Source tested: `develop` commit `b02fdea4902c2b93b7d34a83a6f05da4ececb7d3`; `src/mjlab_microduck/robot/microduck/scene_walk.xml` with its included model and assets.
- The initial CPU smoke used no policy, published model, hardware, account, secret, paid compute, or remote job. The later headless runtime run used the official public v8 policy set on a standard public Linux runner.

## Reproduce

Use Python with `mujoco==3.3.4`, and an official checkout at the commit above. On a machine with Python and MuJoCo available:

```sh
python pi/labs/microduck/experiment001.py --fault-only
python pi/labs/microduck/experiment001.py ../microduck_rl/src/mjlab_microduck/robot/microduck/scene_walk.xml --ticks 250
```

The second command resolves the scene's included XML and mesh assets from the upstream checkout. It resets to the official `STAND` keyframe, holds the keyframe's fixed actuator targets, steps MuJoCo at its 2 ms timestep, and samples every 20 ms for five simulated seconds. It validates finite state and checks the independent input gate with six injected faults. The fault-only command uses only Python's standard library.

## Observed evidence

The machine used Windows, Python 3.13.5, MuJoCo 3.3.4, and the exact upstream model hash `61cc5af86fc56894ad28e6a35634f93d16dda259eedd118e2980b663037efa6d`. The recorded output is in [`experiment001-result.json`](experiment001-result.json).

| Measure | Observed |
|---|---:|
| Compiled model | 21 positions, 20 velocities, 14 actuators |
| CPU run | 250/250 finite ticks; five simulated seconds; 0.206 wall seconds |
| Fixed-control motion | minimum base height -0.110884 m; x drift 0.168137 m |
| Boundary cases | 7/7 expected classifications; 0 false accepts; 0 false rejects |

The injected cases were short observation, short action, 41 ms stale sample, NaN observation, infinite action, and NaN simulator state. These check the **independent lab gate**, not the upstream runtime's fault handling. The fixed-control body lost its standing pose, so this run demonstrates that the model compiles and advances with finite state. It does **not** demonstrate balance, gait quality, policy safety, or hardware behavior. Wall time is machine specific.

## Headless runtime follow-up (public Linux runner)

The [gated workflow run](https://github.com/pisolutions9/Pisolutions9/actions/runs/40010913525) used a standard Ubuntu runner for this public repository, with read-only repository permissions, no secret inputs, no artifact upload, and no paid runner. GitHub [states standard hosted runners are free for public repositories](https://docs.github.com/en/billing/concepts/product-billing/github-actions). The workflow fetched official `microduck` commit `942e58e3aa6dbb28e7037203fff11866122c7567` and `microduck_rl` commit `b02fdea4902c2b93b7d34a83a6f05da4ececb7d3`, installed the RL environment, and ran official `scripts/duck-sim` with `DUCK_SIM_VIEWER=0`. Its own seed script downloaded the public official policy set pinned as `v8`; no account login or custom policy was used. The exact policy file hashes were not recorded, so that part of provenance remains a limit.

Raw command outputs and the independent observations are retained in [`runtime_probe-result.json`](runtime_probe-result.json). The upstream health responses are stored under `upstream_health`; separate TCP and process observations are under `independent_observation` and `faults`. The workflow's green status is backed by 11 explicit checks in `verification`, all true, with an empty blocker list and clean shutdown.

| Boundary | Empirical result |
|---|---|
| Startup | Official script exited 0, stood the duck up, and reported trunk 0.116 m and gravity z -1.000. Baseline health was true. |
| Control timing | Runtime reported target 50 Hz, achieved 50.0282 Hz at baseline with 313 ticks and zero missed. An independent body-protocol sample advanced 3.0000 simulated seconds in 3.0003 wall seconds (0.9999×). |
| Disconnected body | Observer verified the body PID's command line, sent SIGTERM, and observed TCP port closure. `robotd` stayed alive; health became false with 114 consecutive bus read failures and exit code 5. |
| Reconnected body | Restarted only the body process. TCP reopened, bus errors returned to zero, and health returned to true with 49.9658 Hz reported and exit code 0. |
| Malformed ONNX | Official `bad_action_count.onnx` fixture (SHA-256 `b0e1204240bd7d73a19ceb6c21df8c8b0e3a20285c619eee2840bf426cf64c57`) was rejected with exit code 5 and a tensor output shape error; health remained true. |

Reproduce from the branch by adding the `run-microduck-lab-001` label to PR #219 (the [workflow](../../../.github/workflows/microduck-lab-001.yml) runs only on that label), or on a no-cost Linux host with Python 3.12, Rust, and `uv`: fetch the two pinned commits above; run `UV_HTTP_TIMEOUT=600 uv sync --python 3.12` in `microduck_rl`; then run `python pi/labs/microduck/runtime_probe.py <microduck-checkout> <microduck_rl-checkout> /tmp/duck-sim-exp001`. The probe calls the official headless script, captures raw health and independent observations, injects both faults, and cleans up.

## Remaining gates

1. **Physical behavior — not verified.** No hardware was purchased or connected. The official simulator excludes the motor bus, hardware encoder, BLE, camera ISP, NPU, and power effects.
2. **Policy provenance — partly verified.** The run used the upstream script's public v8 set and demonstrated a standing policy, but the downloaded ONNX file hashes were not recorded. The malformed test fixture hash is recorded.
3. **External loop timing — not verified.** The 50 Hz figure is the runtime's own health report. The independent 0.9999× body rate checks simulation pacing, not each control tick. One successful run does not establish repeatability or performance under load.

No PI production adapter, deployment, merge, or robot command was made. A future adapter must treat this lab report as untrusted evidence and require independent verification before claiming a PI mission outcome is verified.

## PI evidence gate (next integration step)

`evidence-gate.mjs` maps the raw runtime report into PI's `evidenceRecord` shape without changing PI's production verifier. It recomputes nine checks from raw command output, body TCP/process observations, pinned source commits, and a separately obtained GitHub Actions run record. It deliberately ignores the report's own `verification.passed` field. Missing or altered observations produce `confidence: unknown`. The only verified claim is the bounded **headless simulation result**.

Reproduce the local verification with Node 20 or later:

```sh
node pi/labs/microduck/evidence-gate-test.mjs
```

The test reads the committed raw report and a snapshot of the workflow metadata (run 40010913525, successful pull request event, head `c3e6d4fe7b1ac1107680f2abb7edafd48620eee5`). For an actual PI ingestion, obtain that metadata again through GitHub's workflow-run API and pass it separately to `verifyMicroduckReport(report, attestation)`. The local test is a deterministic contract test; it is not a fresh simulator run or a live GitHub attestation. Recorded Node 24.22.1 result on 2026-10-23: original accepted; five mutations rejected (missing independent observations, body port left open, malformed policy accepted, failed workflow, wrong workflow commit).

The run metadata proves the referenced workflow completed successfully; the committed raw JSON was added later and has no signed or content-addressed link to the job log. This gate detects inconsistent fields, not a determined author rewriting every field. It must not be used to certify physical robot operation or to complete a PI mission.

## Loaded headless rerun and digest binding (2026-10-23)

The [scoped Linux workflow run](https://github.com/pisolutions9/Pisolutions9/actions/runs/40014087452) checked out branch head `d6531484095c4bff7f244166f89f6b5edb33609a` and the same two pinned official upstream commits. The job completed successfully on a standard public Ubuntu runner. The probe wrote [raw JSON](runtime_probe-result-loaded.json), and the job log printed its SHA-256: `1bc96b4f13ac8834a1bbee3999ed14c3fe0dfd7ce7db65aebec4f03ba443ea0f`. The committed file was read back and its bytes match that digest. Its `workflow.run_id` and `workflow.head_sha` also identify the run and tested branch head. The digest is in the job log, so a later edit to the committed result is detectable. This is a run-to-report binding, not a signature or physical-device attestation.

The official seed script downloaded ten public v8 ONNX files. The raw report lists each relative filename, byte count, and SHA-256, including the stand, walk, sitstand, ground-pick, kick, roller, and roulade policies. It also retains the malformed fixture hash separately. No credentials were used.

An external `tcpdump` capture on loopback observed JSON `read` requests sent to the simulated body. The probe recorded every inter-request interval in the raw JSON and recomputed summaries independently of `robotctl`:

| Capture | Read packets | Observed rate | Median interval | p95 | p99 | Max | Intervals >30 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| Baseline, six seconds | 309 | 49.995 Hz | 19.999 ms | 20.763 ms | 20.891 ms | 21.006 ms | 0 |
| One CPU-bound worker, six seconds | 307 | 50.001 Hz | 19.907 ms | 20.852 ms | 20.925 ms | 20.977 ms | 0 |

The load was one Python busy-loop worker under the default Linux scheduler. It consumed 6.51 CPU seconds during a 6.52-second sample; the worker remained active through body disconnect/reconnect and malformed-policy injection. During that load, the verified body PID was terminated, the port closed, `robotd` remained alive, upstream health became false with bus read errors, restarting only the body reopened the port and restored health, and the malformed ONNX fixture was rejected with exit code 5 while health stayed true. The runner's 14 probe checks passed, and the independently recomputed [loaded evidence gate](evidence-gate-loaded.mjs) passed its 12 checks. This is one observed run under one defined CPU load, not a claim about broader load tolerance.

Reproduce locally with the pinned upstream checkouts and dependencies described above:

```sh
python pi/labs/microduck/runtime_probe_test.py
node pi/labs/microduck/evidence-gate-loaded-test.mjs
python pi/labs/microduck/runtime_probe.py <microduck-checkout> <microduck_rl-checkout> /tmp/duck-sim-exp001
sha256sum runtime_probe-result.json
```

The full runner setup and no-cost scope are in [`microduck-lab-001.yml`](../../../.github/workflows/microduck-lab-001.yml). The probe needs Linux, `tcpdump`, passwordless runner `sudo`, Python 3.12, the RL environment, and Rust for the official runtime build. The deterministic parser tests passed 2/2 on Python 3.13.5; the loaded evidence test passed on Node 24.22.1, rejecting a failed workflow and altered interval trace. The workflow metadata was fetched independently through GitHub's run API when interpreting the result.

## Remaining gates

1. **Packet-source preservation — not verified.** The loopback pcap was summarized into raw intervals but was not retained as an artifact. A separate reviewer can recompute the statistics from those intervals, but cannot replay the original packets.
2. **Other loads and repeatability — not verified.** A single CPU worker for one run does not test memory pressure, multiple workers, long duration, or run-to-run variation.
3. **Physical behavior — not verified.** The simulator omits real motor bus timing, encoders, power, and safety response. No hardware was purchased or connected.
4. **PI production use — not approved.** The lab evidence gate is isolated; no production adapter, mission completion, deployment, or merge was made.
