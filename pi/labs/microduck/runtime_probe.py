"""Observe official headless duck-sim on an ephemeral Linux runner.

Upstream health and independent TCP/process observations are recorded separately.
"""

import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path


def cmd(*args, env=None, timeout=30):
    try:
        p = subprocess.run(args, capture_output=True, text=True, env=env, timeout=timeout)
        return {"exit_code": p.returncode, "stdout": p.stdout[-12000:], "stderr": p.stderr[-12000:]}
    except subprocess.TimeoutExpired as e:
        return {"exit_code": None, "timeout_s": timeout, "stdout": str(e.stdout or "")[-12000:], "stderr": str(e.stderr or "")[-12000:]}


def open_port():
    try:
        with socket.create_connection(("127.0.0.1", 7801), timeout=0.5):
            return True
    except OSError:
        return False


def wait_port(expected, seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if open_port() == expected:
            return True
        time.sleep(0.25)
    return False


def body_rate():
    with socket.create_connection(("127.0.0.1", 7801), timeout=5) as sock:
        sock.settimeout(5)
        f = sock.makefile("rw")
        f.write('{"op":"hello","protocol":1,"joints":15}\n')
        f.flush()
        hello = f.readline().strip()

        def sim_time():
            f.write('{"op":"read"}\n')
            f.flush()
            return float(json.loads(f.readline())["sim_time"])

        a, start = sim_time(), time.perf_counter()
        time.sleep(3)
        b, elapsed = sim_time(), time.perf_counter() - start
        return {"hello": hello, "sim_delta_s": round(b - a, 4), "wall_delta_s": round(elapsed, 4), "sim_per_wall": round((b - a) / elapsed, 4)}


def main():
    repo, rl, state = (Path(x).resolve() for x in sys.argv[1:4])
    state.mkdir(parents=True, exist_ok=True)
    sim = repo / "scripts/duck-sim"
    env = dict(os.environ, DUCK_SIM_RL=str(rl), DUCK_SIM_STATE=str(state), DUCK_SIM_VIEWER="0", DUCK_SIM_PORT="7801")
    health = lambda: cmd(str(sim), "ctl", "health", "--json", env=env)
    report = {"source_commits": {"microduck": cmd("git", "-C", str(repo), "rev-parse", "HEAD")["stdout"].strip(), "microduck_rl": cmd("git", "-C", str(rl), "rev-parse", "HEAD")["stdout"].strip()}, "upstream_health": {}, "independent_observation": {}, "faults": {}, "blockers": []}
    try:
        report["startup"] = cmd(str(sim), "up", env=env, timeout=600)
        report["independent_observation"]["body_port_open_after_start"] = open_port()
        report["upstream_health"]["baseline"] = health()
        if not open_port() or report["upstream_health"]["baseline"]["exit_code"] != 0:
            report["blockers"].append("simulator_or_robotd_startup_failed")
            return
        try:
            report["independent_observation"]["body_rate"] = body_rate()
        except Exception as e:
            report["blockers"].append(f"body_rate_probe_failed: {type(e).__name__}: {e}")
        report["upstream_health"]["realtime_command"] = cmd(str(sim), "realtime", env=env, timeout=15)

        pid = int((state / "body.pid").read_text().strip())
        argv = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        if "mjlab_microduck.sim.body_server" not in argv or "--port 7801" not in argv:
            raise RuntimeError(f"body PID identity mismatch: {pid}: {argv}")
        report["faults"]["body_disconnect"] = {"pid": pid, "verified_cmdline": argv}
        os.kill(pid, signal.SIGTERM)
        report["faults"]["body_disconnect"]["port_closed"] = wait_port(False, 15)
        time.sleep(2)
        report["upstream_health"]["after_disconnect"] = health()
        robot_pid = int((state / "duck-a.pid").read_text().strip())
        report["independent_observation"]["robotd_alive_after_disconnect"] = Path(f"/proc/{robot_pid}").exists()

        with (state / "body-restart.log").open("w") as log:
            p = subprocess.Popen([str(rl / ".venv/bin/python"), "-m", "mjlab_microduck.sim.body_server", "--port", "7801", "--ducks", "1", "--keyframe", "SIT", "--headless"], cwd=rl, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, env=env)
        (state / "body.pid").write_text(str(p.pid))
        report["faults"]["body_reconnect"] = {"new_pid": p.pid, "port_reopened": wait_port(True, 30)}
        time.sleep(5)
        report["upstream_health"]["after_reconnect"] = health()

        bad = repo / "duck-control/tests/fixtures/bad_action_count.onnx"
        report["faults"]["malformed_policy"] = {"fixture": str(bad.relative_to(repo)), "sha256": hashlib.sha256(bad.read_bytes()).hexdigest(), "load_attempt": cmd(str(sim), "ctl", "policy", "load", "walk", str(bad), env=env)}
        report["upstream_health"]["after_malformed_policy"] = health()
    except Exception as e:
        report["blockers"].append(f"probe_exception: {type(e).__name__}: {e}")
    finally:
        report["cleanup"] = cmd(str(sim), "down", env=env, timeout=90)
        Path("runtime_probe-result.json").write_text(json.dumps(report, indent=2) + "\n")
        print(Path("runtime_probe-result.json").read_text())


if __name__ == "__main__":
    main()
