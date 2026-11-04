"""One-shot subscription CLI proof. Opt in only; never uses API keys or paid credits."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from queue_sqlite import Queue

FIXTURE = "def add(a, b):\n    return a - b\n"
FIXED = "def add(a, b):\n    return a + b\n"
ACCEPTANCE = "add(2, 3) == 5 and add(-2, 1) == -1"
CLAUDE_FLAGS = ["-p", "--restricted", "--tools", "", "--disallowedTools", "mcp__*", "--max-turns", "1", "--output-format", "json", "--no-session-persistence", "--no-chrome", "--model", "haiku"]


def sha(text):
 return hashlib.sha256(text.encode("utf-8")).hexdigest()


def write(path, data):
 path.write_text(json.dumps(data, sort_keys=True, indent=2), encoding="utf-8")


def call(args, *, cwd, timeout, input_text=None):
 allowed = ("PATH", "SYSTEMROOT", "WINDIR", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "XDG_CONFIG_HOME", "XDG_DATA_HOME")
 env = {key: os.environ[key] for key in allowed if key in os.environ}
 return subprocess.run(args, cwd=cwd, input=input_text, text=True, capture_output=True, timeout=timeout, check=True, env=env)


def proof_date():
 import datetime
 return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def preflight(claude, codex, root):
 if any(os.environ.get(name) for name in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY")):
  raise PermissionError("api_or_third_party_credentials_present")
 auth = json.loads(call([claude, "auth", "status"], cwd=root, timeout=15).stdout)
 if auth.get("loggedIn") is not True or auth.get("authMethod") != "claude.ai" or auth.get("apiProvider") != "firstParty":
  raise PermissionError("claude_subscription_auth_required")
 status = call([codex, "login", "status"], cwd=root, timeout=15)
 login = status.stdout + status.stderr
 if "Logged in using ChatGPT" not in login:
  raise PermissionError("codex_chatgpt_auth_required")
 return {"claude":"claude.ai subscription", "codex":"ChatGPT subscription"}


def verify(root):
 """Separate process: exact source and behavior oracle; no generated code outside this fixed fixture."""
 p = json.loads((root / "proposal.json").read_text(encoding="utf-8"))
 source = (root / "candidate.py").read_text(encoding="utf-8")
 passed = (set(p) == {"file", "before_sha256", "acceptance", "change"} and p["file"] == "candidate.py"
  and p["before_sha256"] == sha(FIXTURE) and p["acceptance"] == ACCEPTANCE
  and isinstance(p["change"], str) and "addition" in p["change"].lower() and len(p["change"]) <= 200 and source == FIXED)
 if passed:
  namespace = {}
  exec(compile(source, "candidate.py", "exec"), {"__builtins__": {}}, namespace)
  passed = namespace["add"](2,3) == 5 and namespace["add"](-2,1) == -1
 write(root / "verification.json", {"verifier":"independent-python-process", "passed":passed, "source_sha256":sha(source)})
 return passed


def run(root, claude, codex):
 root = Path(root).resolve()
 allowed_root = Path(__file__).resolve().parents[3] / "level2-runs"
 if root.parent != allowed_root.resolve(): raise PermissionError("workspace_outside_disposable_root")
 if root.exists() and any(root.iterdir()): raise ValueError("workspace_must_be_empty")
 root.mkdir(parents=True, exist_ok=True)
 auth = preflight(claude, codex, root)
 (root / "candidate.py").write_bytes(FIXTURE.encode("utf-8"))
 write(root / "manifest.json", {"schema":"pi.level2.subscription-proof.v1", "paid_call_cap":0, "max_attempts":2, "max_depth":2, "production_mutations":0})
 q = Queue(str(root / "queue.db"))
 try:
  assert q.submit({"id":"propose", "role":"claude", "action":"plan", "goal":"Propose one arithmetic fixture correction", "depth":0, "acceptance":[ACCEPTANCE]}) == "accepted"
  assert q.claim("claude", "claude-cli", lease_seconds=300)
  prompt = ("Return only one JSON object with exactly file, before_sha256, acceptance, change. "
   "Task: fix candidate.py in a disposable arithmetic fixture. Current source is " + repr(FIXTURE) + ". "
   "Use file=candidate.py, before_sha256=" + sha(FIXTURE) + ", acceptance=" + ACCEPTANCE + ", "
   "change=Replace subtraction with addition in add. No commands, paths, or other tasks.")
  result = json.loads(call([claude, *CLAUDE_FLAGS, prompt], cwd=root, timeout=120).stdout)
  if result.get("is_error") or result.get("subtype") != "success" or result.get("num_turns") != 1:
   raise ValueError("claude_call_failed")
  proposal = json.loads(result["result"])
  # Provider-reported metadata: what distinguishes a real CLI call from a mock in the exported bundle.
  write(root / "claude-call.json", {"proposal":proposal, "turns":result["num_turns"],
   "session_id":str(result.get("session_id", "not_reported")),
   "model":",".join(sorted((result.get("modelUsage") or {}).keys())) or "not_reported",
   "reported_cost_usd":result.get("total_cost_usd", "not_reported")})
  if (set(proposal) != {"file", "before_sha256", "acceptance", "change"}
   or proposal["file"] != "candidate.py" or proposal["before_sha256"] != sha(FIXTURE)
   or proposal["acceptance"] != ACCEPTANCE or not isinstance(proposal["change"], str)
   or "addition" not in proposal["change"].lower() or len(proposal["change"]) > 200):
   raise ValueError("proposal_out_of_scope")
  write(root / "proposal.json", proposal)
  assert q.finish("propose", "claude-cli", "bounded proposal", "proposal.json") == "awaiting_review"
  assert q.review("propose", "reviewer:broker", True, "proposal.json") == "verified"
  assert q.submit({"id":"implement", "role":"codex", "action":"write_patch", "goal":"Correct the disposable arithmetic fixture", "depth":1, "parent_id":"propose", "acceptance":[ACCEPTANCE]}) == "accepted"
  assert q.claim("codex", "codex-cli", lease_seconds=300)
  codex_prompt = ("Respond with only the complete replacement Python source for candidate.py, no markdown or prose. "
   "Do not call tools. Current source is " + repr(FIXTURE) + ". The approved proposal is: " + json.dumps(proposal, sort_keys=True) + ". "
   "Change only the operator in add from subtraction to addition. Do not access files, network, credentials, or other paths.")
  codex_result = call([codex, "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-C", str(root), codex_prompt], cwd=root, timeout=120)
  generated = codex_result.stdout.strip() + "\n"
  codex_version = call([codex, "--version"], cwd=root, timeout=15).stdout.strip()[:64]
  if generated != FIXED: raise ValueError("codex_output_out_of_scope")
  (root / "candidate.py").write_bytes(generated.encode("utf-8"))
  source = (root / "candidate.py").read_text(encoding="utf-8")
  write(root / "implementation.json", {"provider":"codex-cli", "before_sha256":sha(FIXTURE), "after_sha256":sha(source), "file":"candidate.py",
   "stdout_sha256":sha(codex_result.stdout), "cli_version":codex_version})
  assert q.finish("implement", "codex-cli", "disposable implementation", "implementation.json") == "awaiting_review"
  assert q.submit({"id":"verify", "role":"verifier", "action":"review", "goal":"Check disposable arithmetic fixture independently", "depth":2, "parent_id":"implement", "acceptance":[ACCEPTANCE]}) == "accepted"
  assert q.claim("verifier", "python-verifier", lease_seconds=300)
  verdict = call([sys.executable, str(Path(__file__).resolve()), "verify", str(root)], cwd=root, timeout=20)
  passed = verdict.stdout.strip() == "PASS"
  assert q.finish("verify", "python-verifier", "oracle check", "verification.json") == "awaiting_review"
  assert q.review("verify", "reviewer:broker", passed, "verification.json") in ("verified", "queued")
  assert q.review("implement", "reviewer:python-verifier", passed, "verification.json") in ("verified", "queued")
  rows = q.rows()
  proof = {"schema":"pi.level2.subscription-proof.v1", "mode":"real-subscription-clis", "auth":auth,
   "stages":["real-claude-cli", "real-codex-cli", "independent-python-process"],
   "statuses":{r["id"]:r["status"] for r in rows}, "attempts":{r["id"]:r["attempts"] for r in rows},
   "paid_api_calls":0, "production_mutations":0, "candidate_sha256":sha(source),
   "verifier_identity":"same-OS-account-process-label", "codex_application":"broker_applied_exact_model_output",
   "extra_usage_credits":"must_be_off_in_account_settings"}
  write(root / "proof.json", proof)
  if not passed or set(proof["statuses"].values()) != {"verified"}: raise AssertionError("experiment_failed")
  # Hand the real outputs to the separate-identity verifier lane (verified in CI by `pi-verifier`, pinned code).
  import subscription_bridge
  bundle = subscription_bridge.export(root, root.name, proof_date())
  (root / "bundle.json").write_text(json.dumps(bundle, sort_keys=True, indent=1) + "\n", encoding="utf-8")
  return proof
 finally: q.close()


if __name__ == "__main__":
 parser = argparse.ArgumentParser()
 parser.add_argument("command", choices=["run", "verify"])
 parser.add_argument("workspace")
 parser.add_argument("--claude", default=shutil.which("claude"))
 parser.add_argument("--codex", default=shutil.which("codex"))
 parser.add_argument("--subscription-credit-off-confirmed", action="store_true")
 args = parser.parse_args()
 if args.command == "verify": print("PASS" if verify(Path(args.workspace).resolve()) else "FAIL")
 else:
  if not args.subscription_credit_off_confirmed: raise PermissionError("extra_usage_credits_must_be_confirmed_off")
  if not args.claude or not args.codex: raise ValueError("connected_clis_required")
  print(json.dumps(run(args.workspace, args.claude, args.codex), sort_keys=True))

