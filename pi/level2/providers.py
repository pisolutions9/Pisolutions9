"""PI L2 provider adapter boundary for Claude (proposal) and Codex (implementation). DISABLED BY DEFAULT.

Nothing here can reach a provider in this candidate: every invocation must pass, in order, a bounded
contract check, a deterministic scope check, a broker-side command configuration (never read from the
repository), and Queue.reserve_paid_call, which currently denies every call. Provider output is parsed
only as a pi.level2.handoff.v1 envelope; anything else is rejected and never interpreted as instructions.
Command lines for real CLIs are intentionally not hard-coded: they must be verified against the providers'
documentation and supplied by the owner's runner configuration. Credentials come from the provider's own
login on that runner and are never passed through, stored in, or read from this repository.
"""
import json
import re
import subprocess
import threading

import handoff

KINDS = {"claude": ("plan", "proposal"), "codex": ("write_patch", "implementation")}
MAX_TIMEOUT, MAX_OUTPUT = 300, 16384
RESTRICTED = re.compile(r"deploy|production|billing|stripe|cloudflare|secret|credential|shell|gpio|relay|main branch|merge", re.I)
_SLOTS = {name: threading.BoundedSemaphore(1) for name in KINDS}


class ProviderDisabled(PermissionError):
 pass


def contract(provider, task, timeout_seconds):
 if provider not in KINDS:
  raise ValueError("unknown_provider")
 if not isinstance(task, dict) or task.get("role") != provider or task.get("action") != KINDS[provider][0]:
  raise ValueError("task_provider_mismatch")
 if type(timeout_seconds) is not int or not 1 <= timeout_seconds <= MAX_TIMEOUT:
  raise ValueError("bad_timeout")
 if type(task.get("depth")) is not int or not 0 <= task["depth"] <= 2:
  raise ValueError("depth")
 if RESTRICTED.search(json.dumps(task)):
  raise PermissionError("restricted_scope")
 return {"provider": provider, "task_id": task["id"], "expects": KINDS[provider][1], "timeout": timeout_seconds}


def parse_output(provider, text, task_id):
 """Accept exactly one bounded handoff envelope of the expected kind for this task; reject everything else."""
 if not isinstance(text, str) or not text or len(text.encode()) > MAX_OUTPUT:
  raise handoff.HandoffError("output_size")
 try:
  env = json.loads(text)
 except json.JSONDecodeError:
  raise handoff.HandoffError("output_not_json") from None
 handoff.validate(env)
 if env["kind"] != KINDS[provider][1] or env["task_id"] != task_id:
  raise handoff.HandoffError("output_wrong_task_or_kind")
 return env


def invoke(queue, provider, task, timeout_seconds, runner_config=None, estimated_cents=1):
 """Gate order is deterministic; model output can never relax it."""
 c = contract(provider, task, timeout_seconds)
 command = (runner_config or {}).get(provider)
 if not command:
  raise ProviderDisabled("provider_not_configured")
 queue.reserve_paid_call(estimated_cents)  # raises PermissionError("model_calls_disabled") in this candidate
 slot = _SLOTS[provider]
 if not slot.acquire(blocking=False):
  raise ProviderDisabled("concurrency_limit")
 try:  # pragma: no cover - unreachable while reserve_paid_call denies all calls
  proc = subprocess.run(command, input=json.dumps({"task": task}), capture_output=True, text=True,
   timeout=c["timeout"], env={"PATH": "/usr/bin:/bin"})
  return parse_output(provider, proc.stdout, c["task_id"])
 finally:
  slot.release()

