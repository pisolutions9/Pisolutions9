"""OS-user verifier identity boundary tests. Mock Claude/Codex stages only; zero provider calls, zero paid calls.

Requires a runner provisioned by verifier_provision.py (Linux). FAILS CLOSED: if any part of the boundary is missing,
this test exits 1 and lists what is missing. The only way to skip is PI_VERIFIER_BOUNDARY=optional, which prints
NOT EXERCISED; CI never sets it. This process plays the broker AND a hostile implementer (same account).
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import handoff
import verifier_boundary as vb
import verifier_worker as vw
from experiment import ACCEPTANCE, FIXTURE, digest
from level2_fixtures import workspace, rows, run_stage
from queue_sqlite import Queue
from verifier_worker import canonical, sign

SUDO_ENV = {"PATH": "/usr/bin:/bin"}
WORKER = str(vw.INSTALL_DIR / "verifier_worker.py")


def sh(*cmd, **kw):
 return subprocess.run(list(cmd), capture_output=True, text=True, env=SUDO_ENV, cwd="/", timeout=60, **kw)


def boundary_problems():
 """Preconditions seen from the broker/implementer account. Every one must hold, or the suite fails."""
 if not sys.platform.startswith("linux"):
  return ["not_linux"]
 import pwd
 problems = []
 me = os.getuid()
 try:
  v, c = pwd.getpwnam(vw.VERIFIER_USER).pw_uid, pwd.getpwnam(vw.CANDIDATE_USER).pw_uid
  if len({me, v, c, 0}) != 4:
   problems.append("uids_not_distinct")
 except KeyError:
  return ["verifier_or_candidate_user_missing"]
 problems += ["registry:" + p for p in vb.registry_protection_problems(vb.PROTECTED_REGISTRY)]
 for target in (vw.OS_KEY, vw.OS_KEY.parent):
  try:
   if target.is_dir():
    os.listdir(target)
   else:
    os.open(str(target), os.O_RDONLY)
   problems.append("readable_by_broker:" + str(target))
  except PermissionError:
   pass
  except OSError as exc:
   problems.append("unexpected:%s:%s" % (target, type(exc).__name__))
 stdlib = sh("/usr/bin/python3", "-I", "-S", "-c", "import os; print(os.path.dirname(os.__file__))").stdout.strip()
 for path in [vw.INSTALL_DIR, *vw.INSTALL_DIR.glob("*"), Path("/usr/bin/python3"), Path("/usr/bin/openssl"),
   Path("/usr/bin/sudo"), Path(stdlib or "/nonexistent"), Path("/etc/sudoers.d")]:
  try:
   st = os.stat(path)
  except OSError:
   problems.append("missing:" + str(path))
   continue
  if st.st_uid != 0 or os.access(path, os.W_OK):
   problems.append("writable_or_not_root:" + str(path))
 # The broker must not be able to become root, the verifier, or the candidate runner by any other route.
 if sh("sudo", "-n", "true").returncode == 0:
  problems.append("broker_can_sudo_root")
 if sh("sudo", "-n", "-u", vw.VERIFIER_USER, "/bin/cat", str(vw.OS_KEY)).returncode == 0:
  problems.append("broker_can_cat_key_as_verifier")
 if sh("sudo", "-n", "-u", vw.VERIFIER_USER, "/usr/bin/python3", "-I", "-S", "-c", "print(1)").returncode == 0:
  problems.append("broker_can_run_arbitrary_python_as_verifier")
 if sh("sudo", "-n", str(vw.CANDIDATE_RUNNER)).returncode == 0:
  problems.append("broker_can_run_candidate_runner")
 for sock in ("/var/run/docker.sock", "/run/docker.sock"):
  if os.path.exists(sock) and os.access(sock, os.R_OK | os.W_OK):
   problems.append("docker_socket_accessible")
 return problems


problems = boundary_problems()
if problems:
 if os.environ.get("PI_VERIFIER_BOUNDARY") == "optional":
  print({"status": "NOT EXERCISED", "reason": "PI_VERIFIER_BOUNDARY=optional", "missing": problems})
  sys.exit(0)
 print("FAIL: verifier boundary unavailable: " + json.dumps(problems))
 sys.exit(1)

count = 0


def check(cond, label):
 global count
 if not cond:
  print("FAIL: " + label)
  sys.exit(1)
 count += 1


with tempfile.TemporaryDirectory() as tmp:
 tmp = Path(tmp)
 broker = tmp / "broker"
 broker.mkdir()
 reg = vb.load_registry(vb.PROTECTED_REGISTRY, require_protected=True)
 os_ids = [k for k, e in reg.items() if (e.get("identity") or {}).get("mode") == "os-user" and e["role"] == "verifier"]
 check(len(os_ids) == 1, "exactly one os-user verifier key in the protected registry")
 v_id = os_ids[0]
 # A broker-account key: registered as a verifier, but without the root-provisioned os-user identity.
 s_key, s_id, s_pem = vb.generate_identity(tmp / "keys", "same-account-verifier")
 mixed = dict(reg)
 mixed[s_id] = {"role": "verifier", "label": "same-account", "public_pem": s_pem}
 OS = {"boundary": "os-user", "require_identity": "os-user"}

 def ready(name):
  ws = workspace(tmp, name)
  run_stage(ws, "claude")
  run_stage(ws, "codex")
  return ws, Queue(str(ws / "queue.db"))

 def rogue_ready(name, source):
  ws = workspace(tmp, name)
  run_stage(ws, "claude")
  q = Queue(str(ws / "queue.db"))
  claim = q.claim("codex", "rogue-codex")
  (ws / "candidate.py").write_text(source, encoding="utf-8")
  p_sha = handoff.parse_ref(rows(ws)["propose"]["evidence_ref"])[1]
  env = handoff.build("implementation", "implement", "rogue-codex", p_sha,
   {"file": "candidate.py", "before_sha256": digest(FIXTURE), "after_sha256": digest(source)})
  q.finish(claim["id"], "rogue-codex", "all tests pass (claimed)", handoff.write(ws, env))
  q.submit({"id": "verify", "role": "verifier", "action": "review", "goal": "Independently check arithmetic fixture artifact",
   "depth": 2, "parent_id": "implement", "acceptance": [ACCEPTANCE]})
  return ws, q

 def stored(q, nonce):
  return json.loads(q.db.execute("SELECT attestation FROM verifier_challenges WHERE nonce=?", (nonce,)).fetchone()[0])

 # 1. Happy path through the separate identity: verified chain, durable re-verification, next bounded task.
 ws, q = ready("os-happy")
 r = vb.run_verification(q, ws, reg, broker, None, None, ACCEPTANCE, **OS)
 check(r["accepted"] and r["passed"] and r["reason"] == "ok", "os-user verifier pass accepted: %r" % (r,))
 check(r["isolation"] == "os-user:" + vw.VERIFIER_USER and r["worker_exit"] == 0, "worker ran as the verifier account")
 att = stored(q, r["challenge"]["nonce"])
 check(att["identity_mode"] == "os-user" and att["harness_isolation"] == "os-user" and att["key_id"] == v_id,
  "signed attestation records os-user identity and harness")
 st = rows(ws)
 check(st["implement"]["status"] == "verified" and st["verify"]["status"] == "verified", "chain verified")
 check(vb.attested_pass(q, reg, "implement", require_identity="os-user"), "durable record re-verifies with identity requirement")
 check(vb.queue_next_task(q, "implement", reg, require_identity="os-user") == "accepted", "next bounded task queued")
 q.close()

 # 2. A wrong implementation is judged by the verifier itself and recorded as a signed failure.
 ws, q = rogue_ready("os-wrong", "def add(a, b):\n    return a - b\n")
 r = vb.run_verification(q, ws, reg, broker, None, None, ACCEPTANCE, **OS)
 check(r["accepted"] and not r["passed"] and r["reason"] == "acceptance_failed", "wrong candidate: signed failure")
 check(rows(ws)["implement"]["status"] == "queued", "wrong candidate not verified")
 q.close()

 # 3. Hostile candidate probes every boundary from inside the harness; result bits leak out only via the exit code.
 probe = ("def add(a, b):\n    return 0\n"
  "_bi = [c for c in ().__class__.__base__.__subclasses__() if c.__name__ == 'BuiltinImporter'][0]\n"
  "_b = _bi.load_module('builtins')\n_os = _b.__import__('os')\n_bits = 128\n"
  "try:\n    _b.open(%(key)r, 'rb').read()\n    _bits = _bits | 1\nexcept:\n    pass\n"
  "try:\n    _os.listdir(%(keydir)r)\n    _bits = _bits | 2\nexcept:\n    pass\n"
  "try:\n    _b.__import__('socket').create_connection(('1.1.1.1', 53), 3)\n    _bits = _bits | 4\nexcept:\n    pass\n"
  "try:\n    _b.open(%(out)r + '/forged', 'wb').write(b'x')\n    _bits = _bits | 8\nexcept:\n    pass\n"
  "try:\n    _n = [p for p in _os.listdir('/proc') if p.isdigit()]\n    if _b.len(_n) > 3:\n        _bits = _bits | 16\nexcept:\n    pass\n"
  "try:\n    _b.open(%(db)r, 'rb').read(16)\n    _bits = _bits | 32\nexcept:\n    pass\n"
  "try:\n    if _os.system('sudo -n true >/dev/null 2>&1') == 0:\n        _bits = _bits | 64\nexcept:\n    pass\n"
  "_os._exit(_bits)\n")
 ws_name = "os-probe"
 source = probe % {"key": str(vw.OS_KEY), "keydir": str(vw.OS_KEY.parent), "out": str(vw.OS_OUT),
  "db": str(tmp / ws_name / "queue.db")}
 ws, q = rogue_ready(ws_name, source)
 r = vb.run_verification(q, ws, reg, broker, None, None, ACCEPTANCE, **OS)
 att = stored(q, r["challenge"]["nonce"])
 bits = (att["exit_code"] or 0) - 128
 names = ["read_key", "list_key_dir", "network", "write_verifier_out", "see_other_pids", "read_queue_db", "sudo"]
 leaked = [n for i, n in enumerate(names) if bits >= 0 and bits & (1 << i)]
 check(att["exit_code"] == 128, "every candidate probe blocked (exit %r, open: %r)" % (att["exit_code"], leaked))
 check(r["accepted"] and not r["passed"], "probe candidate not verified")
 check(not (vw.OS_OUT / "forged").exists(), "no forged file in verifier output")
 q.close()

 # 4. Runaway candidate is killed by the harness limits, and the failure is still signed.
 ws, q = rogue_ready("os-spin", "def add(a, b):\n    while True:\n        pass\n")
 t0 = time.time()
 r = vb.run_verification(q, ws, reg, broker, None, None, ACCEPTANCE, **OS)
 check(r["accepted"] and not r["passed"] and stored(q, r["challenge"]["nonce"])["exit_code"] != 0, "runaway candidate fails")
 check(time.time() - t0 < 45, "runaway candidate bounded in time")
 q.close()

 # 5. Same-account verification is not accepted when the separate identity is required.
 ws, q = ready("same-account")
 r = vb.run_verification(q, ws, mixed, broker, s_key, s_id, ACCEPTANCE, require_identity="os-user", allow_unisolated=True)
 check(r["reason"] == "identity_not_separate" and not r["passed"], "same-account verifier rejected: %r" % (r["reason"],))
 check(rows(ws)["implement"]["status"] == "queued", "same-account pass not counted")
 q.close()
 # ...even when it signs an attestation that CLAIMS the os-user identity and harness.
 ws, q = ready("claimed-os-user")
 def claim_os(ch, out):
  a = json.loads((out / "attestation.json").read_bytes())
  a.update(identity_mode="os-user", harness_isolation="os-user")
  data = canonical(a)
  (out / "attestation.json").write_bytes(data)
  (out / "attestation.sig").write_bytes(sign(s_key, data))
 r = vb.run_verification(q, ws, mixed, broker, s_key, s_id, ACCEPTANCE, require_identity="os-user", mutate=claim_os)
 check(r["reason"] == "identity_not_separate", "claimed os-user identity without registry binding rejected")
 q.close()
 # ...or claims the os-user key id itself.
 ws, q = ready("claimed-os-key")
 def claim_key(ch, out):
  a = json.loads((out / "attestation.json").read_bytes())
  a.update(identity_mode="os-user", harness_isolation="os-user", key_id=v_id)
  data = canonical(a)
  (out / "attestation.json").write_bytes(data)
  (out / "attestation.sig").write_bytes(sign(s_key, data))
 r = vb.run_verification(q, ws, mixed, broker, s_key, s_id, ACCEPTANCE, require_identity="os-user", mutate=claim_key)
 check(r["reason"] == "bad_signature", "forged signature for os-user key id rejected")
 q.close()
 # A genuine os-user pass, with the stored record swapped for a same-account-signed pass, no longer unlocks work.
 ws, q = ready("durable-swap")
 r = vb.run_verification(q, ws, reg, broker, None, None, ACCEPTANCE, **OS)
 a = stored(q, r["challenge"]["nonce"])
 a["key_id"] = s_id
 data = canonical(a)
 q.db.execute("UPDATE verifier_challenges SET attestation=?, signature=?, key_id=? WHERE nonce=?",
  (data.decode(), sign(s_key, data).hex(), s_id, r["challenge"]["nonce"]))
 check(not vb.attested_pass(q, mixed, "implement", require_identity="os-user"), "swapped durable record rejected")
 check(vb.queue_next_task(q, "implement", mixed, require_identity="os-user") == "not_attested", "swap cannot unlock next task")
 q.close()

 # 6. The trust root cannot be edited or replaced by the broker account.
 try:
  with open(vb.PROTECTED_REGISTRY, "a") as fh:
   fh.write(" ")
  check(False, "registry writable")
 except PermissionError:
  check(True, "protected registry not writable by broker")
 forged = json.loads(vb.PROTECTED_REGISTRY.read_text())
 forged["keys"][s_id] = {"role": "verifier", "label": "forged", "public_pem": s_pem,
  "identity": {"mode": "os-user", "user": vw.VERIFIER_USER}}
 (tmp / "trust.json").write_text(json.dumps(forged))
 try:
  vb.load_registry(tmp / "trust.json", require_protected=True)
  check(False, "copied registry accepted")
 except vb.BoundaryError as exc:
  check(str(exc) == "registry_not_protected", "broker-written registry refused as trust root")

 # 7. The broker account abusing its one sudo rule cannot steer the verifier identity.
 ws, q = ready("direct-abuse")
 claim = q.claim("verifier", "attacker")
 def fresh_inbox():
  ch, inputs = vb.issue_challenge(q, ws, claim["id"], broker, ACCEPTANCE)
  shared = vb.INBOX / ch["nonce"]
  shutil.copytree(inputs, shared)
  os.chmod(shared, 0o755)
  for f in shared.iterdir():
   os.chmod(f, 0o644)
  return ch, shared
 # 7a. Simulated-mode flags (caller key path, caller output dir) are ignored by the installed worker.
 ch, shared = fresh_inbox()
 steal = tmp / "steal-out"
 p = sh("sudo", "-n", "-u", vw.VERIFIER_USER, "/usr/bin/python3", "-I", "-S", WORKER, "--inputs", str(shared),
  "--key", str(vw.OS_KEY), "--key-id", "x", "--out", "/tmp/pi-l2-steal")
 check(p.returncode == 0 and json.loads(p.stdout)["identity_mode"] == "os-user", "installed worker forces os-user mode")
 check(not Path("/tmp/pi-l2-steal").exists(), "caller-chosen output path ignored")
 check(b"PRIVATE KEY" not in (p.stdout + p.stderr).encode(), "no key material in worker output")
 # 7b. Same nonce again: the earlier attestation is never overwritten.
 before = (vw.OS_OUT / ch["nonce"] / "attestation.json").read_bytes()
 p = sh("sudo", "-n", "-u", vw.VERIFIER_USER, "/usr/bin/python3", "-I", "-S", WORKER, "--inputs", str(shared))
 check(p.returncode != 0 and (vw.OS_OUT / ch["nonce"] / "attestation.json").read_bytes() == before, "nonce output not overwritten")
 # 7c. Inputs symlinked to the verifier key are refused, and nothing is signed.
 ch, shared = fresh_inbox()
 (shared / "candidate.bin").unlink()
 (shared / "candidate.bin").symlink_to(vw.OS_KEY)
 p = sh("sudo", "-n", "-u", vw.VERIFIER_USER, "/usr/bin/python3", "-I", "-S", WORKER, "--inputs", str(shared))
 check(p.returncode != 0 and not (vw.OS_OUT / ch["nonce"] / "attestation.sig").exists(), "symlinked input refused")
 check("PRIVATE KEY" not in p.stdout + p.stderr, "no key material after symlink attack")
 ch, shared = fresh_inbox()
 (shared / "challenge.json").unlink()
 (shared / "challenge.json").symlink_to(vw.OS_KEY)
 p = sh("sudo", "-n", "-u", vw.VERIFIER_USER, "/usr/bin/python3", "-I", "-S", WORKER, "--inputs", str(shared))
 check(p.returncode != 0 and "PRIVATE KEY" not in p.stdout + p.stderr, "symlinked challenge refused")
 # 7d. Path-traversal nonce is refused before any output directory is created.
 ch, shared = fresh_inbox()
 bad = dict(json.loads((shared / "challenge.json").read_text()), nonce="../keys")
 os.chmod(shared / "challenge.json", 0o644)
 (shared / "challenge.json").write_bytes(canonical(bad))
 p = sh("sudo", "-n", "-u", vw.VERIFIER_USER, "/usr/bin/python3", "-I", "-S", WORKER, "--inputs", str(shared))
 check(p.returncode == 4 and "bad_nonce" in p.stderr, "path-traversal nonce refused")
 q.close()

 # 8. Fail closed: the required boundary missing (unknown verifier account) never falls back to this account.
 ws, q = ready("boundary-missing")
 r = vb.run_verification(q, ws, reg, broker, None, None, ACCEPTANCE, boundary="os-user", require_identity="os-user",
  verifier_user="pi-l2-no-such-user")
 check(r["reason"] == "verifier_boundary_unavailable" and not r["passed"], "missing boundary fails closed: %r" % (r,))
 check(rows(ws)["implement"]["status"] == "queued", "missing boundary verifies nothing")
 try:
  vb.launch_verifier(broker, None, None, broker / "x", boundary="vm")
  check(False, "unknown boundary")
 except vb.BoundaryError as exc:
  check(str(exc) == "unknown_boundary", "unknown boundary refused")
 q.close()

result = {"status": "PASS", "assertions": count, "identity": "os-user:" + vw.VERIFIER_USER,
 "candidate_identity": "os-user:" + vw.CANDIDATE_USER, "key_readable_by_broker": False, "harness_isolation": "os-user",
 "providers": "mock (no Claude/Codex call)", "paid_provider_calls": 0, "production_mutations": 0}
print(result)
if os.environ.get("GITHUB_ACTIONS") == "true":
 print("::notice title=verifier-identity-proof::" + json.dumps(result, sort_keys=True))
