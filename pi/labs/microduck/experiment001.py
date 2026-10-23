"""CPU-only Microduck MJCF smoke test and independent input fault checks.

This does not load a learned policy or exercise the onboard Rust daemons.
Run against an unmodified checkout of pollen-robotics/microduck_rl.
"""

import argparse
import hashlib
import json
import math
import time
from pathlib import Path


OBS_DIM = 61
ACTION_DIM = 14
CONTROL_HZ = 50


def validate_boundary(observation, action, state, age_ms):
    if len(observation) != OBS_DIM:
        return "observation_dimension"
    if len(action) != ACTION_DIM:
        return "action_dimension"
    if not math.isfinite(age_ms) or age_ms < 0 or age_ms > 40:
        return "stale_observation"
    if not all(math.isfinite(float(x)) for x in observation):
        return "nonfinite_observation"
    if not all(math.isfinite(float(x)) for x in action):
        return "nonfinite_action"
    if not all(math.isfinite(float(x)) for x in state):
        return "nonfinite_state"
    return None


def fault_checks():
    observation = [0.0] * OBS_DIM
    action = [0.0] * ACTION_DIM
    state = [0.0] * 41
    cases = {
        "healthy": (observation, action, state, 20, None),
        "short_observation": (observation[:-1], action, state, 20, "observation_dimension"),
        "short_action": (observation, action[:-1], state, 20, "action_dimension"),
        "stale_sample": (observation, action, state, 41, "stale_observation"),
        "nan_observation": (observation[:-1] + [float("nan")], action, state, 20, "nonfinite_observation"),
        "inf_action": (observation, action[:-1] + [float("inf")], state, 20, "nonfinite_action"),
        "nan_state": (observation, action, state[:-1] + [float("nan")], 20, "nonfinite_state"),
    }
    actual = {name: validate_boundary(*values[:4]) for name, values in cases.items()}
    expected = {name: values[4] for name, values in cases.items()}
    return {
        "cases": actual,
        "correct": sum(actual[name] == expected[name] for name in cases),
        "total": len(cases),
        "false_accepts": sum(actual[name] is None for name in cases if name != "healthy"),
        "false_rejects": int(actual["healthy"] is not None),
    }


def run_model(scene, ticks):
    import mujoco

    model = mujoco.MjModel.from_xml_path(str(scene))
    if model.nu != ACTION_DIM:
        raise ValueError(f"expected {ACTION_DIM} actuators, got {model.nu}")
    substeps = round(1 / (CONTROL_HZ * model.opt.timestep))
    if abs(substeps * model.opt.timestep - 1 / CONTROL_HZ) > 1e-9:
        raise ValueError("model timestep cannot divide 50 Hz control period")
    key_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_KEY, "STAND")
    if key_id < 0:
        raise ValueError("STAND keyframe missing")
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, key_id)
    mujoco.mj_forward(model, data)
    initial_x = float(data.qpos[0])
    min_height = float(data.qpos[2])
    finite_ticks = 0
    start = time.perf_counter()
    for _ in range(ticks):
        for _ in range(substeps):
            mujoco.mj_step(model, data)
        state = list(data.qpos) + list(data.qvel)
        if validate_boundary([0.0] * OBS_DIM, data.ctrl, state, 20) is None:
            finite_ticks += 1
        min_height = min(min_height, float(data.qpos[2]))
    elapsed = time.perf_counter() - start
    return {
        "engine": f"mujoco {mujoco.__version__}",
        "model_sha256": hashlib.sha256(scene.read_bytes()).hexdigest(),
        "nq": model.nq,
        "nv": model.nv,
        "actuators": model.nu,
        "timestep_s": model.opt.timestep,
        "control_hz": CONTROL_HZ,
        "substeps_per_tick": substeps,
        "ticks": ticks,
        "simulated_seconds": round(ticks / CONTROL_HZ, 3),
        "wall_seconds": round(elapsed, 3),
        "finite_ticks": finite_ticks,
        "min_base_height_m": round(min_height, 6),
        "base_x_drift_m": round(float(data.qpos[0]) - initial_x, 6),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scene", type=Path, nargs="?", help="Official microduck_rl scene_walk.xml")
    parser.add_argument("--ticks", type=int, default=250)
    parser.add_argument("--fault-only", action="store_true", help="Run dependency-free boundary checks")
    args = parser.parse_args()
    if args.ticks < 1:
        parser.error("--ticks must be positive")
    if not args.fault_only and args.scene is None:
        parser.error("scene is required unless --fault-only is set")
    result = {"fault_checks": fault_checks()}
    if not args.fault_only:
        result["model_smoke"] = run_model(args.scene.resolve(), args.ticks)
    print(json.dumps(result, indent=2, allow_nan=False))
    if (not args.fault_only and result["model_smoke"]["finite_ticks"] != args.ticks) or result["fault_checks"]["correct"] != result["fault_checks"]["total"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

