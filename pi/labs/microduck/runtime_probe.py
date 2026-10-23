"""Observe official headless duck-sim on an ephemeral Linux runner.

Upstream health and independent TCP/process observations are recorded separately.
"""

import hashlib
import json
import os
import signal
import statistics
import struct
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



def policy_hashes(state):
    root = state / "policies" / "current"
    return [{"path": str(p.relative_to(root)), "bytes": p.stat().st_size,
             "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
            for p in sorted(root.rglob("*.onnx")) if p.is_file()]


def pcap_read_timestamps(path):
    """Read inbound IPv4 TCP payloads from tcpdump's classic pcap without a third-party parser."""
    data = path.read_bytes()
    if len(data) < 24:
        raise ValueError("pcap header missing")
    magic = data[:4]
    if magic == bytes.fromhex("d4c3b2a1"):
        endian, scale = "<", 1_000_000
    elif magic == bytes.fromhex("a1b2c3d4"):
        endian, scale = ">", 1_000_000
    elif magic == bytes.fromhex("4d3cb2a1"):
        endian, scale = "<", 1_000_000_000
    elif magic == bytes.fromhex("a1b23c4d"):
        endian, scale = ">", 1_000_000_000
    else:
        raise ValueError("unsupported pcap format")
    linktype = struct.unpack_from(endian + "I", data, 20)[0]
    if linktype != 1:
        raise ValueError(f"expected Ethernet pcap, got linktype {linktype}")
    times = []
    pos = 24
    while pos + 16 <= len(data):
        sec, subsec, size, _ = struct.unpack_from(endian + "IIII", data, pos)
        pos += 16
        frame = data[pos:pos + size]
        pos += size
        if len(frame) != size or len(frame) < 54 or frame[12:14] != b"\x08\x00":
            continue
        ip = 14
        ihl = (frame[ip] & 15) * 4
        if frame[ip + 9] != 6 or len(frame) < ip + ihl + 20:
            continue
        tcp = ip + ihl
        header = ((frame[tcp + 12] >> 4) & 15) * 4
        payload = frame[tcp + header:]
        if b'"op":"read"' in payload:
            times.append(sec + subsec / scale)
    return times


def capture_ticks(state, label, seconds=6):
    path = state / f"{label}.pcap"
    capture = subprocess.Popen(
        ["sudo", "-n", "tcpdump", "-i", "lo", "-s", "0", "-U", "-w", str(path),
         "tcp and dst host 127.0.0.1 and dst port 7801"],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
    try:
        time.sleep(0.5)
        if capture.poll() is not None:
            raise RuntimeError(f"tcpdump exited: {capture.stderr.read().decode(errors='replace')[-1000:]}")
        time.sleep(seconds)
    finally:
        if capture.poll() is None:
            os.killpg(capture.pid, signal.SIGINT)
        try:
            capture.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            capture.kill()
            capture.communicate()
    times = pcap_read_timestamps(path)
    intervals = [round((b - a) * 1000, 3) for a, b in zip(times, times[1:])]
    if len(intervals) < 100:
        raise ValueError(f"only {len(intervals)} control reads captured")
    ordered = sorted(intervals)
    return {"method": "tcpdump loopback TCP payload timestamps for robotd read requests",
            "capture_seconds": seconds, "packets": len(times), "intervals_ms": intervals,
            "median_ms": round(statistics.median(intervals), 3),
            "p95_ms": ordered[int(0.95 * (len(ordered) - 1))],
            "p99_ms": ordered[int(0.99 * (len(ordered) - 1))],
            "max_ms": max(intervals),
            "over_30ms": sum(x > 30 for x in intervals),
            "observed_hz": round((len(times) - 1) / (times[-1] - times[0]), 3)}


def cpu_seconds(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().split()
    return (int(fields[13]) + int(fields[14])) / os.sysconf("SC_CLK_TCK")


def main():
    repo, rl, state = (Path(x).resolve() for x in sys.argv[1:4])
    state.mkdir(parents=True, exist_ok=True)
    sim = repo / "scripts/duck-sim"
    env = dict(os.environ, DUCK_SIM_RL=str(rl), DUCK_SIM_STATE=str(state), DUCK_SIM_VIEWER="0", DUCK_SIM_PORT="7801")
    health = lambda: cmd(str(sim), "ctl", "health", "--json", env=env)
    report = {"source_commits": {"microduck": cmd("git", "-C", str(repo), "rev-parse", "HEAD")["stdout"].strip(), "microduck_rl": cmd("git", "-C", str(rl), "rev-parse", "HEAD")["stdout"].strip()}, "upstream_health": {}, "independent_observation": {}, "faults": {}, "blockers": [], "policy_hashes": [], "tick_traces": {}, "load": {}, "workflow": {"run_id": os.environ.get("GITHUB_RUN_ID"), "head_sha": os.environ.get("PI_LAB_HEAD_SHA")}}
    load_process = None
    try:
        report["startup"] = cmd(str(sim), "up", env=env, timeout=600)
        report["independent_observation"]["body_port_open_after_start"] = open_port()
        report["upstream_health"]["baseline"] = health()
        report["policy_hashes"] = policy_hashes(state)
        if len(report["policy_hashes"]) < 7:
            report["blockers"].append(f"only_{len(report['policy_hashes'])}_policy_files")
        if not open_port() or report["upstream_health"]["baseline"]["exit_code"] != 0:
            report["blockers"].append("simulator_or_robotd_startup_failed")
            return
        try:
            report["independent_observation"]["body_rate"] = body_rate()
        except Exception as e:
            report["blockers"].append(f"body_rate_probe_failed: {type(e).__name__}: {e}")
        report["upstream_health"]["realtime_command"] = cmd(str(sim), "realtime", env=env, timeout=15)
        report["tick_traces"]["baseline"] = capture_ticks(state, "baseline")
        load_process = subprocess.Popen([sys.executable, "-c", "while True: pass"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        report["load"] = {"definition": "one Python CPU-bound worker, default Linux scheduler", "pid": load_process.pid}
        start_cpu = cpu_seconds(load_process.pid)
        start_wall = time.monotonic()
        report["tick_traces"]["loaded"] = capture_ticks(state, "loaded")
        report["load"]["sample_wall_s"] = round(time.monotonic() - start_wall, 3)
        report["load"]["sample_cpu_s"] = round(cpu_seconds(load_process.pid) - start_cpu, 3)
        if report["load"]["sample_cpu_s"] < 2:
            report["blockers"].append("cpu_worker_did_not_sustain_load")

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
        if load_process is not None:
            load_process.terminate()
            try:
                load_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                load_process.kill()
                load_process.wait(timeout=5)
            report["load"]["exit_code"] = load_process.returncode
        report["cleanup"] = cmd(str(sim), "down", env=env, timeout=90)
        def healthy(name):
            try:
                return json.loads(report["upstream_health"][name]["stdout"])["robot"]["healthy"]
            except (KeyError, ValueError, TypeError):
                return None

        rate = report["independent_observation"].get("body_rate", {}).get("sim_per_wall", 0)
        checks = {
            "startup": report.get("startup", {}).get("exit_code") == 0,
            "baseline_health": healthy("baseline") is True,
            "body_realtime": rate >= 0.95,
            "body_port_closed": report["faults"].get("body_disconnect", {}).get("port_closed") is True,
            "robotd_survived": report["independent_observation"].get("robotd_alive_after_disconnect") is True,
            "disconnect_reported_unhealthy": healthy("after_disconnect") is False,
            "body_port_reopened": report["faults"].get("body_reconnect", {}).get("port_reopened") is True,
            "reconnect_reported_healthy": healthy("after_reconnect") is True,
            "bad_policy_rejected": report["faults"].get("malformed_policy", {}).get("load_attempt", {}).get("exit_code") not in (None, 0),
            "bad_policy_preserved_health": healthy("after_malformed_policy") is True,
            "cleanup": report["cleanup"]["exit_code"] == 0,
            "policy_hashes": len(report["policy_hashes"]) >= 7 and all(x["bytes"] > 0 and len(x["sha256"]) == 64 for x in report["policy_hashes"]),
            "external_tick_traces": all(report["tick_traces"].get(k, {}).get("packets", 0) >= 100 for k in ("baseline", "loaded")),
            "load_sustained": report["load"].get("sample_cpu_s", 0) >= 2,

        }
        report["verification"] = {"checks": checks, "passed": not report["blockers"] and all(checks.values())}
        Path("runtime_probe-result.json").write_text(json.dumps(report, indent=2) + "\n")
        print(Path("runtime_probe-result.json").read_text())
        if not report["verification"]["passed"]:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
