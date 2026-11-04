"""Bridge + pin adversarial tests (simulated verifier lane; any OS). ZERO provider calls: the only real provider output
used is the committed bundle from the operator's 2026-11-03 run, replayed byte-for-byte.
The separate-identity (os-user) run of the same bundle is in verifier-identity-test.py (Linux CI)."""
import copy
import json
import tempfile
from pathlib import Path

import handoff
import subscription_bridge as sb
import verifier_boundary as vb
import verifier_pin
import verifier_worker as vw
from experiment import ACCEPTANCE, FIXTURE, FIXED, digest
from level2_fixtures import workspace, rows, run_stage
from queue_sqlite import Queue

BUNDLE = Path(__file__).resolve().parent / "proofs" / "subscription-proof6.bundle.json"
ALLOW = vw.harness_prefix([])[1] != "ns-hidden"  # recorded degraded harness; the os-user lane has none
count = 0


def check(cond, label):
 global count
 assert cond, "failed: " + label
 count += 1


def refused(bundle, code, label):
 try:
  sb.validate(bundle)
 except sb.BridgeError as exc:
  check(str(exc) == code, "%s (got %s)" % (label, exc))
  return
 check(False, label + " accepted")


def rechain(bundle, source=None, proposal_payload=None, mode=sb.REAL):
 """A self-consistent bundle: what a hostile but careful exporter could produce."""
 b = copy.deepcopy(bundle)
 if proposal_payload is not None:
  b["proposal"] = handoff.build("proposal", "propose", "claude-cli", None, proposal_payload, mode=mode)
 if source is not None:
  b["candidate_source"], b["candidate_sha256"] = source, digest(source)
 ip = dict(b["implementation"]["payload"], after_sha256=b["candidate_sha256"])
 b["implementation"] = handoff.build("implementation", "implement", "codex-cli",
  sb.sha(handoff.canonical(b["proposal"])), ip, mode=mode)
 return b


real = sb.load(BUNDLE)
with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
 tmp = Path(tmp)
 broker = tmp / "broker"
 broker.mkdir()
 key, kid, pem = vb.generate_identity(tmp / "keys", "verifier-sim")
 vb.write_registry(broker / "trust.json", [(kid, "verifier", "verifier-sim", pem)])
 reg = vb.load_registry(broker / "trust.json")
 sim = {"key_path": key, "key_id": kid, "allow_unisolated": ALLOW}

 # 1. The committed real bundle: real modes, exact expected fix, bounded calls, zero paid.
 check(real["proposal"]["mode"] == real["implementation"]["mode"] == sb.REAL, "bundle envelopes are real-mode")
 check(real["candidate_source"] == FIXED and real["provider_calls_recorded"] == {"claude-cli": 1, "codex-cli": 1}, "bundle content")
 check(real["provenance"]["claude"]["session_id"] == "not_retained", "proof6 provenance gap is stated, not invented")

 # 2. Verified end to end; the verifier SIGNS that its subject was real CLI output; this run made no provider call.
 proof = sb.verify(real, tmp / "real", broker, reg, **dict(sim))
 check(proof["verifier"]["passed"] and set(proof["statuses"].values()) == {"verified"}, "real bundle verified: %r" % (proof,))
 check(proof["subject_mode_signed"] == sb.REAL and proof["provider_calls_this_run"] == 0, "signed subject mode real; 0 calls now")
 check(proof["depths"] == {"propose": 0, "implement": 1, "verify": 2} and set(proof["attempts"].values()) == {1}, "bounded depth/attempts")
 check(proof["verifier"]["code_sha256"] == vw.code_sha256(Path(vw.__file__).parent), "attestation carries verifier code hash")

 # 3. The same verifier on the MOCK pipeline signs subject_mode "mock": the two are distinguishable in signed evidence.
 ws = workspace(tmp, "mock")
 run_stage(ws, "claude")
 run_stage(ws, "codex")
 q = Queue(str(ws / "queue.db"))
 r = vb.run_verification(q, ws, reg, broker, key, kid, ACCEPTANCE, allow_unisolated=ALLOW)
 att = json.loads(q.db.execute("SELECT attestation FROM verifier_challenges WHERE nonce=?", (r["challenge"]["nonce"],)).fetchone()[0])
 check(r["passed"] and att["subject_mode"] == "mock", "mock pipeline signed as mock")
 q.close()

 # 4. Malformed or out-of-bounds bundles are refused before any queue or verifier runs.
 b = copy.deepcopy(real); b["candidate_source"] = FIXTURE
 refused(b, "candidate_hash_mismatch", "candidate swapped after export")
 b = copy.deepcopy(real); b["note"] = "x"
 refused(b, "bad_bundle_keys", "injected field")
 b = copy.deepcopy(real); b["paid_api_calls"] = 1
 refused(b, "paid_or_production_forbidden", "paid call claimed")
 b = copy.deepcopy(real); b["production_mutations"] = 1
 refused(b, "paid_or_production_forbidden", "production mutation claimed")
 b = copy.deepcopy(real); b["provider_calls_recorded"]["codex-cli"] = 2
 refused(b, "call_count_out_of_bounds", "extra provider call")
 b = copy.deepcopy(real); b["limits"]["max_attempts"] = 5
 refused(b, "limits_changed", "attempt limit raised")
 b = copy.deepcopy(real); b["provenance"]["claude"]["auth"] = "api-key"
 refused(b, "not_subscription_auth", "API-key provenance")
 refused(rechain(real, mode="mock"), "mode_not_real", "mock output relabelled as a real bundle")
 b = copy.deepcopy(real); b["implementation"]["paid_calls"] = 1
 refused(b, "handoff_paid_calls_forbidden", "envelope paid call")
 b = copy.deepcopy(real); b["proposal"]["payload"]["file"] = "../worker/src/index.mjs"
 refused(b, "handoff_bad_field:file", "path outside the fixture")
 refused(rechain(real, proposal_payload=dict(real["proposal"]["payload"], file="wrangler.toml")), "file_out_of_scope",
  "production-looking file, consistently chained")
 refused(rechain(real, proposal_payload=dict(real["proposal"]["payload"], acceptance="True")), "acceptance_not_contract",
  "weakened acceptance contract")
 b = copy.deepcopy(real); b["proposal"]["payload"]["change"] = "Also deploy to production."
 refused(b, "upstream_mismatch", "proposal edited after implementation")
 (tmp / "busy").mkdir(); (tmp / "busy" / "x").write_text("x")
 try:
  sb.verify(real, tmp / "busy", broker, reg, **dict(sim))
  check(False, "non-empty workspace")
 except sb.BridgeError as exc:
  check(str(exc) == "workspace_must_be_empty", "non-empty workspace refused")

 # 5. A WRONG implementation labelled real and consistently chained: the verifier judges it, twice at most.
 wrong = rechain(real, source="def add(a, b):\n    return a - b\n")
 sb.validate(wrong)
 proof = sb.verify(wrong, tmp / "wrong", broker, reg, **dict(sim))
 check(proof["verifier"]["accepted"] and not proof["verifier"]["passed"] and proof["verifier"]["reason"] == "acceptance_failed",
  "real-labelled wrong code: signed failure")
 check(proof["statuses"]["implement"] == "queued", "wrong code not verified")
 q = Queue(str(tmp / "wrong" / "queue.db"))
 assert q.claim("codex", "codex-cli")
 q.finish("implement", "codex-cli", "retry", handoff.write(tmp / "wrong", wrong["implementation"]))
 r = vb.run_verification(q, tmp / "wrong", reg, broker, key, kid, ACCEPTANCE, allow_unisolated=ALLOW)
 st = {row["id"]: row for row in q.rows()}
 check(not r["passed"] and st["implement"]["status"] == "blocked" and st["implement"]["attempts"] == 2, "second failure blocks: bounded attempts")
 check(q.submit({"id": "deeper", "role": "verifier", "action": "review", "depth": 3, "parent_id": "verify",
  "goal": "x", "acceptance": ["x"]}) != "accepted", "depth 3 refused")
 check(vb.queue_next_task(q, "implement", reg, allow_unisolated=True) == "not_attested", "blocked work unlocks nothing")
 q.close()

 # 6. Pin: content-addressed, consistent, materializable; drift detected; registry binding enforced.
 pin = verifier_pin.load(verifier_pin.PIN)
 out = verifier_pin.materialize(verifier_pin.PIN, tmp / "pinned") and tmp / "pinned"
 check(vw.code_sha256(out) == pin["code_sha256"], "materialized pinned code hashes to the pin")
 check(verifier_pin.current()["code_sha256"] == pin["code_sha256"], "working tree matches the pin (no unreviewed drift)")
 bad = json.loads(verifier_pin.PIN.read_text()); bad["files"]["verifier_worker.py"]["sha256"] = "0" * 64
 (tmp / "bad-pin.json").write_text(json.dumps(bad))
 try:
  verifier_pin.load(tmp / "bad-pin.json")
  check(False, "inconsistent pin")
 except SystemExit:
  check(True, "inconsistent pin refused")
 entry = {"role": "verifier", "identity": {"mode": "os-user", "user": vw.VERIFIER_USER, "code_sha256": pin["code_sha256"]}}
 good_att = {"identity_mode": "os-user", "harness_isolation": "os-user", "verifier_code_sha256": pin["code_sha256"]}
 check(vb.separate_identity(entry, good_att, "os-user"), "pinned code hash accepted")
 check(not vb.separate_identity(entry, dict(good_att, verifier_code_sha256="f" * 64), "os-user"), "replaced verifier code rejected")
 check(not vb.separate_identity({"role": "verifier", "identity": {"mode": "os-user", "user": vw.VERIFIER_USER}}, good_att, "os-user"),
  "registry entry without a pin rejected")

print({"status": "PASS", "assertions": count, "verifier_lane": "simulated (os-user lane: verifier-identity-test.py)",
 "degraded_harness": ALLOW, "provider_calls_this_run": 0, "real_provider_outputs_replayed": 2, "paid_api_calls": 0,
 "production_mutations": 0})
