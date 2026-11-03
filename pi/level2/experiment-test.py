import json
import tempfile
from pathlib import Path

from experiment import run, stage, digest
from queue_sqlite import Queue

with tempfile.TemporaryDirectory() as tmp:
 root = Path(tmp) / "demo"
 proof = run(root)
 assert proof["statuses"] == {"propose":"verified", "implement":"verified", "verify":"verified"}
 assert proof["attempts"] == {"propose":1, "implement":1, "verify":1}
 assert proof["paid_provider_calls"] == proof["spent_usd"] == proof["production_mutations"] == 0
 assert (root / "proof.json").exists()
 assert json.loads((root / "verification.json").read_text())["passed"] is True
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

print({"status":"PASS", "mode":"mock", "paid_provider_calls":0, "production_mutations":0})

