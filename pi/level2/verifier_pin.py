"""Content-addressed pin of the PI L2 verifier code (verifier-pin.json).

The pin names each verifier code file by its git blob id AND sha256 of the committed bytes, plus the combined
code_sha256 that the worker signs into every attestation. CI rebuilds the verifier from those git objects (never from
the PR working tree), so a change under review cannot replace the verifier that judges it. Blob ids are content
addresses: the pin survives rebases and re-created commits.

  python3 pi/level2/verifier_pin.py write   # after a reviewed verifier change: re-pin
  python3 pi/level2/verifier_pin.py check   # fail if the working tree's verifier differs from the pin (drift)
  python3 pi/level2/verifier_pin.py materialize PIN OUT_DIR   # rebuild pinned files from git objects, verify hashes
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PIN = HERE / "verifier-pin.json"
SCHEMA = "pi.level2.verifier-pin.v1"
sys.path.insert(0, str(HERE))
from verifier_worker import CODE_FILES, canonical  # noqa: E402


def git(*args, data=None):
 return subprocess.run(["git", *args], cwd=HERE, input=data, capture_output=True, check=True).stdout


def committed_bytes(name):
 """Blob id and bytes as git would store the working-tree file (line-ending filters applied)."""
 blob = git("hash-object", "-w", "--", str(HERE / name)).decode().strip()
 return blob, git("cat-file", "blob", blob)


def current():
 files = {}
 for name in CODE_FILES:
  blob, data = committed_bytes(name)
  files[name] = {"git_blob": blob, "sha256": hashlib.sha256(data).hexdigest()}
 code = hashlib.sha256(canonical({n: f["sha256"] for n, f in files.items()})).hexdigest()
 return {"schema": SCHEMA, "files": files, "code_sha256": code}


def load(path):
 pin = json.loads(Path(path).read_text(encoding="ascii"))
 if pin.get("schema") != SCHEMA or set(pin.get("files", {})) != set(CODE_FILES):
  raise SystemExit("bad pin file")
 code = hashlib.sha256(canonical({n: f["sha256"] for n, f in pin["files"].items()})).hexdigest()
 if code != pin.get("code_sha256"):
  raise SystemExit("pin code_sha256 inconsistent with its file hashes")
 return pin


def materialize(pin_path, out):
 pin = load(pin_path)
 out = Path(out)
 out.mkdir(parents=True, exist_ok=False)
 for name, f in pin["files"].items():
  data = git("cat-file", "blob", f["git_blob"])  # fails if the pinned object is not in this clone
  if hashlib.sha256(data).hexdigest() != f["sha256"]:
   raise SystemExit("pinned blob content mismatch: " + name)
  (out / name).write_bytes(data)
 return pin


def main():
 cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
 if cmd == "write":
  pin = current()
  PIN.write_text(json.dumps(pin, sort_keys=True, indent=1) + "\n", encoding="ascii")
  print(json.dumps({"pinned": pin["code_sha256"]}))
 elif cmd == "check":
  pin, now = load(PIN), current()
  drift = sorted(n for n in CODE_FILES if pin["files"][n]["sha256"] != now["files"][n]["sha256"])
  print(json.dumps({"pin": pin["code_sha256"], "working_tree": now["code_sha256"], "drift": drift}))
  if drift:
   raise SystemExit("FAIL: verifier code differs from verifier-pin.json; review the change, then run `verifier_pin.py write`")
 elif cmd == "materialize":
  pin = materialize(sys.argv[2], sys.argv[3])
  print(json.dumps({"materialized": pin["code_sha256"], "out": sys.argv[3]}))
 else:
  raise SystemExit("usage: verifier_pin.py write|check|materialize PIN OUT")


if __name__ == "__main__":
 main()
