# PI Labs Microduck experiment 001

Status: **limited CPU smoke test verified; policy and runtime integration not verified** (2026-10-23).

This isolated lab adds no route, tool permission, production dependency, deployment, or robot command to PI. It follows PI's evidence and verification contracts: a passing local check is evidence only for the boundary it actually exercised.

## Source and integration decision

- PI repository baseline: `pisolutions9/Pisolutions9` commit `13c0c943cf75ddbf61fc568971426610e61e1985`. `pi/README.md` defines replaceable tools, evidence provenance, and a verifier. `PI_V1_VERIFICATION_STANDARD.md` requires direct and independent evidence for each boundary. This experiment belongs under `pi/labs/`, away from the customer and owner runtime.
- Official [microduck](https://github.com/pollen-robotics/microduck) holds the Rust 50 Hz onboard control loop. Its [simulation guide](https://github.com/pollen-robotics/microduck/blob/main/docs/robot/simulation.md) says `scripts/duck-sim` drives real daemons against a MuJoCo body supplied by the RL repository. It explicitly excludes physical driver coverage.
- Official [microduck_rl](https://github.com/pollen-robotics/microduck_rl) holds MJCF models, training tasks, policy inference, and ONNX export. The 61 observation / 14 action contract and 50 Hz policy rate come from its README. Source tested: `develop` commit `b02fdea4902c2b93b7d34a83a6f05da4ececb7d3`; `src/mjlab_microduck/robot/microduck/scene_walk.xml` with its included model and assets.
- No policy, published model, hardware, account, secret, paid compute, or remote job was used.

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

## Remaining gates

1. **Policy in CPU MuJoCo — not verified.** A compatible exported ONNX policy was not selected or loaded. The official inference path also needs the RL project's pinned Python 3.12 environment and dependencies.
2. **Onboard runtime against simulated body — blocked locally.** `scripts/duck-sim` needs the Rust daemon build, the RL environment, and platform support. This Windows host had no `cargo` or `uv` command available, so that integration was not run.
3. **Physical behavior — not verified.** This experiment intentionally made no hardware purchase or robot connection. Driver, encoder, BLE, camera, NPU, and power effects remain outside the simulation's evidence boundary.

Next work, if a suitable no-cost Linux host and already available ONNX policy are provided, is to run upstream headless `duck-sim`, collect health and 50 Hz timing, and inject a disconnected body and malformed policy artifact while keeping PI's evidence gate separate. Any future PI adapter should ingest recorded results as untrusted lab evidence and require independent verification before a `VERIFIED` mission outcome.

