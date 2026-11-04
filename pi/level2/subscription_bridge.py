"""Bridge: real Claude/Codex subscription CLI run -> separate-identity verifier lane.

A real run (subscription_experiment.py, operator machine) leaves a disposable workspace. `export` turns it into one
strict, content-addressed bundle: the real Claude proposal and the real Codex implementation as
pi.level2.handoff.v1 envelopes with mode "real-subscription-cli", the exact candidate bytes, call counts, and the
provenance the CLIs reported. `verify` imports a bundle into a FRESH disposable queue and runs the verifier through
verifier_boundary (in CI: the os-user `pi-verifier` identity with pinned code). It makes ZERO provider calls.

Real vs mock is kept explicit at every layer: the envelopes carry `mode`, the verifier signs `subject_mode` into its
attestation, and the proof separates `provider_calls_recorded` (the operator run) from `provider_calls_this_run` (0).
Provenance is operator-recorded CLI metadata, NOT a provider-signed receipt: CI cannot prove the bytes came from
Anthropic or OpenAI, only that the separate verifier judged exactly these bytes.
"""
import argparse
import hashlib
import json
from pathlib import Path

import handoff
import verifier_boundary as vb
from experiment import ACCEPTANCE, FIXTURE, FIXED
from queue_sqlite import Queue

SCHEMA = "pi.level2.subscription-bundle.v1"
PROOF_SCHEMA = "pi.level2.subscription-verified.v1"
REAL = "real-subscription-cli"
BUNDLE_KEYS = {"schema", "run_label", "recorded_at", "provider_calls_recorded", "paid_api_calls", "production_mutations",
 "limits", "provenance", "proposal", "implementation", "candidate_source", "candidate_sha256"}
LIMITS = {"max_attempts": 2, "max_depth": 2, "paid_call_cap": 0}
PROVENANCE_KEYS = {"claude", "codex", "attestation"}
MAX_BUNDLE = 32768


class BridgeError(ValueError):
 pass


def sha(data):
 return hashlib.sha256(data).hexdigest()


def _text_sha(text):
 return sha(text.encode("utf-8"))


def export(run_dir, run_label, recorded_at):
 """Build a bundle from a finished real-run workspace. Refuses anything that is not a passing, bounded real run."""
 run = Path(run_dir)
 proof = json.loads((run / "proof.json").read_text(encoding="utf-8"))
 if proof.get("mode") != "real-subscription-clis" or proof.get("paid_api_calls") != 0:
  raise BridgeError("not_a_real_zero_paid_run")
 if proof.get("stages", [])[:2] != ["real-claude-cli", "real-codex-cli"]:
  raise BridgeError("not_a_real_zero_paid_run")
 proposal = json.loads((run / "proposal.json").read_text(encoding="utf-8"))
 impl = json.loads((run / "implementation.json").read_text(encoding="utf-8"))
 call = json.loads((run / "claude-call.json").read_text(encoding="utf-8"))
 source = (run / "candidate.py").read_bytes().decode("utf-8")
 p_env = handoff.build("proposal", "propose", "claude-cli", None, proposal, mode=REAL)
 i_env = handoff.build("implementation", "implement", "codex-cli", sha(handoff.canonical(p_env)),
  {"file": impl["file"], "before_sha256": impl["before_sha256"], "after_sha256": impl["after_sha256"]}, mode=REAL)
 claude_meta = {"cli": "claude", "auth": proof["auth"]["claude"], "turns": call.get("turns"),
  "session_id": call.get("session_id", "not_retained"), "model": call.get("model", "not_retained"),
  "reported_cost_usd": call.get("reported_cost_usd", "not_retained")}
 codex_meta = {"cli": "codex", "auth": proof["auth"]["codex"], "sandbox": "read-only",
  "stdout_sha256": impl.get("stdout_sha256", "not_retained"), "version": impl.get("cli_version", "not_retained")}
 bundle = {"schema": SCHEMA, "run_label": run_label, "recorded_at": recorded_at,
  "provider_calls_recorded": {"claude-cli": 1, "codex-cli": 1}, "paid_api_calls": 0, "production_mutations": 0,
  "limits": dict(LIMITS),
  "provenance": {"claude": claude_meta, "codex": codex_meta, "attestation": "operator-recorded-cli-metadata"},
  "proposal": p_env, "implementation": i_env, "candidate_source": source, "candidate_sha256": _text_sha(source)}
 validate(bundle)
 return bundle


def validate(bundle):
 """Strict check of a bundle before any queue or verifier is touched. Returns the bundle."""
 if not isinstance(bundle, dict) or set(bundle) != BUNDLE_KEYS or bundle["schema"] != SCHEMA:
  raise BridgeError("bad_bundle_keys")
 if bundle["paid_api_calls"] != 0 or type(bundle["paid_api_calls"]) is not int or bundle["production_mutations"] != 0:
  raise BridgeError("paid_or_production_forbidden")
 if bundle["limits"] != LIMITS:
  raise BridgeError("limits_changed")
 calls = bundle["provider_calls_recorded"]
 if calls != {"claude-cli": 1, "codex-cli": 1} or any(type(v) is not int for v in calls.values()):
  raise BridgeError("call_count_out_of_bounds")
 prov = bundle["provenance"]
 if not isinstance(prov, dict) or set(prov) != PROVENANCE_KEYS or prov["attestation"] != "operator-recorded-cli-metadata":
  raise BridgeError("bad_provenance")
 if prov["claude"].get("auth") != "claude.ai subscription" or prov["codex"].get("auth") != "ChatGPT subscription":
  raise BridgeError("not_subscription_auth")
 for key in ("run_label", "recorded_at"):
  if not isinstance(bundle[key], str) or not 1 <= len(bundle[key]) <= 64:
   raise BridgeError("bad_" + key)
 try:
  p_env = handoff.validate(bundle["proposal"])
  i_env = handoff.validate(bundle["implementation"])
 except handoff.HandoffError as exc:
  raise BridgeError("handoff_" + str(exc)) from None
 if p_env["kind"] != "proposal" or i_env["kind"] != "implementation":
  raise BridgeError("wrong_kinds")
 if p_env["mode"] != REAL or i_env["mode"] != REAL:
  raise BridgeError("mode_not_real")
 if (p_env["task_id"], i_env["task_id"]) != ("propose", "implement"):
  raise BridgeError("task_ids")
 if i_env["upstream_sha256"] != sha(handoff.canonical(p_env)):
  raise BridgeError("upstream_mismatch")
 pp, ip = p_env["payload"], i_env["payload"]
 # Scope: only the fixed disposable fixture, its exact before-state and the broker-held acceptance contract.
 if pp["file"] != "candidate.py" or ip["file"] != "candidate.py":
  raise BridgeError("file_out_of_scope")
 if pp["before_sha256"] != _text_sha(FIXTURE) or ip["before_sha256"] != pp["before_sha256"]:
  raise BridgeError("before_state_mismatch")
 if pp["acceptance"] != ACCEPTANCE:
  raise BridgeError("acceptance_not_contract")
 src = bundle["candidate_source"]
 if not isinstance(src, str) or len(src) > 4096 or _text_sha(src) != bundle["candidate_sha256"] or ip["after_sha256"] != bundle["candidate_sha256"]:
  raise BridgeError("candidate_hash_mismatch")
 if len(json.dumps(bundle)) > MAX_BUNDLE:
  raise BridgeError("oversize")
 return bundle


def load(path):
 data = Path(path).read_bytes()
 if len(data) > MAX_BUNDLE:
  raise BridgeError("oversize")
 return validate(json.loads(data.decode("utf-8")))


def stage(bundle, workspace):
 """Fresh disposable queue: real proposal -> real implementation -> pending depth-2 verifier task."""
 ws = Path(workspace)
 if ws.exists() and any(ws.iterdir()):
  raise BridgeError("workspace_must_be_empty")
 ws.mkdir(parents=True, exist_ok=True)
 (ws / "candidate.py").write_bytes(bundle["candidate_source"].encode("utf-8"))
 q = Queue(str(ws / "queue.db"))
 assert q.submit({"id": "propose", "role": "claude", "action": "plan", "depth": 0,
  "goal": "Real Claude CLI proposal for the disposable arithmetic fixture", "acceptance": [ACCEPTANCE]}) == "accepted"
 assert q.claim("claude", "claude-cli")
 assert q.finish("propose", "claude-cli", "real proposal (imported)", handoff.write(ws, bundle["proposal"])) == "awaiting_review"
 assert q.review("propose", "reviewer:broker-bundle-scope", True, "bundle-scope-checked") == "verified"
 assert q.submit({"id": "implement", "role": "codex", "action": "write_patch", "depth": 1, "parent_id": "propose",
  "goal": "Real Codex CLI implementation for the disposable arithmetic fixture", "acceptance": [ACCEPTANCE]}) == "accepted"
 assert q.claim("codex", "codex-cli")
 assert q.finish("implement", "codex-cli", "real implementation (imported)", handoff.write(ws, bundle["implementation"])) == "awaiting_review"
 assert q.submit({"id": "verify", "role": "verifier", "action": "review", "depth": 2, "parent_id": "implement",
  "goal": "Independently verify the real implementation", "acceptance": [ACCEPTANCE]}) == "accepted"
 return q


def verify(bundle, workspace, broker_dir, registry, **policy):
 """Import a validated bundle and verify it. policy: boundary/require_identity (CI) or allow_unisolated (dev)."""
 validate(bundle)
 q = stage(bundle, workspace)
 try:
  r = vb.run_verification(q, workspace, registry, broker_dir, policy.pop("key_path", None), policy.pop("key_id", None),
   ACCEPTANCE, **policy)
  rows = {row["id"]: row for row in q.rows()}
  att = None
  if r.get("challenge"):
   rec = q.db.execute("SELECT attestation FROM verifier_challenges WHERE nonce=?", (r["challenge"]["nonce"],)).fetchone()
   att = json.loads(rec[0]) if rec and rec[0] else None
  proof = {"schema": PROOF_SCHEMA, "run_label": bundle["run_label"], "recorded_at": bundle["recorded_at"],
   "provider_calls_recorded": bundle["provider_calls_recorded"], "provider_calls_this_run": 0,
   "provider_provenance": bundle["provenance"]["attestation"],
   "stages": {"propose": "real-claude-cli (imported)", "implement": "real-codex-cli (imported)",
    "verify": (att or {}).get("identity_mode", "none") + "-verifier"},
   "subject_mode_signed": (att or {}).get("subject_mode"),
   "verifier": {"accepted": r["accepted"], "passed": r["passed"], "reason": r["reason"],
    "key_id": (att or {}).get("key_id"), "code_sha256": (att or {}).get("verifier_code_sha256"),
    "harness_isolation": (att or {}).get("harness_isolation"), "nonce": (r.get("challenge") or {}).get("nonce")},
   "statuses": {k: v["status"] for k, v in rows.items()}, "attempts": {k: v["attempts"] for k, v in rows.items()},
   "depths": {k: v["depth"] for k, v in rows.items()},
   "candidate_sha256": bundle["candidate_sha256"], "candidate_is_expected_fix": bundle["candidate_source"] == FIXED,
   "paid_api_calls": 0, "production_mutations": 0}
  return proof
 finally:
  q.close()


def main():
 ap = argparse.ArgumentParser()
 sub = ap.add_subparsers(dest="cmd", required=True)
 e = sub.add_parser("export")
 e.add_argument("run_dir")
 e.add_argument("out")
 e.add_argument("--label", required=True)
 e.add_argument("--recorded-at", required=True)
 a = ap.parse_args()
 bundle = export(a.run_dir, a.label, a.recorded_at)
 Path(a.out).write_text(json.dumps(bundle, sort_keys=True, indent=1) + "\n", encoding="utf-8")
 print(json.dumps({"bundle": a.out, "candidate_sha256": bundle["candidate_sha256"]}))


if __name__ == "__main__":
 main()
