"""Bounded, mock-provider Level 2 experiment. No network, credentials, or production paths."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from queue_sqlite import Queue

FIXTURE = "def add(a, b):\n    return a - b\n"
FIXED = "def add(a, b):\n    return a + b\n"
ACCEPTANCE = "add(2, 3) == 5 and add(-2, 1) == -1"


def digest(data):
 return hashlib.sha256(data.encode()).hexdigest()


def write_json(path, value):
 path.write_text(json.dumps(value, sort_keys=True, indent=2), encoding="utf-8")


def stage(root, name):
 root = Path(root).resolve()
 manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
 if manifest != {"schema": "pi.level2.experiment.v1", "mode": "mock", "paid_call_cap": 0, "max_attempts": 2, "max_depth": 2}:
  raise ValueError("invalid_manifest")
 q = Queue(str(root / "queue.db"))
 try:
  if name == "claude":
   claim = q.claim("claude", "mock-claude")
   if not claim: raise ValueError("proposal_not_queued")
   proposal = {"schema": "pi.level2.proposal.v1", "provider": "mock-claude", "task_id": claim["id"], "file": "candidate.py", "before_sha256": digest(FIXTURE), "acceptance": ACCEPTANCE, "change": "Correct add to use addition"}
   write_json(root / "proposal.json", proposal)
   assert q.finish(claim["id"], "mock-claude", "bounded proposal", "proposal.json") == "awaiting_review"
   assert q.review(claim["id"], "reviewer:broker", True, "proposal.json") == "verified"
   assert q.submit({"id":"implement", "role":"codex", "action":"write_patch", "goal":"Implement bounded arithmetic fixture proposal", "depth":1, "parent_id":"propose", "acceptance":[ACCEPTANCE]}) == "accepted"
  elif name == "codex":
   claim = q.claim("codex", "mock-codex")
   if not claim: raise ValueError("implementation_not_queued")
   proposal = json.loads((root / "proposal.json").read_text(encoding="utf-8"))
   if proposal["before_sha256"] != digest((root / "candidate.py").read_text(encoding="utf-8")) or proposal["file"] != "candidate.py" or proposal["acceptance"] != ACCEPTANCE:
    raise ValueError("proposal_mismatch")
   (root / "candidate.py").write_text(FIXED, encoding="utf-8")
   write_json(root / "implementation.json", {"schema":"pi.level2.implementation.v1", "provider":"mock-codex", "before_sha256":proposal["before_sha256"], "after_sha256":digest(FIXED), "file":"candidate.py"})
   assert q.finish(claim["id"], "mock-codex", "fixture implementation", "implementation.json") == "awaiting_review"
   assert q.submit({"id":"verify", "role":"verifier", "action":"review", "goal":"Independently check arithmetic fixture artifact", "depth":2, "parent_id":"implement", "acceptance":[ACCEPTANCE]}) == "accepted"
  elif name == "verifier":
   claim = q.claim("verifier", "independent-verifier")
   if not claim: raise ValueError("verification_not_queued")
   implementation = json.loads((root / "implementation.json").read_text(encoding="utf-8"))
   source = (root / "candidate.py").read_text(encoding="utf-8")
   # The verifier recomputes hashes and executes the acceptance check in its own process.
   passed = implementation["before_sha256"] == digest(FIXTURE) and implementation["after_sha256"] == digest(source) and source == FIXED
   if passed:
    namespace = {}
    exec(compile(source, "candidate.py", "exec"), {"__builtins__": {}}, namespace)
    passed = namespace["add"](2, 3) == 5 and namespace["add"](-2, 1) == -1
   write_json(root / "verification.json", {"schema":"pi.level2.verification.v1", "verifier":"independent-process", "passed":passed, "source_sha256":digest(source), "acceptance":ACCEPTANCE})
   assert q.finish(claim["id"], "independent-verifier", "acceptance checked", "verification.json") == "awaiting_review"
   assert q.review("implement", "reviewer:independent-process", passed, "verification.json") in ("verified", "queued")
   assert q.review("verify", "reviewer:broker", passed, "verification.json") in ("verified", "queued")
  else: raise ValueError("unknown_stage")
 finally: q.close()


def run(root):
 root = Path(root).resolve()
 root.mkdir(parents=True, exist_ok=True)
 if any(root.iterdir()): raise ValueError("workspace_must_be_empty")
 (root / "candidate.py").write_text(FIXTURE, encoding="utf-8")
 write_json(root / "manifest.json", {"schema":"pi.level2.experiment.v1", "mode":"mock", "paid_call_cap":0, "max_attempts":2, "max_depth":2})
 q = Queue(str(root / "queue.db"))
 try:
  assert q.submit({"id":"propose", "role":"claude", "action":"plan", "goal":"Propose a bounded arithmetic fixture correction", "depth":0, "acceptance":[ACCEPTANCE]}) == "accepted"
 finally: q.close()
 for role in ("claude", "codex", "verifier"):
  subprocess.run([sys.executable, str(Path(__file__).resolve()), "stage", str(root), role], check=True, timeout=20, cwd=root, env={"PATH":os.environ.get("PATH", ""), "SYSTEMROOT":os.environ.get("SYSTEMROOT", "")})
 q = Queue(str(root / "queue.db"))
 try:
  rows = q.rows()
  proof = {"schema":"pi.level2.proof.v1", "mode":"mock", "stages":["mock-claude", "mock-codex", "independent-process-verifier"], "statuses":{r["id"]:r["status"] for r in rows}, "attempts":{r["id"]:r["attempts"] for r in rows}, "events":q.db.execute("SELECT COUNT(*) FROM events").fetchone()[0], "paid_provider_calls":0, "spent_usd":0, "production_mutations":0, "candidate_sha256":digest((root / "candidate.py").read_text(encoding="utf-8"))}
  if set(proof["statuses"].values()) != {"verified"} or any(n != 1 for n in proof["attempts"].values()): raise AssertionError("experiment_failed")
  write_json(root / "proof.json", proof)
  return proof
 finally: q.close()


if __name__ == "__main__":
 parser = argparse.ArgumentParser()
 parser.add_argument("command", choices=["run", "stage"])
 parser.add_argument("workspace")
 parser.add_argument("role", nargs="?")
 args = parser.parse_args()
 if args.command == "stage": stage(args.workspace, args.role)
 else: print(json.dumps(run(args.workspace), sort_keys=True))

