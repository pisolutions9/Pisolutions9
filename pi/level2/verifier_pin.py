"""Content-addressed pin of the PI L2 verification LANE (verifier-pin.json).

The lane is every file that decides whether a signed result passes in the separate-identity CI job:
  installed as pi-verifier: verifier_worker.py (oracle, judgment, signing), handoff.py, verifier_provision.py
    (generates the candidate harness and the root wrapper);
  broker side: verifier_boundary.py (signature, identity and code-hash acceptance), queue_sqlite.py (status
    transitions), subscription_bridge.py (bundle scope), experiment.py and level2_fixtures.py (acceptance contract,
    stages), verifier-identity-test.py (the assertions that make CI pass);
  subject: proofs/subscription-proof6.bundle.json (the replayed real CLI recording).
Each is named by git blob id AND sha256. `code_sha256` covers the three installed files and is signed into every
attestation; `lane_sha256` covers the whole lane. CI rebuilds the lane from git objects and runs it from that copy,
so nothing from the PR working tree executes in the protected lane except the workflow file itself.

TRUST: a pin read from the PR under test is only a BOOTSTRAP pin: the PR chose it, so it gives no protection against
a malicious PR. Protection needs the pin (and the workflow file) supplied by a trusted base branch or an
owner-controlled source; see VERIFIER_BOUNDARY.md.

  python3 pi/level2/verifier_pin.py write   # after a reviewed lane change: re-pin
  python3 pi/level2/verifier_pin.py check   # fail if the working tree's lane differs from the pin (drift)
  python3 pi/level2/verifier_pin.py materialize PIN OUT_DIR   # rebuild pinned files from git objects, verify hashes
  python3 pi/level2/verifier_pin.py lane-hash DIR              # lane_sha256 of a directory (the test's self-check)
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PIN = HERE / "verifier-pin.json"
SCHEMA = "pi.level2.verifier-pin.v2"
sys.path.insert(0, str(HERE))
from verifier_worker import CODE_FILES, canonical  # noqa: E402

LANE_FILES = CODE_FILES + ("verifier_boundary.py", "queue_sqlite.py", "subscription_bridge.py", "experiment.py",
 "level2_fixtures.py", "verifier-identity-test.py", "proofs/subscription-proof6.bundle.json")


def _digest(mapping):
 return hashlib.sha256(canonical(mapping)).hexdigest()


def git(*args):
 return subprocess.run(["git", *args], cwd=HERE, capture_output=True, check=True).stdout


def committed_bytes(name):
 """Blob id and bytes as git stores the working-tree file (line-ending filters applied)."""
 blob = git("hash-object", "-w", "--", str(HERE / name)).decode().strip()
 return blob, git("cat-file", "blob", blob)


def current():
 files = {}
 for name in LANE_FILES:
  blob, data = committed_bytes(name)
  files[name] = {"git_blob": blob, "sha256": hashlib.sha256(data).hexdigest()}
 return {"schema": SCHEMA, "files": files,
  "code_sha256": _digest({n: files[n]["sha256"] for n in CODE_FILES}),
  "lane_sha256": _digest({n: f["sha256"] for n, f in files.items()})}


def lane_hash(directory):
 """lane_sha256 of the files as they are in `directory` (raw bytes); None if any is missing."""
 try:
  return _digest({n: hashlib.sha256((Path(directory) / n).read_bytes()).hexdigest() for n in LANE_FILES})
 except OSError:
  return None


def load(path):
 pin = json.loads(Path(path).read_text(encoding="ascii"))
 if pin.get("schema") != SCHEMA or set(pin.get("files", {})) != set(LANE_FILES):
  raise SystemExit("bad pin file")
 if _digest({n: pin["files"][n]["sha256"] for n in CODE_FILES}) != pin.get("code_sha256"):
  raise SystemExit("pin code_sha256 inconsistent with its file hashes")
 if _digest({n: f["sha256"] for n, f in pin["files"].items()}) != pin.get("lane_sha256"):
  raise SystemExit("pin lane_sha256 inconsistent with its file hashes")
 return pin


def materialize(pin_path, out):
 pin = load(pin_path)
 out = Path(out)
 out.mkdir(parents=True, exist_ok=False)
 for name, f in pin["files"].items():
  data = git("cat-file", "blob", f["git_blob"])  # fails if the pinned object is not in this clone
  if hashlib.sha256(data).hexdigest() != f["sha256"]:
   raise SystemExit("pinned blob content mismatch: " + name)
  (out / name).parent.mkdir(parents=True, exist_ok=True)
  (out / name).write_bytes(data)
 return pin


def main():
 cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
 if cmd == "write":
  pin = current()
  PIN.write_text(json.dumps(pin, sort_keys=True, indent=1) + "\n", encoding="ascii")
  print(json.dumps({"code_sha256": pin["code_sha256"], "lane_sha256": pin["lane_sha256"]}))
 elif cmd == "check":
  pin, now = load(PIN), current()
  drift = sorted(n for n in LANE_FILES if pin["files"][n]["sha256"] != now["files"][n]["sha256"])
  print(json.dumps({"pin_lane": pin["lane_sha256"], "working_tree_lane": now["lane_sha256"], "drift": drift}))
  if drift:
   raise SystemExit("FAIL: verification lane differs from verifier-pin.json; review the change, then `verifier_pin.py write`")
 elif cmd == "materialize":
  pin = materialize(sys.argv[2], sys.argv[3])
  print(json.dumps({"materialized_lane": pin["lane_sha256"], "out": sys.argv[3]}))
 elif cmd == "lane-hash":
  print(lane_hash(sys.argv[2]))
 else:
  raise SystemExit("usage: verifier_pin.py write|check|materialize PIN OUT|lane-hash DIR")


if __name__ == "__main__":
 main()
