"""Bounded, mock-provider Level 2 experiment. No network, credentials, or production paths."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from queue_sqlite import Queue
import handoff

FIXTURE = "def add(a, b):\n    return a - b\n"
FIXED = "def add(a, b):\n    return a + b\n"
ACCEPTANCE = "add(2, 3) == 5 and add(-2, 1) == -1"


def digest(data):
 return hashlib.sha256(data.encode()).hexdigest()


def write_json(path, value):
 path.write_text(json.dumps(value, sort_keys=True, indent=2), encoding="utf-8")


MANIFEST = {"schema": "pi.level2.experiment.v1", "mode": "mock", "paid_call_cap": 0, "max_attempts": 2, "max_depth": 2}


def task_row(q, tid):
 for row in q.rows():
  if row["id"] == tid: return row
 raise ValueError("unknown_task:" + tid)


def stage(root, name):
 root = Path(root).resolve()
 manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
 if manifest != MANIFEST:
  raise ValueError("invalid_manifest")
 q = Queue(str(root / "queue.db"))
 try:
  if name == "claude":
   claim = q.claim("claude", "mock-claude")
   if not claim: raise ValueError("proposal_not_queued")
   envelope = handoff.build("proposal", claim["id"], "mock-claude", None, {"file": "candidate.py", "before_sha256": digest(FIXTURE), "acceptance": ACCEPTANCE, "change": "Correct add to use addition"})
   ref = handoff.write(root, envelope)
   assert q.finish(claim["id"], "mock-claude", "bounded proposal", ref) == "awaiting_review"
   # Broker re-reads the artifact through the recorded hash before approving the proposal.
   handoff.read(root, task_row(q, claim["id"])["evidence_ref"], "proposal")
   assert q.review(claim["id"], "reviewer:broker", True, ref) == "verified"
   assert q.submit({"id":"implement", "role":"codex", "action":"write_patch", "goal":"Implement bounded arithmetic fixture proposal", "depth":1, "parent_id":"propose", "acceptance":[ACCEPTANCE]}) == "accepted"
  elif name == "codex":
   claim = q.claim("codex", "mock-codex")
   if not claim: raise ValueError("implementation_not_queued")
   task = task_row(q, claim["id"])
   parent = task_row(q, task["parent_id"])
   if parent["status"] != "verified": raise ValueError("proposal_not_verified")
   # Fails closed (non-zero exit, no file change, no finish) if the artifact differs from the queue record.
   proposal = handoff.read(root, parent["evidence_ref"], "proposal")
   _, proposal_sha = handoff.parse_ref(parent["evidence_ref"])
   plan = proposal["payload"]
   if proposal["task_id"] != parent["id"] or plan["file"] != "candidate.py" or plan["acceptance"] != ACCEPTANCE:
    raise ValueError("proposal_mismatch")
   if plan["before_sha256"] != digest((root / plan["file"]).read_text(encoding="utf-8")):
    raise ValueError("proposal_mismatch")
   (root / plan["file"]).write_text(FIXED, encoding="utf-8")
   envelope = handoff.build("implementation", claim["id"], "mock-codex", proposal_sha, {"file": plan["file"], "before_sha256": plan["before_sha256"], "after_sha256": digest(FIXED)})
   ref = handoff.write(root, envelope)
   assert q.finish(claim["id"], "mock-codex", "fixture implementation", ref) == "awaiting_review"
   assert q.submit({"id":"verify", "role":"verifier", "action":"review", "goal":"Independently check arithmetic fixture artifact", "depth":2, "parent_id":"implement", "acceptance":[ACCEPTANCE]}) == "accepted"
  elif name == "verifier":
   claim = q.claim("verifier", "independent-verifier")
   if not claim: raise ValueError("verification_not_queued")
   implement = task_row(q, task_row(q, claim["id"])["parent_id"])
   propose = task_row(q, implement["parent_id"])
   source = (root / "candidate.py").read_text(encoding="utf-8")
   passed, reason, upstream = False, "ok", None
   try:
    _, upstream = handoff.parse_ref(implement["evidence_ref"])
    implementation = handoff.read(root, implement["evidence_ref"], "implementation")
    proposal = handoff.read(root, propose["evidence_ref"], "proposal")
    _, proposal_sha = handoff.parse_ref(propose["evidence_ref"])
    work = implementation["payload"]
    if implementation["task_id"] != implement["id"] or proposal["task_id"] != propose["id"]:
     reason = "task_link_mismatch"
    elif implementation["upstream_sha256"] != proposal_sha:
     reason = "upstream_mismatch"
    elif work["file"] != proposal["payload"]["file"] or work["before_sha256"] != proposal["payload"]["before_sha256"]:
     reason = "proposal_scope_mismatch"
    elif work["before_sha256"] != digest(FIXTURE) or work["after_sha256"] != digest(source) or source != FIXED:
     reason = "source_mismatch"
    else:
     # The verifier recomputes hashes and executes the acceptance check in its own process.
     namespace = {}
     exec(compile(source, "candidate.py", "exec"), {"__builtins__": {}}, namespace)
     passed = namespace["add"](2, 3) == 5 and namespace["add"](-2, 1) == -1
     reason = "ok" if passed else "acceptance_failed"
   except handoff.HandoffError as exc:
    reason = "handoff_rejected:" + str(exc)[:40]
   envelope = handoff.build("verification", claim["id"], "independent-verifier", upstream or "0" * 64, {"passed": passed, "source_sha256": digest(source), "acceptance": ACCEPTANCE, "reason": reason})
   ref = handoff.write(root, envelope)
   assert q.finish(claim["id"], "independent-verifier", "acceptance checked", ref) == "awaiting_review"
   assert q.review("verify", "reviewer:broker", passed, ref) in ("verified", "queued")
   assert q.review("implement", "reviewer:independent-process", passed, ref) in ("verified", "queued")
  else: raise ValueError("unknown_stage")
 finally: q.close()


def seed(root):
 root = Path(root).resolve()
 root.mkdir(parents=True, exist_ok=True)
 if any(root.iterdir()): raise ValueError("workspace_must_be_empty")
 (root / "candidate.py").write_text(FIXTURE, encoding="utf-8")
 write_json(root / "manifest.json", MANIFEST)
 q = Queue(str(root / "queue.db"))
 try:
  assert q.submit({"id":"propose", "role":"claude", "action":"plan", "goal":"Propose a bounded arithmetic fixture correction", "depth":0, "acceptance":[ACCEPTANCE]}) == "accepted"
 finally: q.close()
 return root


def run_stage(root, role, check=True):
 return subprocess.run([sys.executable, str(Path(__file__).resolve()), "stage", str(root), role], check=check, timeout=20, cwd=root, capture_output=not check, text=True, env={"PATH":os.environ.get("PATH", ""), "SYSTEMROOT":os.environ.get("SYSTEMROOT", "")})


def run(root):
 root = seed(root)
 for role in ("claude", "codex", "verifier"):
  run_stage(root, role)
 q = Queue(str(root / "queue.db"))
 try:
  rows = q.rows()
  refs = {r["id"]: r["evidence_ref"] for r in rows}
  proof = {"schema":"pi.level2.proof.v1", "mode":"mock", "stages":["mock-claude", "mock-codex", "independent-process-verifier"], "statuses":{r["id"]:r["status"] for r in rows}, "attempts":{r["id"]:r["attempts"] for r in rows}, "events":q.db.execute("SELECT COUNT(*) FROM events").fetchone()[0], "paid_provider_calls":0, "spent_usd":0, "production_mutations":0, "candidate_sha256":digest((root / "candidate.py").read_text(encoding="utf-8")), "handoffs":{tid: handoff.parse_ref(ref)[1] for tid, ref in refs.items()}}
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

