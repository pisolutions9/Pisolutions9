"""Offline safety checks for the opt-in subscription proof. No provider call."""
import os
from pathlib import Path
import tempfile

import subscription_experiment as se

count = 0


def check(value):
 global count
 assert value
 count += 1


with tempfile.TemporaryDirectory() as tmp:
 root = Path(tmp)
 proposal = {"file":"candidate.py", "before_sha256":se.sha(se.FIXTURE),
  "acceptance":se.ACCEPTANCE, "change":"Replace subtraction with addition in add."}
 se.write(root / "proposal.json", proposal)
 (root / "candidate.py").write_text(se.FIXED, encoding="utf-8")
 check(se.verify(root) is True)
 (root / "candidate.py").write_text(se.FIXTURE, encoding="utf-8")
 check(se.verify(root) is False)
 marker = root / "unexpected"
 (root / "candidate.py").write_text("open(" + repr(str(marker)) + ", 'w').write('bad')\n", encoding="utf-8")
 check(se.verify(root) is False and not marker.exists())
 proposal["file"] = "../outside.py"
 se.write(root / "proposal.json", proposal)
 (root / "candidate.py").write_text(se.FIXED, encoding="utf-8")
 check(se.verify(root) is False)
 try:
  se.run(root / "outside", "claude", "codex")
  check(False)
 except PermissionError as exc:
  check(str(exc) == "workspace_outside_disposable_root")
 previous = os.environ.get("ANTHROPIC_API_KEY")
 os.environ["ANTHROPIC_API_KEY"] = "test-only-placeholder"
 try:
  try:
   se.preflight("claude", "codex", root)
   check(False)
  except PermissionError as exc:
   check(str(exc) == "api_or_third_party_credentials_present")
 finally:
  if previous is None: os.environ.pop("ANTHROPIC_API_KEY")
  else: os.environ["ANTHROPIC_API_KEY"] = previous

print({"status":"PASS", "assertions":count, "provider_calls":0, "paid_api_calls":0})

