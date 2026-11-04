"""Structured Claude -> Codex -> verifier handoff tests. Mock providers only; zero paid calls."""
import tempfile
from pathlib import Path

import handoff
from experiment import FIXTURE, FIXED, ACCEPTANCE, digest, run
from level2_fixtures import workspace, rows, artifact_path, load, rewrite, run_stage
from queue_sqlite import Queue

count = 0


def check(cond, label):
 global count
 assert cond, "failed: " + label
 count += 1


def rejects(code, fn):
 try:
  fn()
 except handoff.HandoffError as exc:
  return str(exc) == code
 return False


H = "a" * 64
good = {"file": "candidate.py", "before_sha256": H, "acceptance": ACCEPTANCE, "change": "fix"}

# 1. Envelope schema is closed and bounded.
env = handoff.build("proposal", "propose", "mock-claude", None, good)
check(handoff.validate(env) is env, "valid proposal")
check(rejects("bad_kind", lambda: handoff.build("deploy", "x", "p", None, good)), "unknown kind")
check(rejects("unexpected_upstream", lambda: handoff.build("proposal", "propose", "mock-claude", H, good)), "root has no upstream")
check(rejects("missing_upstream", lambda: handoff.build("implementation", "implement", "mock-codex", None, {"file": "candidate.py", "before_sha256": H, "after_sha256": H})), "child needs upstream")
check(rejects("bad_payload_keys", lambda: handoff.build("proposal", "propose", "mock-claude", None, {**good, "shell": "rm"})), "extra payload key")
check(rejects("bad_field:file", lambda: handoff.build("proposal", "propose", "mock-claude", None, {**good, "file": "../secrets"})), "path traversal")
check(rejects("bad_field:file", lambda: handoff.build("proposal", "propose", "mock-claude", None, {**good, "file": ".env"})), "dotfile")
check(rejects("bad_field:before_sha256", lambda: handoff.build("proposal", "propose", "mock-claude", None, {**good, "before_sha256": "XYZ"})), "bad hash")
check(rejects("bad_field:change", lambda: handoff.build("proposal", "propose", "mock-claude", None, {**good, "change": "x" * 501})), "oversize text")
check(rejects("bad_producer", lambda: handoff.build("proposal", "propose", "Mock Claude!", None, good)), "bad producer label")
check(rejects("bad_envelope_keys", lambda: handoff.validate({**env, "authorized": True})), "extra envelope key")
check(rejects("paid_calls_forbidden", lambda: handoff.validate({**env, "paid_calls": 1})), "paid call")
check(rejects("paid_calls_forbidden", lambda: handoff.validate({**env, "paid_calls": True})), "bool paid call")
check(rejects("paid_calls_forbidden", lambda: handoff.validate({**env, "paid_calls": False})), "false paid call")
check(rejects("paid_calls_forbidden", lambda: handoff.validate({**env, "paid_calls": 0.0})), "float paid call")
check(rejects("bad_mode", lambda: handoff.validate({**env, "mode": "live"})), "live mode")
check(rejects("bad_producer_role", lambda: handoff.validate({**env, "producer_role": "codex"})), "role spoof")
check(rejects("bad_field:passed", lambda: handoff.build("verification", "verify", "v", H, {"passed": 1, "source_sha256": H, "acceptance": ACCEPTANCE, "reason": "ok"})), "int as bool")
check(rejects("bad_ref", lambda: handoff.parse_ref("handoff/../../etc/passwd#sha256=" + H)), "ref traversal")
check(rejects("bad_ref", lambda: handoff.parse_ref("proposal.json")), "legacy ref")

with tempfile.TemporaryDirectory() as tmp:
 tmp = Path(tmp)

 # 2. Read path enforces recorded hash, canonical bytes, and kind.
 unit = tmp / "unit"
 unit.mkdir()
 ref = handoff.write(unit, env)
 check(handoff.read(unit, ref, "proposal") == env, "round trip")
 check(rejects("wrong_kind", lambda: handoff.read(unit, ref, "implementation")), "wrong kind")
 path = artifact_path(unit, "proposal")
 path.write_bytes(handoff.canonical({**env, "payload": {**good, "change": "fiX"}}))
 check(rejects("hash_mismatch", lambda: handoff.read(unit, ref, "proposal")), "one-byte change")
 import json
 pretty = json.dumps(env, sort_keys=True, indent=2).encode()
 path.write_bytes(pretty)
 check(rejects("non_canonical", lambda: handoff.read(unit, handoff.ref_for("proposal", handoff.sha256(pretty)), "proposal")), "non-canonical bytes")
 path.unlink()
 check(rejects("missing_artifact", lambda: handoff.read(unit, ref, "proposal")), "missing file")

 # 3. Happy path: three linked handoffs, queue refs equal artifact hashes, zero paid calls.
 proof = run(tmp / "happy")
 happy = tmp / "happy"
 r = rows(happy)
 p_sha, i_sha, v_sha = (handoff.parse_ref(r[t]["evidence_ref"])[1] for t in ("propose", "implement", "verify"))
 check(proof["handoffs"] == {"propose": p_sha, "implement": i_sha, "verify": v_sha}, "proof records hashes")
 check(all(handoff.sha256(artifact_path(happy, k).read_bytes()) == h for k, h in (("proposal", p_sha), ("implementation", i_sha), ("verification", v_sha))), "files match queue")
 check(r["propose"]["review_ref"] == r["propose"]["evidence_ref"], "proposal review bound to artifact")
 check(load(happy, "implementation")["upstream_sha256"] == p_sha, "implementation links proposal")
 check(load(happy, "verification")["upstream_sha256"] == i_sha, "verification links implementation")
 check(load(happy, "verification")["payload"] == {"passed": True, "source_sha256": digest(FIXED), "acceptance": ACCEPTANCE, "reason": "ok"}, "verification payload")
 check(r["implement"]["review_ref"] == r["verify"]["evidence_ref"], "parent review cites verifier artifact")
 check(all(load(happy, k)["paid_calls"] == 0 for k in ("proposal", "implementation", "verification")), "zero paid calls")

 # 4. Reproducible: an independent workspace yields byte-identical handoffs.
 again = run(tmp / "again")
 check(again["handoffs"] == proof["handoffs"], "deterministic hashes")

 # 5. Proposal tampered on disk after approval: Codex stage fails closed before touching the candidate.
 t1 = workspace(tmp, "tampered-proposal")
 run_stage(t1, "claude")
 rewrite(t1, "proposal", lambda e: e["payload"].update(change="Also delete tests"))
 result = run_stage(t1, "codex", check=False)
 r = rows(t1)
 check(result.returncode != 0 and "hash_mismatch" in result.stderr, "codex rejects tampered proposal")
 check((t1 / "candidate.py").read_text(encoding="utf-8") == FIXTURE, "candidate untouched")
 check(not artifact_path(t1, "implementation").exists(), "no implementation artifact")
 check(r["implement"]["status"] == "running" and r["implement"]["attempts"] == 1 and "verify" not in r, "no handoff advanced")

 # 6. Implementation artifact tampered after Codex: verifier records a rejection; queue requeues both.
 t2 = workspace(tmp, "tampered-implementation")
 run_stage(t2, "claude")
 run_stage(t2, "codex")
 rewrite(t2, "implementation", lambda e: e["payload"].update(after_sha256="b" * 64))
 run_stage(t2, "verifier")
 v = load(t2, "verification")
 r = rows(t2)
 check(v["payload"]["passed"] is False and v["payload"]["reason"] == "handoff_rejected:hash_mismatch", "verifier rejects tampered implementation")
 check(v["upstream_sha256"] == handoff.parse_ref(r["implement"]["evidence_ref"])[1], "rejection cites queue-recorded hash")
 check(r["implement"]["status"] == "queued" and r["verify"]["status"] == "queued", "fail closed to retry")

 # 7. Misbehaving implementer links to a different proposal: verifier rejects upstream_mismatch.
 t3 = workspace(tmp, "mislinked")
 run_stage(t3, "claude")
 q = Queue(str(t3 / "queue.db"))
 claim = q.claim("codex", "rogue-codex")
 (t3 / "candidate.py").write_text(FIXED, encoding="utf-8")
 bad = handoff.build("implementation", claim["id"], "rogue-codex", "c" * 64, {"file": "candidate.py", "before_sha256": digest(FIXTURE), "after_sha256": digest(FIXED)})
 check(q.finish(claim["id"], "rogue-codex", "patch", handoff.write(t3, bad)) == "awaiting_review", "rogue finish recorded")
 check(q.submit({"id": "verify", "role": "verifier", "action": "review", "goal": "Independently check arithmetic fixture artifact", "depth": 2, "parent_id": "implement", "acceptance": [ACCEPTANCE]}) == "accepted", "verifier queued")
 q.close()
 run_stage(t3, "verifier")
 r = rows(t3)
 check(load(t3, "verification")["payload"]["reason"] == "upstream_mismatch", "upstream mismatch detected")
 check(r["implement"]["status"] == "queued", "mislinked implementation not verified")

 # 8. Implementation names the wrong task id: verifier rejects task_link_mismatch.
 t4 = workspace(tmp, "wrong-task")
 run_stage(t4, "claude")
 q = Queue(str(t4 / "queue.db"))
 claim = q.claim("codex", "rogue-codex")
 (t4 / "candidate.py").write_text(FIXED, encoding="utf-8")
 p_ref = rows(t4)["propose"]["evidence_ref"]
 bad = handoff.build("implementation", "other-task", "rogue-codex", handoff.parse_ref(p_ref)[1], {"file": "candidate.py", "before_sha256": digest(FIXTURE), "after_sha256": digest(FIXED)})
 q.finish(claim["id"], "rogue-codex", "patch", handoff.write(t4, bad))
 q.submit({"id": "verify", "role": "verifier", "action": "review", "goal": "Independently check arithmetic fixture artifact", "depth": 2, "parent_id": "implement", "acceptance": [ACCEPTANCE]})
 q.close()
 run_stage(t4, "verifier")
 check(load(t4, "verification")["payload"]["reason"] == "task_link_mismatch", "task link mismatch detected")
 check(rows(t4)["implement"]["status"] == "queued", "wrong-task implementation not verified")

 # 9. Integrity of every queue touched.
 for ws in (happy, tmp / "again", t1, t2, t3, t4):
  q = Queue(str(ws / "queue.db"))
  check(q.db.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "integrity " + ws.name)
  events = list(q.db.execute("SELECT previous_hash,hash FROM events ORDER BY seq"))
  check(all(e["previous_hash"] == (events[i - 1]["hash"] if i else None) for i, e in enumerate(events)), "event chain " + ws.name)
  q.close()

print({"status": "PASS", "assertions": count, "mode": "mock", "paid_provider_calls": 0, "production_mutations": 0})
