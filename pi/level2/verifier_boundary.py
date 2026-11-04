"""PI L2 broker side of the verifier boundary. Holds public keys only; never a verifier private key.

Flow: the broker claims the verifier task, issues a single-use challenge bound to the queue's current
evidence refs, candidate hash and attempt, and snapshots the inputs outside the workspace. The verifier
worker runs as a separate process (network namespace removed when available) and signs an attestation.
The broker accepts it only if the key is a registered verifier key, the signature verifies, the nonce is
fresh and unused, and the queue and candidate still match what was challenged.

Two identity modes. `simulated-local-key` (default, tests/dev): keys are local fixtures and the processes share one
OS account. `os-user` (boundary="os-user"): the worker runs as the provisioned `pi-verifier` account whose key
this broker account cannot read, and candidate code runs as `pi-candidate`. With require_identity="os-user",
anything else is rejected (`identity_not_separate`), and an unavailable boundary fails closed
(`verifier_boundary_unavailable`); there is no fallback to the simulated mode.
"""
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import handoff
from queue_sqlite import Queue
import verifier_worker as vw
from verifier_worker import ATTESTATION_SCHEMA, canonical

WORKER = Path(__file__).resolve().with_name("verifier_worker.py")
TRUST_SCHEMA = "pi.level2.trust.v1"
ISOLATED_HARNESS = ("ns-hidden", "os-user")
INBOX = vw.STATE_DIR / "inbox"
SYSTEM_PYTHON = "/usr/bin/python3"
PROTECTED_REGISTRY = Path("/etc/pi-level2/trust.json")
ATTESTATION_KEYS = {"schema", "identity_mode", "nonce", "task_id", "attempt", "key_id", "proposal_ref",
 "implementation_ref", "candidate_sha256", "acceptance", "exit_code", "candidate_sha256_after", "harness_isolation", "reason", "passed"}
CHALLENGES = """CREATE TABLE IF NOT EXISTS verifier_challenges(
 nonce TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL,
 proposal_ref TEXT NOT NULL, implementation_ref TEXT NOT NULL, candidate_sha256 TEXT NOT NULL,
 issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER,
 key_id TEXT, attestation TEXT, signature TEXT)"""


class BoundaryError(ValueError):
 pass


def _openssl(*args):
 return subprocess.run(["openssl", *args], capture_output=True, timeout=10)


def generate_identity(key_dir, label):
 """Create a local Ed25519 fixture identity. Returns (private_key_path, key_id, public_pem)."""
 key_dir = Path(key_dir)
 key_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
 key = key_dir / (label + ".key")
 if _openssl("genpkey", "-algorithm", "ed25519", "-out", str(key)).returncode:
  raise BoundaryError("keygen_failed")
 os.chmod(key, 0o600)
 pem = _openssl("pkey", "-in", str(key), "-pubout").stdout.decode("ascii")
 return key, key_id_for(pem), pem


def key_id_for(pem):
 with tempfile.TemporaryDirectory() as d:
  p = Path(d) / "p.pem"
  p.write_text(pem, encoding="ascii")
  der = _openssl("pkey", "-pubin", "-in", str(p), "-outform", "DER").stdout
 if not der:
  raise BoundaryError("bad_public_key")
 return hashlib.sha256(der).hexdigest()


def write_registry(path, entries):
 """entries: list of (key_id, role, label, public_pem[, identity]). identity e.g. {"mode": "os-user", "user": ...}."""
 keys = {}
 for kid, role, label, pem, *identity in entries:
  keys[kid] = {"role": role, "label": label, "public_pem": pem}
  if identity:
   keys[kid]["identity"] = identity[0]
 Path(path).write_text(json.dumps({"schema": TRUST_SCHEMA, "keys": keys}, sort_keys=True), encoding="ascii")


def registry_protection_problems(path):
 """A registry the implementer/broker account can write is not a trust root. [] means root-owned and read-only."""
 if not hasattr(os, "getuid"):
  return ["not_posix"]
 problems = []
 p = Path(path).resolve()
 for node in [p, *p.parents]:
  try:
   st = os.lstat(node)
  except OSError:
   return ["missing:" + str(node)]
  if st.st_uid != 0 or st.st_mode & 0o022:
   problems.append("writable_by_non_root:" + str(node))
 if os.access(p, os.W_OK) and os.getuid() != 0:
  problems.append("writable_by_caller")
 return problems


def load_registry(path, require_protected=False):
 if require_protected and registry_protection_problems(path):
  raise BoundaryError("registry_not_protected")
 reg = json.loads(Path(path).read_text(encoding="ascii"))
 if reg.get("schema") != TRUST_SCHEMA or not isinstance(reg.get("keys"), dict):
  raise BoundaryError("bad_registry")
 for kid, entry in reg["keys"].items():
  if entry.get("role") not in ("verifier", "implementer") or key_id_for(entry.get("public_pem", "")) != kid:
   raise BoundaryError("registry_key_mismatch")
 return reg["keys"]


def verify_signature(pem, data, signature):
 with tempfile.TemporaryDirectory() as d:
  d = Path(d)
  (d / "p.pem").write_text(pem, encoding="ascii")
  (d / "m").write_bytes(data)
  (d / "s").write_bytes(signature)
  return _openssl("pkeyutl", "-verify", "-pubin", "-inkey", str(d / "p.pem"), "-rawin",
   "-in", str(d / "m"), "-sigfile", str(d / "s")).returncode == 0


def _row(q, tid):
 return q.db.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()


def _ensure(q):
 q.db.execute(CHALLENGES)


def candidate_sha(root, implementation):
 return hashlib.sha256((Path(root) / implementation["payload"]["file"]).read_bytes()).hexdigest()


def issue_challenge(q, root, task_id, broker_dir, acceptance, ttl=60):
 """Bind a fresh nonce to the current queue state and snapshot inputs outside the workspace."""
 _ensure(q)
 task = _row(q, task_id)
 if not task or task["role"] != "verifier" or task["status"] != "running":
  raise BoundaryError("verifier_task_not_running")
 impl_task = _row(q, task["parent_id"])
 prop_task = _row(q, impl_task["parent_id"]) if impl_task else None
 if not impl_task or impl_task["status"] != "awaiting_review" or not prop_task or prop_task["status"] != "verified":
  raise BoundaryError("ancestry_not_ready")
 implementation = handoff.read(root, impl_task["evidence_ref"], "implementation")
 handoff.read(root, prop_task["evidence_ref"], "proposal")
 nonce = secrets.token_hex(16)
 now = q.now()
 ch = {"nonce": nonce, "task_id": task_id, "attempt": task["attempts"],
  "implementation_task": impl_task["id"], "proposal_task": prop_task["id"],
  "proposal_ref": prop_task["evidence_ref"], "implementation_ref": impl_task["evidence_ref"],
  "candidate_sha256": candidate_sha(root, implementation),
  "acceptance": acceptance,  # broker-held contract, never read from the writable workspace
  "issued_at": now, "expires_at": now + ttl}
 with q.db:
  q.db.execute("BEGIN IMMEDIATE")
  q.db.execute("""INSERT INTO verifier_challenges(nonce,task_id,attempt,proposal_ref,implementation_ref,
   candidate_sha256,issued_at,expires_at) VALUES (?,?,?,?,?,?,?,?)""",
   (nonce, task_id, ch["attempt"], ch["proposal_ref"], ch["implementation_ref"], ch["candidate_sha256"], now, now + ttl))
  q._event(task_id, "verifier_challenge_issued", {"nonce": nonce, "attempt": ch["attempt"]})
 inputs = Path(broker_dir) / ("inputs-" + nonce)
 inputs.mkdir(parents=True)
 for kind in ("proposal", "implementation"):
  shutil.copyfile(Path(root) / "handoff" / (kind + ".json"), inputs / (kind + ".json"))
 shutil.copyfile(Path(root) / implementation["payload"]["file"], inputs / "candidate.bin")
 (inputs / "challenge.json").write_bytes(canonical(ch))
 return ch, inputs


def isolation_prefix():
 """Drop network with an unprivileged user+net namespace when the host allows it."""
 try:
  if subprocess.run(["unshare", "-rn", "true"], capture_output=True, timeout=5).returncode == 0:
   return ["unshare", "-rn"], "user+net namespace"
 except (FileNotFoundError, subprocess.TimeoutExpired):
  pass
 return [], "process-only"


def launch_os_user_verifier(inputs, out_dir, user=vw.VERIFIER_USER, timeout=60):
 """Run the installed worker as the separate verifier OS user. Never falls back to this account."""
 nonce = json.loads((Path(inputs) / "challenge.json").read_text(encoding="ascii"))["nonce"]
 if not vw.NONCE_RE.fullmatch(nonce):
  raise BoundaryError("bad_nonce")
 shared = INBOX / nonce
 try:
  shared.mkdir(mode=0o755)
  os.chmod(shared, 0o755)
  for f in Path(inputs).iterdir():
   shutil.copyfile(f, shared / f.name)
   os.chmod(shared / f.name, 0o644)
 except OSError as exc:
  raise BoundaryError("verifier_boundary_unavailable:inbox:" + type(exc).__name__)
 proc = subprocess.run(["sudo", "-n", "-u", user, SYSTEM_PYTHON, "-I", "-S", str(vw.INSTALL_DIR / "verifier_worker.py"),
  "--os-user", "--inputs", str(shared)], cwd="/", timeout=timeout, capture_output=True, text=True,
  env={"PATH": "/usr/bin:/bin"})
 if proc.returncode == 3 or (proc.returncode and "sudo:" in proc.stderr):
  raise BoundaryError("verifier_boundary_unavailable:" + (proc.stderr.strip().splitlines() or ["?"])[-1][:200])
 produced = vw.OS_OUT / nonce
 if produced.is_dir():
  # A broker-side copy; the verifier's own directory stays read-only to this account.
  shutil.copytree(produced, out_dir)
 return proc, "os-user:" + user


def launch_verifier(inputs, key_path, key_id, out_dir, timeout=30, boundary=None, verifier_user=vw.VERIFIER_USER):
 if boundary == "os-user":
  return launch_os_user_verifier(inputs, out_dir, verifier_user)
 if boundary is not None:
  raise BoundaryError("unknown_boundary")
 prefix, mode = isolation_prefix()
 work = Path(tempfile.mkdtemp(prefix="pi-verifier-home-"))
 try:
  proc = subprocess.run(prefix + [sys.executable, "-I", str(WORKER), "--inputs", str(inputs), "--key", str(key_path),
   "--key-id", key_id, "--out", str(out_dir)], cwd=work, timeout=timeout, capture_output=True, text=True,
   env={"PATH": os.environ.get("PATH", ""), "HOME": str(work)})
 finally:
  shutil.rmtree(work, ignore_errors=True)
 return proc, mode


def accept_attestation(q, root, registry, out_dir, allow_unisolated=False, require_identity=None):
 """Return (accepted, reason, attestation). Accepting consumes the nonce exactly once."""
 _ensure(q)
 out_dir = Path(out_dir)
 try:
  data = (out_dir / "attestation.json").read_bytes()
  sig = (out_dir / "attestation.sig").read_bytes()
  att = json.loads(data)
 except (OSError, ValueError):
  return False, "attestation_unreadable", None
 if not isinstance(att, dict) or set(att) != ATTESTATION_KEYS or att["schema"] != ATTESTATION_SCHEMA or canonical(att) != data:
  return False, "attestation_malformed", None
 entry = registry.get(att["key_id"])
 if not entry or entry["role"] != "verifier":
  return False, "identity_not_registered_verifier", att
 if not verify_signature(entry["public_pem"], data, sig):
  return False, "bad_signature", att
 if att["passed"] is not (att["reason"] == "ok" and att["exit_code"] == 0 and att["candidate_sha256_after"] == att["candidate_sha256"]):
  return False, "inconsistent_result", att
 if require_identity is not None and not separate_identity(entry, att, require_identity):
  q._event(att["task_id"], "attestation_rejected", {"reason": "identity_not_separate", "nonce": att["nonce"]})
  return False, "identity_not_separate", att
 if att["passed"] and att["harness_isolation"] not in ISOLATED_HARNESS and not allow_unisolated:
  # Fail closed: an unisolated harness lets candidate code read the verifier key (see VERIFIER_BOUNDARY.md).
  q._event(att["task_id"], "attestation_rejected", {"reason": "harness_not_isolated", "nonce": att["nonce"]})
  return False, "harness_not_isolated", att
 with q.db:
  q.db.execute("BEGIN IMMEDIATE")
  ch = q.db.execute("SELECT * FROM verifier_challenges WHERE nonce=?", (att["nonce"],)).fetchone()
  task = _row(q, att["task_id"])
  reason = None
  if not ch or ch["task_id"] != att["task_id"]:
   reason = "unknown_challenge"
  elif ch["used_at"] is not None:
   reason = "replayed_challenge"
  elif q.now() > ch["expires_at"]:
   reason = "stale_challenge"
  elif not task or task["status"] != "running" or task["attempts"] != ch["attempt"] or att["attempt"] != ch["attempt"]:
   reason = "superseded_challenge"
  elif (att["proposal_ref"], att["implementation_ref"], att["candidate_sha256"]) != (ch["proposal_ref"], ch["implementation_ref"], ch["candidate_sha256"]):
   reason = "attestation_challenge_mismatch"
  else:
   impl_task = _row(q, task["parent_id"])
   prop_task = _row(q, impl_task["parent_id"])
   if (prop_task["evidence_ref"], impl_task["evidence_ref"]) != (ch["proposal_ref"], ch["implementation_ref"]):
    reason = "queue_record_changed"
   else:
    try:
     implementation = handoff.read(root, impl_task["evidence_ref"], "implementation")
     handoff.read(root, prop_task["evidence_ref"], "proposal")
     if candidate_sha(root, implementation) != ch["candidate_sha256"]:
      reason = "candidate_changed"
    except handoff.HandoffError as exc:
     reason = "workspace_handoff_" + str(exc)
  if reason:
   q._event(att["task_id"] if task else "unknown", "attestation_rejected", {"reason": reason, "nonce": att["nonce"]})
   return False, reason, att
  q.db.execute("""UPDATE verifier_challenges SET used_at=?, key_id=?, attestation=?, signature=?
   WHERE nonce=? AND used_at IS NULL""", (q.now(), att["key_id"], data.decode("ascii"), sig.hex(), att["nonce"]))
  q._event(att["task_id"], "attestation_accepted", {"nonce": att["nonce"], "key_id": att["key_id"], "passed": att["passed"]})
 return True, att["reason"], att


def separate_identity(entry, att, required):
 """The registry (root-provisioned) and the signed attestation must both say the separate identity was used."""
 if required != "os-user":
  return False
 ident = entry.get("identity") or {}
 return (ident.get("mode") == "os-user" and ident.get("user") == vw.VERIFIER_USER
  and att.get("identity_mode") == "os-user" and att.get("harness_isolation") == "os-user")


def run_verification(q, root, registry, broker_dir, key_path, key_id, acceptance, worker_label=None, mutate=None, ttl=60,
  allow_unisolated=False, boundary=None, require_identity=None, verifier_user=vw.VERIFIER_USER):
 """Claim the verifier task, challenge, launch the worker, accept, then settle via queue review."""
 worker = worker_label or "verifier-" + (key_id or boundary or "unknown")[:16]
 claim = q.claim("verifier", worker, lease_seconds=60)
 if not claim:
  raise BoundaryError("no_verifier_task")
 impl_id = _row(q, claim["id"])["parent_id"]
 try:
  ch, inputs = issue_challenge(q, root, claim["id"], broker_dir, acceptance, ttl)
 except (handoff.HandoffError, BoundaryError) as exc:
  # Fail the attempt explicitly instead of leaving the task running until lease expiry.
  ref = "verifier-challenge-refused:" + str(exc)[:60]
  q.finish(claim["id"], worker, "challenge refused", ref)
  q.review(claim["id"], "reviewer:broker", False, ref)
  q.review(impl_id, "reviewer:attested-none", False, ref)
  return {"challenge": None, "accepted": False, "reason": "challenge_refused:" + str(exc), "passed": False, "isolation": None, "worker_exit": None}
 out = Path(broker_dir) / ("out-" + ch["nonce"])
 try:
  proc, mode = launch_verifier(inputs, key_path, key_id, out, boundary=boundary, verifier_user=verifier_user)
 except (BoundaryError, OSError, subprocess.TimeoutExpired) as exc:
  # Fail closed: no fallback to a same-account verifier. The attempt is spent and recorded.
  ref = "verifier-boundary-unavailable:" + ch["nonce"]
  q.finish(claim["id"], worker, "boundary unavailable", ref)
  q.review(claim["id"], "reviewer:broker", False, ref)
  q.review(impl_id, "reviewer:attested-none", False, ref)
  return {"challenge": ch, "accepted": False, "reason": "verifier_boundary_unavailable", "detail": str(exc)[:300],
   "passed": False, "isolation": None, "worker_exit": None}
 if mutate:
  mutate(ch, out)
 accepted, reason, att = accept_attestation(q, root, registry, out, allow_unisolated, require_identity)
 passed = bool(accepted and att["passed"])
 ref = "verifier-attestation:" + ch["nonce"]
 q.finish(claim["id"], worker, "attestation " + ("accepted" if accepted else "rejected") + ":" + reason, ref)
 q.review(claim["id"], "reviewer:broker", passed, ref)
 q.review(impl_id, "reviewer:attested-" + (att["key_id"][:16] if accepted else "none"), passed, ref)
 return {"challenge": ch, "accepted": accepted, "reason": reason, "passed": passed, "isolation": mode,
  "worker_exit": proc.returncode}


NEXT_TASK = {"id": "next-regression", "role": "claude", "action": "plan", "depth": 0,
 "goal": "Propose one additional bounded regression case for the verified arithmetic fixture",
 "acceptance": ["One case, fixture-only, no new permissions"]}


def attested_pass(q, registry, implementation_id, allow_unisolated=False, require_identity=None):
 """Re-verify a durable result from the database and trust registry alone. Row flags are never trusted."""
 _ensure(q)
 row = _row(q, implementation_id)
 if not row or row["status"] != "verified" or not (row["review_ref"] or "").startswith("verifier-attestation:"):
  return False
 nonce = row["review_ref"].split(":", 1)[1]
 ch = q.db.execute("SELECT * FROM verifier_challenges WHERE nonce=?", (nonce,)).fetchone()
 if not ch or ch["used_at"] is None or not ch["attestation"] or not ch["signature"]:
  return False
 data = ch["attestation"].encode("ascii")
 try:
  att = json.loads(data)
  sig = bytes.fromhex(ch["signature"])
 except ValueError:
  return False
 if not isinstance(att, dict) or set(att) != ATTESTATION_KEYS or canonical(att) != data or att["schema"] != ATTESTATION_SCHEMA:
  return False
 entry = registry.get(att["key_id"])
 if not entry or entry["role"] != "verifier" or att["key_id"] != ch["key_id"] or not verify_signature(entry["public_pem"], data, sig):
  return False
 if att["nonce"] != nonce or att["task_id"] != ch["task_id"] or att["passed"] is not True or att["reason"] != "ok":
  return False
 if att["harness_isolation"] not in ISOLATED_HARNESS and not allow_unisolated:
  return False
 if require_identity is not None and not separate_identity(entry, att, require_identity):
  return False
 child = _row(q, att["task_id"])
 if not child or child["role"] != "verifier" or child["parent_id"] != implementation_id or child["status"] != "verified":
  return False
 return att["implementation_ref"] == ch["implementation_ref"] == row["evidence_ref"]


def queue_next_task(q, implementation_id, registry, allow_unisolated=False, require_identity=None):
 """Durable result -> next bounded task: only after the stored attestation re-verifies against the registry."""
 if not attested_pass(q, registry, implementation_id, allow_unisolated, require_identity):
  return "not_attested"
 return q.submit(dict(NEXT_TASK))

