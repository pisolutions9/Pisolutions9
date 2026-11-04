"""Verifier boundary tests. Local fixture keys (SIMULATED identity), mock providers, zero paid calls."""
import json
import sqlite3
import tempfile
from pathlib import Path

import handoff
import verifier_boundary as vb
from experiment import ACCEPTANCE, FIXTURE, FIXED, digest
from level2_fixtures import workspace, rows, run_stage, rewrite
from queue_sqlite import Queue
from verifier_worker import canonical, sign

import verifier_worker as vw
HARNESS_MODE = vw.harness_prefix([])[1]
import os
# Fail closed by default: without namespace isolation the key-theft regression is not exercised, so the suite FAILS
# unless degraded mode is explicitly requested (PI_ALLOW_UNISOLATED_HARNESS=1, printed in the PASS line).
# The real separate-identity boundary is tested by verifier-identity-test.py, which has no degraded mode.
DEGRADED_OPT_IN = os.environ.get("PI_ALLOW_UNISOLATED_HARNESS") == "1"
if HARNESS_MODE != "ns-hidden" and not DEGRADED_OPT_IN:
 raise SystemExit("FAIL: harness isolation unavailable on this host (mode=%s); set PI_ALLOW_UNISOLATED_HARNESS=1 "
  "only for an explicitly degraded run" % HARNESS_MODE)
ALLOW = HARNESS_MODE != "ns-hidden"
# Exec-escape regressions load the interpreter's builtin OS module: "posix" on Linux/macOS, "nt" on Windows.
OSMOD = "posix" if os.name == "posix" else "nt"


def native(source):
 return source.replace("load_module('posix')", "load_module('%s')" % OSMOD)  # explicit, recorded degraded mode only on hosts without namespaces


class _BoundaryWithHostPolicy:
 """Test shim: pass the explicit degraded-mode flag for this host unless a test sets it itself."""
 def __getattr__(self, name):
  fn = getattr(_vb, name)
  if name in ("run_verification", "queue_next_task", "attested_pass", "accept_attestation"):
   return lambda *a, **k: fn(*a, **{"allow_unisolated": ALLOW, **k})
  return fn


_vb = vb
vb = _BoundaryWithHostPolicy()

count = 0


def check(cond, label):
 global count
 assert cond, "failed: " + label
 count += 1


with tempfile.TemporaryDirectory() as tmp:
 tmp = Path(tmp)
 keys, broker = tmp / "keys", tmp / "broker"
 broker.mkdir()
 v_key, v_id, v_pem = vb.generate_identity(keys, "verifier-a")
 i_key, i_id, i_pem = vb.generate_identity(keys, "implementer-a")
 f_key, f_id, f_pem = vb.generate_identity(keys, "forger")
 vb.write_registry(broker / "trust.json", [(v_id, "verifier", "verifier-a", v_pem), (i_id, "implementer", "implementer-a", i_pem)])
 reg = vb.load_registry(broker / "trust.json")
 check(len({v_id, i_id, f_id}) == 3, "distinct identities")

 def ready(name, now=None):
  """Workspace advanced through mock Claude and Codex, waiting for independent verification."""
  ws = workspace(tmp, name)
  run_stage(ws, "claude")
  run_stage(ws, "codex")
  return ws, Queue(str(ws / "queue.db"), now=now)

 def rogue_ready(name, source):
  """A misbehaving implementer writes `source` with a self-consistent handoff claiming success."""
  source = native(source)
  ws = workspace(tmp, name)
  run_stage(ws, "claude")
  q = Queue(str(ws / "queue.db"))
  claim = q.claim("codex", "rogue-codex")
  (ws / "candidate.py").write_bytes(source.encode("utf-8"))
  p_sha = handoff.parse_ref(rows(ws)["propose"]["evidence_ref"])[1]
  env = handoff.build("implementation", "implement", "rogue-codex", p_sha, {"file": "candidate.py", "before_sha256": digest(FIXTURE), "after_sha256": digest(source)})
  q.finish(claim["id"], "rogue-codex", "all tests pass (claimed)", handoff.write(ws, env))
  q.submit({"id": "verify", "role": "verifier", "action": "review", "goal": "Independently check arithmetic fixture artifact", "depth": 2, "parent_id": "implement", "acceptance": [ACCEPTANCE]})
  return ws, q

 def resign(out, key, change):
  att = json.loads((out / "attestation.json").read_bytes())
  change(att)
  data = canonical(att)
  (out / "attestation.json").write_bytes(data)
  (out / "attestation.sig").write_bytes(sign(key, data))

 # 1. Happy path: Task -> Proposal -> Implementation -> independent verification -> durable result -> next task.
 ws, q = ready("happy")
 before = (ws / "candidate.py").read_bytes()
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)
 st = rows(ws)
 check(r["accepted"] and r["passed"] and r["reason"] == "ok", "attestation accepted")
 check(st["implement"]["status"] == "verified" and st["verify"]["status"] == "verified", "chain verified")
 check(st["implement"]["review_ref"] == "verifier-attestation:" + r["challenge"]["nonce"], "review cites attestation")
 check((ws / "candidate.py").read_bytes() == before, "candidate not modified by verification")
 check(r["worker_exit"] == 0, "worker clean exit")
 rec = q.db.execute("SELECT * FROM verifier_challenges WHERE nonce=?", (r["challenge"]["nonce"],)).fetchone()
 check(rec["used_at"] is not None and rec["key_id"] == v_id, "durable record")
 check(vb.verify_signature(v_pem, rec["attestation"].encode(), bytes.fromhex(rec["signature"])), "record re-verifies from DB alone")
 check(json.loads(rec["attestation"])["exit_code"] == 0, "reproduced exit code recorded")
 check(vb.queue_next_task(q, "implement", reg) == "accepted", "next bounded task queued")
 check(rows(ws)["next-regression"]["depth"] == 0 and rows(ws)["next-regression"]["status"] == "queued", "next task bounded")
 check(vb.queue_next_task(q, "implement", reg) == "duplicate", "next task not duplicated")
 happy_out = broker / ("out-" + r["challenge"]["nonce"])

 # 2. Replay: same signed attestation again, then into another workspace.
 check(vb.accept_attestation(q, ws, reg, happy_out)[1] == "replayed_challenge", "replay rejected")
 q.close()
 ws2, q2 = ready("replay-target")
 check(vb.accept_attestation(q2, ws2, reg, happy_out)[1] == "unknown_challenge", "cross-workspace replay rejected")
 q2.close()

 # 3. Forged identities.
 ws, q = ready("unregistered")
 r = vb.run_verification(q, ws, reg, broker, f_key, f_id, ACCEPTANCE)
 check(r["reason"] == "identity_not_registered_verifier" and not r["passed"], "unregistered key rejected")
 check(rows(ws)["implement"]["status"] == "queued", "forged verification not counted")
 q.close()
 ws, q = ready("implementer-key")
 check(vb.run_verification(q, ws, reg, broker, i_key, i_id, ACCEPTANCE)["reason"] == "identity_not_registered_verifier", "implementer key cannot verify")
 q.close()
 ws, q = ready("claimed-id")
 r = vb.run_verification(q, ws, reg, broker, f_key, v_id, ACCEPTANCE)
 check(r["reason"] == "bad_signature", "forger claiming verifier key id rejected")
 q.close()
 bad_reg = json.loads((broker / "trust.json").read_text())
 bad_reg["keys"][v_id]["public_pem"] = f_pem
 (tmp / "bad-trust.json").write_text(json.dumps(bad_reg))
 try:
  vb.load_registry(tmp / "bad-trust.json")
  check(False, "tampered registry")
 except vb.BoundaryError as exc:
  check(str(exc) == "registry_key_mismatch", "tampered registry rejected")

 # 4. Attestation altered after signing.
 ws, q = ready("altered")
 def flip(ch, out):
  att = json.loads((out / "attestation.json").read_bytes())
  att["exit_code"] = 0
  (out / "attestation.json").write_bytes(canonical(att))
  (out / "attestation.sig").write_bytes(b"\x00" * 64)
 check(vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE, mutate=flip)["reason"] == "bad_signature", "altered attestation rejected")
 q.close()
 ws, q = ready("malformed")
 check(vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE, mutate=lambda ch, out: (out / "attestation.json").write_bytes(b"{not json"))["reason"] == "attestation_unreadable", "malformed output rejected")
 q.close()
 ws, q = ready("extra-field")
 check(vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE, mutate=lambda ch, out: resign(out, v_key, lambda a: a.update(admin=True)))["reason"] == "attestation_malformed", "extra field rejected")
 q.close()

 ws, q = ready("duplicate-key")
 def dup(ch, out):
  data = (out / "attestation.json").read_bytes()
  forged = data[:-1] + b',"passed":true}'
  (out / "attestation.json").write_bytes(forged)
  (out / "attestation.sig").write_bytes(sign(v_key, forged))
 check(vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE, mutate=dup)["reason"] == "attestation_malformed", "signed duplicate-key attestation rejected")
 q.close()

 # 5. Compromised verifier key reporting an internally inconsistent pass.
 ws, q = rogue_ready("inconsistent", "def add(a, b):\n    return a * b\n")
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE, mutate=lambda ch, out: resign(out, v_key, lambda a: a.update(passed=True)))
 check(r["reason"] == "inconsistent_result" and rows(ws)["implement"]["status"] == "queued", "inconsistent pass rejected")
 q.close()

 # 6. False positives: the verifier reproduces tests instead of trusting implementer claims.
 ws, q = rogue_ready("wrong-impl", "def add(a, b):\n    return a * b\n")
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)
 check(r["accepted"] and r["reason"] == "acceptance_failed" and not r["passed"], "claimed-pass wrong impl fails")
 check(rows(ws)["implement"]["status"] == "queued", "wrong impl not verified")
 check(vb.queue_next_task(q, "implement", reg) == "not_attested" and "next-regression" not in rows(ws), "no next task without verified result")
 q.close()
 from experiment import run as mock_run
 mock_run(tmp / "unsigned-mock")
 q = Queue(str(tmp / "unsigned-mock" / "queue.db"))
 vb._ensure(q)
 check(vb.queue_next_task(q, "implement", reg) == "not_attested", "unsigned mock verification cannot trigger next task")
 q.close()
 gamed = "def add(a, b):\n    return 5 if (a, b) == (2, 3) else -1\n"
 ws, q = rogue_ready("gamed", gamed)
 check(vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)["reason"] == "acceptance_failed", "acceptance-gaming impl fails held-out cases")
 q.close()
 ws, q = rogue_ready("hang", "def add(a, b):\n    while True:\n        pass\n")
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)
 check(r["reason"] == "acceptance_failed" and not r["passed"], "non-terminating candidate fails within timeout")
 check(json.loads(q.db.execute("SELECT attestation FROM verifier_challenges WHERE used_at IS NOT NULL").fetchone()[0])["exit_code"] == 124, "timeout recorded")
 q.close()
 ws, q = rogue_ready("escape", "def add(a, b):\n    return __import__('os').system('true') or a + b\n")
 check(vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)["reason"] == "acceptance_failed", "candidate without builtins cannot import")
 q.close()

 # 7. Handoff modified after approval, before verification: broker refuses to challenge, attempt fails.
 ws, q = ready("handoff-tamper")
 rewrite(ws, "implementation", lambda e: e["payload"].update(after_sha256="b" * 64))
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)
 check(r["reason"] == "challenge_refused:hash_mismatch", "tampered handoff refused")
 check(rows(ws)["implement"]["status"] == "queued" and rows(ws)["verify"]["status"] == "queued", "refusal fails attempt, not stuck running")
 q.close()

 # 8. Queue record modified after challenge.
 ws, q = ready("queue-tamper")
 def repoint(ch, out):
  db = sqlite3.connect(str(ws / "queue.db"))
  db.execute("UPDATE tasks SET evidence_ref=? WHERE id='implement'", (handoff.ref_for("implementation", "f" * 64),))
  db.commit()
  db.close()
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE, mutate=repoint)
 check(r["reason"] == "queue_record_changed" and not r["passed"], "queue record change rejected")
 q.close()

 # 9. Candidate modified after challenge (implementer or a same-account verifier writing the workspace).
 ws, q = ready("candidate-swap")
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE, mutate=lambda ch, out: (ws / "candidate.py").write_text("def add(a, b):\n    return 0\n", encoding="utf-8"))
 check(r["reason"] == "candidate_changed" and not r["passed"], "post-challenge candidate change rejected")
 q.close()

 # 10. Stale evidence: attestation arrives after the challenge expired.
 now = [5000]
 ws, q = ready("stale", now=lambda: now[0])
 def late(ch, out):
  now[0] += 20
 check(vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE, mutate=late, ttl=10)["reason"] == "stale_challenge", "stale attestation rejected")
 q.close()

 # 11. Interrupted verifier, lease expiry, recovery; the late attestation from attempt 1 is superseded.
 now = [9000]
 ws, q = ready("interrupted", now=lambda: now[0])
 claim = q.claim("verifier", "verifier-crashy", lease_seconds=60)
 ch1, inputs1 = vb.issue_challenge(q, ws, claim["id"], broker, ACCEPTANCE, ttl=600)
 now[0] += 61  # worker never reported; lease lapses
 late_out = broker / "late-attempt-1"
 seen = {}
 def late_arrival(ch, out):
  # Attempt-1 worker reports while attempt 2 is still running.
  vb.launch_verifier(inputs1, v_key, v_id, late_out)
  seen["late"] = vb.accept_attestation(q, ws, reg, late_out)[1]
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE, ttl=600, mutate=late_arrival)
 check(seen["late"] == "superseded_challenge", "late attempt-1 attestation superseded while attempt 2 runs")
 check(r["passed"] and r["challenge"]["attempt"] == 2, "recovered on attempt 2")
 check(vb.accept_attestation(q, ws, reg, late_out)[1] in ("superseded_challenge",), "late attestation still rejected after completion")
 check(rows(ws)["verify"]["attempts"] == 2 and rows(ws)["implement"]["status"] == "verified", "single durable outcome")
 q.close()

 # 12. Worker crash without output.
 ws, q = ready("crash")
 check(vb.run_verification(q, ws, reg, broker, tmp / "missing.key", v_id, ACCEPTANCE)["reason"] == "attestation_unreadable", "crashed worker fails closed")
 q.close()

 # 13. Two-attempt ceiling across re-implementation; no verifier claim while the parent is requeued (regression).
 bad = "def add(a, b):\n    return a * b\n"
 ws, q = rogue_ready("exhaust", bad)
 check(vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)["reason"] == "acceptance_failed", "attempt 1 fails")
 check(rows(ws)["verify"]["status"] == "queued" and rows(ws)["implement"]["status"] == "queued", "both requeued")
 try:
  vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)
  check(False, "early verifier claim")
 except vb.BoundaryError as exc:
  check(str(exc) == "no_verifier_task" and rows(ws)["verify"]["attempts"] == 1, "verifier waits for re-implementation")
 claim = q.claim("codex", "rogue-codex-2")
 check(claim["attempt"] == 2, "re-implementation attempt 2")
 q.finish("implement", "rogue-codex-2", "claimed fixed", rows(ws)["implement"]["evidence_ref"])
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)
 st = rows(ws)
 check(r["reason"] == "acceptance_failed" and r["challenge"]["attempt"] == 2, "attempt 2 reproduced and failed")
 check(st["verify"]["status"] == "blocked" and st["implement"]["status"] == "blocked" and st["implement"]["failure_reason"] == "verifier_child_terminal", "both terminal, nothing stuck")
 try:
  vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)
  check(False, "third attempt")
 except vb.BoundaryError as exc:
  check(str(exc) == "no_verifier_task", "no third attempt")
 q.close()

# 16. Regression: a candidate escaping exec() and exiting 0 must not be signed as a pass (false positive).
 escape = ("def add(a, b):\n    return 0\n"
  "_p = [c for c in ().__class__.__base__.__subclasses__() if c.__name__ == 'BuiltinImporter'][0].load_module('posix')\n"
  "_p._exit(0)\n")
 ws, q = rogue_ready("escape-exit0", escape)
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)
 rec = json.loads(q.db.execute("SELECT attestation FROM verifier_challenges WHERE used_at IS NOT NULL").fetchone()[0])
 check(r["passed"] is False and r["reason"] == "acceptance_failed", "escape + exit 0 is not a pass")
 check(rec["exit_code"] == 0, "escape really exited 0 (oracle, not exit code, rejected it)")
 check(rows(ws)["implement"]["status"] == "queued", "escaping implementation not verified")
 q.close()
 # Forged stdout: escape, print a plausible all-correct transcript for the PUBLIC cases only, exit 0.
 forged = ("def add(a, b):\n    return 0\n"
  "_p = [c for c in ().__class__.__base__.__subclasses__() if c.__name__ == 'BuiltinImporter'][0].load_module('posix')\n"
  "_p.write(1, b'{\"outputs\": [5, -1, 0, 6]}')\n_p._exit(0)\n")
 ws, q = rogue_ready("escape-forged-stdout", forged)
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)
 check(r["passed"] is False, "forged public-case transcript rejected by held-out cases")
 q.close()
 # Held-out cases are nonce-derived: fresh per challenge, reproducible from the stored record.
 import verifier_worker as vw
 suite = vw.SUITES[ACCEPTANCE]
 check(vw.case_inputs(suite, "n1") == vw.case_inputs(suite, "n1") and vw.case_inputs(suite, "n1") != vw.case_inputs(suite, "n2"), "held-out cases deterministic per nonce")
 check(len(vw.case_inputs(suite, "n1")) == len(suite["cases"]) + suite["random_cases"], "held-out case count")

 # 17. Regression: forged durable records must not unlock the next bounded task.
 ws, q = ready("durable-forge")
 vb._ensure(q)
 q.db.execute("""INSERT INTO verifier_challenges(nonce,task_id,attempt,proposal_ref,implementation_ref,candidate_sha256,
  issued_at,expires_at,used_at,key_id,attestation,signature) VALUES ('f00d','verify',1,'x','y','z',0,1,1,'k','{}','00')""")
 q.db.execute("UPDATE tasks SET status='verified', review_ref='verifier-attestation:f00d' WHERE id='implement'")
 check(vb.queue_next_task(q, "implement", reg) == "not_attested", "unsigned forged rows rejected")
 q.close()
 # A genuinely signed FAILED attestation, with queue rows edited to say verified, is still rejected.
 ws, q = rogue_ready("durable-flip", "def add(a, b):\n    return a - b\n")
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)
 check(r["accepted"] and not r["passed"], "real signed failure recorded")
 q.db.execute("UPDATE tasks SET status='verified' WHERE id IN ('implement','verify')")
 q.db.execute("UPDATE tasks SET review_ref='verifier-attestation:' || ? WHERE id='implement'", (r["challenge"]["nonce"],))
 check(vb.queue_next_task(q, "implement", reg) == "not_attested", "flipped status over signed failure rejected")
 q.close()
 # A real pass, but the stored attestation edited (or signed by an implementer key) is rejected.
 ws, q = ready("durable-tamper")
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)
 check(r["passed"] and vb.attested_pass(q, reg, "implement"), "genuine pass re-verifies")
 att_row = q.db.execute("SELECT attestation, nonce FROM verifier_challenges WHERE used_at IS NOT NULL").fetchone()
 edited = json.loads(att_row["attestation"]); edited["candidate_sha256_after"] = edited["candidate_sha256"]; edited["exit_code"] = 0
 edited["reason"] = "ok"; edited["implementation_ref"] = edited["implementation_ref"]
 data = canonical(edited)
 q.db.execute("UPDATE verifier_challenges SET signature=? WHERE nonce=?", (sign(i_key, data).hex(), att_row["nonce"]))
 check(not vb.attested_pass(q, reg, "implement"), "implementer-key signature over stored attestation rejected")
 q.db.execute("UPDATE verifier_challenges SET signature=?, key_id=? WHERE nonce=?", (sign(f_key, data).hex(), f_id, att_row["nonce"]))
 check(not vb.attested_pass(q, reg, "implement"), "unregistered-key signature rejected")
 q.db.execute("UPDATE verifier_challenges SET key_id=?, signature=?, attestation=? WHERE nonce=?", (v_id, sign(v_key, data).hex(), data.decode() + " ", att_row["nonce"]))
 check(not vb.attested_pass(q, reg, "implement"), "non-canonical stored attestation rejected")
 check(vb.queue_next_task(q, "implement", reg) == "not_attested", "tampered durable record blocks next task")
 q.close()
 # Each durable guard isolated: implementer key id signs its own claim; a verifier-signed non-canonical record.
 ws, q = ready("durable-guards")
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)
 nonce = r["challenge"]["nonce"]
 good = q.db.execute("SELECT attestation, signature, key_id FROM verifier_challenges WHERE nonce=?", (nonce,)).fetchone()
 own = json.loads(good["attestation"]); own["key_id"] = i_id; own_data = canonical(own)
 q.db.execute("UPDATE verifier_challenges SET attestation=?, signature=?, key_id=? WHERE nonce=?", (own_data.decode(), sign(i_key, own_data).hex(), i_id, nonce))
 check(not vb.attested_pass(q, reg, "implement"), "registered implementer key cannot attest (role check)")
 pretty = json.dumps(json.loads(good["attestation"]), indent=1, sort_keys=True).encode("ascii")
 q.db.execute("UPDATE verifier_challenges SET attestation=?, signature=?, key_id=? WHERE nonce=?", (pretty.decode(), sign(v_key, pretty).hex(), v_id, nonce))
 check(not vb.attested_pass(q, reg, "implement"), "validly signed non-canonical record rejected")
 q.db.execute("UPDATE verifier_challenges SET attestation=?, signature=?, key_id=? WHERE nonce=?", (good["attestation"], good["signature"], good["key_id"], nonce))
 check(vb.attested_pass(q, reg, "implement"), "restored record re-verifies")
 q.db.execute("UPDATE tasks SET status='queued' WHERE id='verify'")
 check(not vb.attested_pass(q, reg, "implement"), "verifier child must itself be verified")
 q.db.execute("UPDATE tasks SET status='verified', parent_id='propose' WHERE id='verify'")
 check(not vb.attested_pass(q, reg, "implement"), "attesting task must be a child of the implementation")
 q.close()
 # Worker judges output type itself: bools forged on stdout are not ints, even where they compare equal.
 boolish = ("def add(a, b):\n    return 0\n"
  "_p = [c for c in ().__class__.__base__.__subclasses__() if c.__name__ == 'BuiltinImporter'][0].load_module('posix')\n"
  "_p.write(1, b'{\"outputs\": [true, false]}')\n_p._exit(0)\n").encode()
 code, _, matched, _mode = vw.reproduce(native(boolish.decode()).encode(), {"function": "add", "oracle": "add", "random_cases": 0, "cases": [[0, 1], [0, 0]]}, "n")
 check(code == 0 and matched is False, "forged bool outputs do not match int oracle")
 code, _, matched, _mode = vw.reproduce(b"def add(a, b):\n    return a + b\n", {"function": "add", "oracle": "add", "random_cases": 0, "cases": [[0, 1], [0, 0]]}, "n")
 check(code == 0 and matched is True, "correct candidate matches on same suite")

 # The verified attestation cannot be reused for a different implementation task.
 ws, q = ready("durable-reuse")
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)
 check(r["passed"], "baseline pass")
 q.db.execute("UPDATE tasks SET evidence_ref='handoff/implementation.json#sha256=' || ? WHERE id='implement'", ("e" * 64,))
 check(vb.queue_next_task(q, "implement", reg) == "not_attested", "attestation bound to the implementation ref")
 q.close()

 # 18. Regression: candidate code must not be able to read the verifier private key.
 canary = tmp / "stolen-key.out"
 theft = ("def add(a, b):\n    return 0\n"
  "_p = [c for c in ().__class__.__base__.__subclasses__() if c.__name__ == 'BuiltinImporter'][0].load_module('posix')\n"
  "_got = b''\n"
  "for _pid in [_p.getppid(), 1]:\n"
  "  try:\n"
  "    _cmd = _p.read(_p.open('/proc/%%d/cmdline' %% _pid, 0), 65536).split(b'\\0')\n"
  "    if b'--key' in _cmd: _got += _p.read(_p.open(_cmd[_cmd.index(b'--key') + 1], 0), 4096)\n"
  "  except: pass\n"
  "for _path in [%r, '/proc/1/root' + %r]:\n"
  "  try: _got += _p.read(_p.open(_path, 0), 4096)\n"
  "  except: pass\n"
  "_d = _p.open(%r, 1 | 64 | 512, 0o600)\n"
  "_p.write(_d, _got or b'NOTHING')\n") % (str(v_key), str(v_key), str(canary))
 ws, q = rogue_ready("key-theft", theft)
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE)
 leaked = canary.read_bytes() if canary.exists() else b"NOT_WRITTEN"
 rec = json.loads(q.db.execute("SELECT attestation FROM verifier_challenges WHERE used_at IS NOT NULL").fetchone()[0])
 check(r["passed"] is False, "theft candidate not verified")
 check(rec["harness_isolation"] == HARNESS_MODE, "harness isolation mode recorded in signed attestation")
 if HARNESS_MODE == "ns-hidden":
  check(b"PRIVATE KEY" not in leaked and leaked == b"NOTHING", "key unreadable from isolated harness: " + leaked[:40].decode("ascii", "replace"))
 else:
  print({"warning": "host lacks user/mount/pid namespaces; key-theft isolation NOT exercised", "leaked": b"PRIVATE KEY" in leaked})
 q.close()
 # Fail closed: a pass from an unisolated harness is rejected unless degraded mode is explicitly allowed.
 def unisolate(ch, out):
  resign(out, v_key, lambda a: a.update(harness_isolation="none"))
 ws, q = ready("unisolated-pass")
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE, mutate=unisolate, allow_unisolated=False)
 check(r["accepted"] is False and r["reason"] == "harness_not_isolated", "unisolated pass rejected by default")
 check(rows(ws)["implement"]["status"] == "queued", "unisolated pass does not verify implementation")
 q.close()
 ws, q = ready("unisolated-allowed")
 r = vb.run_verification(q, ws, reg, broker, v_key, v_id, ACCEPTANCE, mutate=unisolate, allow_unisolated=True)
 check(r["passed"] is True, "explicit degraded mode accepts and records it")
 check(vb.queue_next_task(q, "implement", reg, allow_unisolated=False) == "not_attested", "degraded result cannot unlock next task without the explicit flag")
 check(vb.queue_next_task(q, "implement", reg, allow_unisolated=True) == "accepted", "degraded result unlocks next task only with the explicit flag")
 q.close()

 # 14. Structural boundary: the worker has no queue or database access path.
 src = Path(vb.WORKER).read_text(encoding="utf-8")
 check("queue_sqlite" not in src and "sqlite3" not in src and "queue.db" not in src, "worker has no DB access path")
 check(not any(p.name.endswith(".key") for p in broker.rglob("*")), "broker dir holds no private keys")

 # 15. Integrity of every queue database touched.
 for db in tmp.glob("*/queue.db"):
  q = Queue(str(db))
  check(q.db.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "integrity " + db.parent.name)
  ev = list(q.db.execute("SELECT previous_hash,hash FROM events ORDER BY seq"))
  check(all(e["previous_hash"] == (ev[i - 1]["hash"] if i else None) for i, e in enumerate(ev)), "event chain " + db.parent.name)
  q.close()

print({"status": "PASS", "assertions": count, "identity": "simulated-local-ed25519", "harness_isolation": HARNESS_MODE,
 "key_theft_isolation_exercised": HARNESS_MODE == "ns-hidden", "degraded_opt_in": ALLOW,
 "paid_provider_calls": 0, "production_mutations": 0})

