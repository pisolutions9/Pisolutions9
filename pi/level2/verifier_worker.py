"""PI L2 verifier worker. Runs as its own process with its own Ed25519 key and NO queue database path.

It receives a broker-prepared input snapshot (challenge + copies of the handoffs and candidate), checks
hashes and ancestry, reproduces the acceptance check itself in a further child process, and signs an
attestation. It never reads implementation claims of success. Standard library plus system `openssl`.
Two identity modes:
 - simulated-local-key: the caller passes a local fixture key; same OS account as the broker (tests, dev).
 - os-user: the installed copy under /opt/pi-level2-verifier runs as the dedicated `pi-verifier` OS user via a
   narrow sudoers rule. Its key is fixed, owned by that user (0600 in a 0700 dir), unreadable by the broker or
   implementer account. Candidate code runs as a THIRD user, `pi-candidate`, through a root-owned wrapper with no
   network and its own pid/mount namespace. An installed or `pi-verifier`-run copy cannot be switched back to
   simulated mode, and it refuses to run (exit 3) when any part of that boundary is missing. See
   verifier_provision.py and VERIFIER_BOUNDARY.md.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import handoff  # noqa: E402

ATTESTATION_SCHEMA = "pi.level2.attestation.v1"
# Acceptance suites are fixed in the verifier, keyed by the trusted task contract string.
# Model output is never evaluated as an expression. The pass/fail decision is made HERE, by comparing the
# candidate's outputs with a verifier-held oracle; the candidate's own exit code is never sufficient, because
# code running in the harness can escape exec() (for example via BuiltinImporter) and exit 0 early.
SUITES = {
 "add(2, 3) == 5 and add(-2, 1) == -1": {"function": "add", "oracle": "add", "random_cases": 8,
  "cases": [[2, 3], [-2, 1], [0, 0], [10, -4]]},
}
ORACLES = {"add": lambda a, b: a + b}
MAX_HARNESS_OUTPUT = 65536
# The child receives inputs only, never expected values, and reports outputs; it decides nothing.
HARNESS = r"""
import json, sys
ns = {}
src = open(sys.argv[1], encoding="utf-8").read()
exec(compile(src, "candidate.py", "exec"), {"__builtins__": {}}, ns)
fn = ns.get(sys.argv[2])
inputs = json.loads(sys.stdin.read())
out = []
for args in inputs:
 try:
  value = fn(*args) if callable(fn) else None
 except Exception:
  value = None
 out.append(value if type(value) is int else None)
sys.stdout.write(json.dumps({"outputs": out}))
"""


def sha(data):
 return hashlib.sha256(data).hexdigest()


def canonical(obj):
 return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def case_inputs(suite, nonce):
 """Fixed cases plus held-out cases derived from the challenge nonce (fresh per challenge, reproducible from the record)."""
 cases = [list(c) for c in suite["cases"]]
 for i in range(suite["random_cases"]):
  h = hashlib.sha256(("%s:%d" % (nonce, i)).encode("ascii")).digest()
  cases.append([int.from_bytes(h[:8], "big", signed=True), int.from_bytes(h[8:16], "big", signed=True)])
 return cases


# The candidate harness for os-user mode reads everything from stdin, so the candidate user needs no file access.
HARNESS_STDIN = r"""
import json, sys
req = json.loads(sys.stdin.read())
ns = {}
try:
 exec(compile(req["source"], "candidate.py", "exec"), {"__builtins__": {}}, ns)
except Exception:
 ns = {}
fn = ns.get(req["function"])
out = []
for args in req["inputs"]:
 try:
  value = fn(*args) if callable(fn) else None
 except Exception:
  value = None
 out.append(value if type(value) is int else None)
sys.stdout.write(json.dumps({"outputs": out}))
"""

# Fixed locations of the provisioned OS-user boundary (written by verifier_provision.py as root).
INSTALL_DIR = Path("/opt/pi-level2-verifier")
STATE_DIR = Path("/var/lib/pi-level2-verifier")
OS_KEY = STATE_DIR / "keys" / "verifier.key"
OS_OUT = STATE_DIR / "out"
CANDIDATE_RUNNER = INSTALL_DIR / "run-candidate"
VERIFIER_USER, CANDIDATE_USER = "pi-verifier", "pi-candidate"
NONCE_RE = re.compile(r"[0-9a-f]{32}")
# The verifier's own code. Its combined hash is signed into every attestation and must equal the pinned value that
# root wrote into the registry at provisioning time (see verifier-pin.json).
CODE_FILES = ("verifier_worker.py", "handoff.py", "verifier_provision.py")


def code_sha256(directory):
 """sha256 over {file: sha256(bytes)} for the verifier code files in `directory`; None if any is missing."""
 try:
  files = {name: sha((Path(directory) / name).read_bytes()) for name in CODE_FILES}
 except OSError:
  return None
 return sha(canonical(files))


def _user_name(uid):
 try:
  import pwd
  return pwd.getpwuid(uid).pw_name
 except (ImportError, KeyError):
  return None


def os_user_forced():
 """The installed copy, or any copy run by the verifier account, is os-user only: no simulated fallback."""
 try:
  installed = Path(__file__).resolve().parent == INSTALL_DIR
 except OSError:
  installed = False
 return installed or (hasattr(os, "getuid") and _user_name(os.getuid()) == VERIFIER_USER)


def os_boundary_problems():
 """Every precondition of the os-user boundary, checked from inside the verifier process. [] means intact."""
 import stat
 problems = []
 if not hasattr(os, "getuid"):
  return ["not_posix"]
 uid = os.getuid()
 if _user_name(uid) != VERIFIER_USER:
  problems.append("not_running_as_" + VERIFIER_USER)
 for path, want_dir in ((OS_KEY.parent, True), (OS_KEY, False)):
  try:
   st = os.lstat(path)
  except OSError:
   problems.append("missing:" + str(path))
   continue
  if stat.S_ISLNK(st.st_mode) or (stat.S_ISDIR(st.st_mode) != want_dir):
   problems.append("wrong_type:" + str(path))
  if st.st_uid != uid or st.st_mode & 0o077:
   problems.append("not_private:" + str(path))
 try:
  st = os.lstat(CANDIDATE_RUNNER)
  if st.st_uid != 0 or st.st_mode & 0o022 or stat.S_ISLNK(st.st_mode):
   problems.append("candidate_runner_not_root_owned")
 except OSError:
  problems.append("missing:" + str(CANDIDATE_RUNNER))
 try:
  if subprocess.run(["sudo", "-n", "-l", str(CANDIDATE_RUNNER)], capture_output=True, timeout=10,
    env={"PATH": "/usr/bin:/bin"}, cwd="/").returncode != 0:
   problems.append("candidate_runner_not_permitted")
 except (OSError, subprocess.TimeoutExpired):
  problems.append("sudo_unavailable")
 return problems


def reproduce_os_user(candidate_bytes, suite, nonce):
 """Run the candidate as the separate candidate OS user (no network, own pid/mount ns); judge outputs here.

 The candidate only ever sees its source and inputs on stdin. The verifier keeps the bytes in memory, so the
 after-hash is of the bytes it actually tested."""
 inputs = case_inputs(suite, nonce)
 expected = [ORACLES[suite["oracle"]](*args) for args in inputs]
 matched = False
 try:
  source = candidate_bytes.decode("utf-8")
 except UnicodeDecodeError:
  return 65, sha(candidate_bytes), False, "os-user"
 try:
  proc = subprocess.run(["sudo", "-n", str(CANDIDATE_RUNNER)], cwd="/", env={"PATH": "/usr/bin:/bin"},
   input=json.dumps({"source": source, "function": suite["function"], "inputs": inputs}).encode("utf-8"),
   capture_output=True, timeout=20)
  code = proc.returncode
  if len(proc.stdout) <= MAX_HARNESS_OUTPUT:
   try:
    outputs = json.loads(proc.stdout.decode("ascii"))["outputs"]
    matched = isinstance(outputs, list) and len(outputs) == len(expected) and all(
     type(o) is int and o == e for o, e in zip(outputs, expected))
   except (ValueError, KeyError, TypeError, UnicodeDecodeError):
    matched = False
 except subprocess.TimeoutExpired:
  code = 124
 return code, sha(candidate_bytes), matched, "os-user"


HIDE_SCRIPT = 'while [ "$1" != "--" ]; do mount -t tmpfs -o size=4k,mode=700 tmpfs "$1" || exit 97; shift; done; shift; exec "$@"'


def harness_prefix(hide):
 """Isolate candidate code from verifier secrets: new user+mount+pid+net namespaces with `hide` dirs covered.

 Candidate code CAN escape exec() (BuiltinImporter -> posix). Without this, it can read the verifier's private key
 through the parent's command line or /proc/<pid>/root. Returns (prefix, mode); mode "ns-hidden" or "none".
 """
 probe = ["unshare", "-rnmp", "--fork", "--mount-proc", "sh", "-c", "mount -t tmpfs -o size=4k tmpfs /mnt"]
 try:
  if subprocess.run(probe, capture_output=True, timeout=5, env={"PATH": "/usr/bin:/bin"}).returncode == 0:
   return (["unshare", "-rnmp", "--fork", "--mount-proc", "sh", "-c", HIDE_SCRIPT, "sh"]
    + [str(Path(d).resolve()) for d in hide] + ["--"]), "ns-hidden"
 except (FileNotFoundError, subprocess.TimeoutExpired):
  pass
 return [], "none"


def reproduce(candidate_bytes, suite, nonce, hide=()):
 """Run the candidate on a private copy in a child interpreter; judge its outputs against the oracle here."""
 inputs = case_inputs(suite, nonce)
 expected = [ORACLES[suite["oracle"]](*args) for args in inputs]
 private = Path(tempfile.mkdtemp(prefix="pi-verify-"))
 try:
  path = private / "candidate.py"
  path.write_bytes(candidate_bytes)
  matched = False
  try:
   prefix, mode = harness_prefix(hide)
   proc = subprocess.run(prefix + [sys.executable, "-I", "-S", "-c", HARNESS, str(path), suite["function"]],
    cwd=private, env={"PATH": "/usr/bin:/bin"} if prefix else {}, input=json.dumps(inputs).encode("ascii"),
    capture_output=True, timeout=10)
   code = proc.returncode
   if len(proc.stdout) <= MAX_HARNESS_OUTPUT:
    try:
     outputs = json.loads(proc.stdout.decode("ascii"))["outputs"]
     matched = isinstance(outputs, list) and len(outputs) == len(expected) and all(
      type(o) is int and o == e for o, e in zip(outputs, expected))
    except (ValueError, KeyError, TypeError, UnicodeDecodeError):
     matched = False
  except subprocess.TimeoutExpired:
   code, mode = 124, mode if "mode" in locals() else "none"
  return code, sha(path.read_bytes()), matched, mode
 finally:
  shutil.rmtree(private, ignore_errors=True)


def read_input(inputs, name, limit=1 << 20):
 """Read a regular input file without following symlinks (a link to the verifier key must not be read)."""
 import stat
 fd = os.open(str(Path(inputs) / name), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
 try:
  if not stat.S_ISREG(os.fstat(fd).st_mode):
   raise OSError("not_regular:" + name)
  data = b""
  while len(data) <= limit:
   chunk = os.read(fd, 65536)
   if not chunk:
    return data
   data += chunk
  raise OSError("too_large:" + name)
 finally:
  os.close(fd)


def evaluate(inputs, hide=(), os_user=False):
 ch = json.loads(read_input(inputs, "challenge.json").decode("ascii"))
 proposal_bytes = read_input(inputs, "proposal.json")
 impl_bytes = read_input(inputs, "implementation.json")
 candidate = read_input(inputs, "candidate.bin")
 result = {"exit_code": None, "candidate_sha256_after": None, "harness_isolation": "not_run", "subject_mode": None}
 _, p_sha = handoff.parse_ref(ch["proposal_ref"])
 _, i_sha = handoff.parse_ref(ch["implementation_ref"])
 if sha(proposal_bytes) != p_sha or sha(impl_bytes) != i_sha:
  return "handoff_hash_mismatch", result
 try:
  proposal = handoff.validate(json.loads(proposal_bytes))
  impl = handoff.validate(json.loads(impl_bytes))
 except (handoff.HandoffError, ValueError):
  return "handoff_invalid", result
 if handoff.canonical(proposal) != proposal_bytes or handoff.canonical(impl) != impl_bytes:
  return "handoff_non_canonical", result
 if proposal["kind"] != "proposal" or impl["kind"] != "implementation":
  return "handoff_wrong_kind", result
 if impl["task_id"] != ch["implementation_task"] or proposal["task_id"] != ch["proposal_task"]:
  return "task_link_mismatch", result
 # The provider mode of what is being verified (mock vs real CLI output) is signed into the attestation.
 result["subject_mode"] = impl["mode"] if impl["mode"] == proposal["mode"] else "mixed"
 if impl["upstream_sha256"] != p_sha:
  return "upstream_mismatch", result
 if impl["payload"]["file"] != proposal["payload"]["file"] or impl["payload"]["before_sha256"] != proposal["payload"]["before_sha256"]:
  return "proposal_scope_mismatch", result
 if sha(candidate) != ch["candidate_sha256"] or impl["payload"]["after_sha256"] != ch["candidate_sha256"]:
  return "candidate_hash_mismatch", result
 suite = SUITES.get(ch["acceptance"])
 if suite is None:
  return "unknown_acceptance", result
 if os_user:
  code, after, matched, mode = reproduce_os_user(candidate, suite, ch["nonce"])
 else:
  code, after, matched, mode = reproduce(candidate, suite, ch["nonce"], hide)
 result = {"exit_code": code, "candidate_sha256_after": after, "harness_isolation": mode, "subject_mode": result["subject_mode"]}
 if after != ch["candidate_sha256"]:
  return "candidate_mutated_during_test", result
 return ("ok" if code == 0 and matched else "acceptance_failed"), result


def sign(key_path, data):
 with tempfile.TemporaryDirectory() as d:
  msg = Path(d) / "m"
  sig = Path(d) / "s"
  msg.write_bytes(data)
  subprocess.run(["openssl", "pkeyutl", "-sign", "-inkey", str(key_path), "-rawin", "-in", str(msg), "-out", str(sig)],
   check=True, capture_output=True, timeout=10)
  return sig.read_bytes()


def public_key_id(key_path):
 der = subprocess.run(["openssl", "pkey", "-in", str(key_path), "-pubout", "-outform", "DER"],
  check=True, capture_output=True, timeout=10).stdout
 return sha(der)


def main():
 ap = argparse.ArgumentParser()
 ap.add_argument("--inputs", required=True)
 ap.add_argument("--key")
 ap.add_argument("--key-id")
 ap.add_argument("--out")
 ap.add_argument("--os-user", action="store_true", help="separate OS identity; implied for the installed copy")
 a = ap.parse_args()
 inputs = Path(a.inputs)
 if a.os_user or os_user_forced():
  # Caller-chosen key and output paths are ignored: they would let the broker account steer this identity.
  # PATH is pinned so that a writable directory earlier in sudo's secure_path cannot shadow openssl or sudo.
  os.environ.clear()
  os.environ["PATH"] = "/usr/bin:/bin"
  os.umask(0o022)
  problems = os_boundary_problems()
  if problems:
   sys.stderr.write(json.dumps({"error": "verifier_boundary_unavailable", "problems": problems}) + "\n")
   sys.exit(3)
  ch = json.loads(read_input(inputs, "challenge.json").decode("ascii"))
  if not isinstance(ch.get("nonce"), str) or not NONCE_RE.fullmatch(ch["nonce"]):
   sys.stderr.write(json.dumps({"error": "bad_nonce"}) + "\n")
   sys.exit(4)
  key, key_id, identity_mode = OS_KEY, public_key_id(OS_KEY), "os-user"
  code = code_sha256(INSTALL_DIR)
  out = OS_OUT / ch["nonce"]
  out.mkdir(mode=0o755)  # FileExistsError: never overwrite an earlier attestation for this nonce
  os.chmod(out, 0o755)
  reason, result = evaluate(inputs, os_user=True)
 else:
  if not (a.key and a.key_id and a.out):
   ap.error("--key, --key-id and --out are required in simulated mode")
  ch = json.loads(read_input(inputs, "challenge.json").decode("ascii"))
  key, key_id, identity_mode, out = a.key, a.key_id, "simulated-local-key", Path(a.out)
  code = code_sha256(Path(__file__).resolve().parent)
  out.mkdir(parents=True, exist_ok=True)  # must exist before it can be hidden
  # Hide the private key, the challenge inputs and the output directory from candidate code.
  reason, result = evaluate(inputs, hide=(Path(key).resolve().parent, inputs.resolve(), out.resolve()))
 attestation = {"schema": ATTESTATION_SCHEMA, "identity_mode": identity_mode, "nonce": ch["nonce"],
  "task_id": ch["task_id"], "attempt": ch["attempt"], "key_id": key_id,
  "proposal_ref": ch["proposal_ref"], "implementation_ref": ch["implementation_ref"],
  "candidate_sha256": ch["candidate_sha256"], "acceptance": ch["acceptance"],
  "exit_code": result["exit_code"], "candidate_sha256_after": result["candidate_sha256_after"],
  "harness_isolation": result["harness_isolation"], "verifier_code_sha256": code, "subject_mode": result["subject_mode"],
  "reason": reason, "passed": reason == "ok"}
 data = canonical(attestation)
 (out / "attestation.json").write_bytes(data)
 (out / "attestation.sig").write_bytes(sign(key, data))
 for name in ("attestation.json", "attestation.sig"):
  os.chmod(out / name, 0o644)
 print(json.dumps({"reason": reason, "passed": reason == "ok", "identity_mode": identity_mode}))


if __name__ == "__main__":
 main()

