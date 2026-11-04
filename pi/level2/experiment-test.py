import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from experiment import run, stage, digest, FIXTURE, ACCEPTANCE, write_json
from queue_sqlite import Queue

with tempfile.TemporaryDirectory() as tmp:
 root = Path(tmp) / "demo"
 proof = run(root)
 assert proof["statuses"] == {"propose":"verified", "implement":"verified", "verify":"verified"}
 assert proof["attempts"] == {"propose":1, "implement":1, "verify":1}
 assert proof["paid_provider_calls"] == proof["spent_usd"] == proof["production_mutations"] == 0
 assert (root / "proof.json").exists()
 assert json.loads((root / "handoff" / "verification.json").read_text())["payload"]["passed"] is True
 q = Queue(str(root / "queue.db"))
 assert q.db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
 events = list(q.db.execute("SELECT previous_hash,hash FROM events ORDER BY seq"))
 assert all(e["previous_hash"] == (events[i-1]["hash"] if i else None) for i,e in enumerate(events))
 q.close()
 try:
  run(root)
  raise AssertionError("reused workspace")
 except ValueError as exc:
  assert str(exc) == "workspace_must_be_empty"

 tampered = Path(tmp) / "tampered"
 tampered.mkdir()
 (tampered / "candidate.py").write_text(FIXTURE, encoding="utf-8")
 write_json(tampered / "manifest.json", {"schema":"pi.level2.experiment.v1","mode":"mock","paid_call_cap":0,"max_attempts":2,"max_depth":2})
 q = Queue(str(tampered / "queue.db"))
 assert q.submit({"id":"propose","role":"claude","action":"plan","goal":"Propose bounded arithmetic fixture correction","depth":0,"acceptance":[ACCEPTANCE]}) == "accepted"
 q.close()
 for role in ("claude", "codex"):
  subprocess.run([sys.executable, str(Path(__file__).with_name("experiment.py").resolve()), "stage", str(tampered), role], check=True, timeout=20, cwd=tampered, env={"PATH":os.environ.get("PATH", ""), "SYSTEMROOT":os.environ.get("SYSTEMROOT", "")})
 (tampered / "candidate.py").write_text("def add(a, b):\n    return 0\n", encoding="utf-8")
 subprocess.run([sys.executable, str(Path(__file__).with_name("experiment.py").resolve()), "stage", str(tampered), "verifier"], check=True, timeout=20, cwd=tampered, env={"PATH":os.environ.get("PATH", ""), "SYSTEMROOT":os.environ.get("SYSTEMROOT", "")})
 assert json.loads((tampered / "handoff" / "verification.json").read_text(encoding="utf-8"))["payload"]["passed"] is False
 q = Queue(str(tampered / "queue.db"))
 assert {row["id"]:row["status"] for row in q.rows()} == {"propose":"verified","implement":"queued","verify":"queued"}
 q.close()

print({"status":"PASS", "mode":"mock", "paid_provider_calls":0, "production_mutations":0})

