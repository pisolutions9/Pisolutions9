"""PI L2 verifier worker. Runs as its own process with its own Ed25519 key and NO queue database path.

It receives a broker-prepared input snapshot (challenge + copies of the handoffs and candidate), checks
hashes and ancestry, reproduces the acceptance check itself in a further child process, and signs an
attestation. It never reads implementation claims of success. Standard library plus system `openssl`.
Identity is a locally generated key, i.e. SIMULATED: it is not bound to an OS account or external service.
"""
import argparse
import hashlib
import json
import os
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


def evaluate(inputs, hide=()):
 ch = json.loads((inputs / "challenge.json").read_text(encoding="ascii"))
 proposal_bytes = (inputs / "proposal.json").read_bytes()
 impl_bytes = (inputs / "implementation.json").read_bytes()
 candidate = (inputs / "candidate.bin").read_bytes()
 result = {"exit_code": None, "candidate_sha256_after": None, "harness_isolation": "not_run"}
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
 if impl["upstream_sha256"] != p_sha:
  return "upstream_mismatch", result
 if impl["payload"]["file"] != proposal["payload"]["file"] or impl["payload"]["before_sha256"] != proposal["payload"]["before_sha256"]:
  return "proposal_scope_mismatch", result
 if sha(candidate) != ch["candidate_sha256"] or impl["payload"]["after_sha256"] != ch["candidate_sha256"]:
  return "candidate_hash_mismatch", result
 suite = SUITES.get(ch["acceptance"])
 if suite is None:
  return "unknown_acceptance", result
 code, after, matched, mode = reproduce(candidate, suite, ch["nonce"], hide)
 result = {"exit_code": code, "candidate_sha256_after": after, "harness_isolation": mode}
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


def main():
 ap = argparse.ArgumentParser()
 ap.add_argument("--inputs", required=True)
 ap.add_argument("--key", required=True)
 ap.add_argument("--key-id", required=True)
 ap.add_argument("--out", required=True)
 a = ap.parse_args()
 inputs = Path(a.inputs)
 ch = json.loads((inputs / "challenge.json").read_text(encoding="ascii"))
 Path(a.out).mkdir(parents=True, exist_ok=True)  # must exist before it can be hidden
 # Hide the private key, the challenge inputs and the output directory from candidate code.
 reason, result = evaluate(inputs, hide=(Path(a.key).resolve().parent, inputs.resolve(), Path(a.out).resolve()))
 attestation = {"schema": ATTESTATION_SCHEMA, "identity_mode": "simulated-local-key", "nonce": ch["nonce"],
  "task_id": ch["task_id"], "attempt": ch["attempt"], "key_id": a.key_id,
  "proposal_ref": ch["proposal_ref"], "implementation_ref": ch["implementation_ref"],
  "candidate_sha256": ch["candidate_sha256"], "acceptance": ch["acceptance"],
  "exit_code": result["exit_code"], "candidate_sha256_after": result["candidate_sha256_after"],
  "harness_isolation": result["harness_isolation"],
  "reason": reason, "passed": reason == "ok"}
 data = canonical(attestation)
 out = Path(a.out)
 out.mkdir(parents=True, exist_ok=True)
 (out / "attestation.json").write_bytes(data)
 (out / "attestation.sig").write_bytes(sign(a.key, data))
 print(json.dumps({"reason": reason, "passed": reason == "ok"}))


if __name__ == "__main__":
 main()

