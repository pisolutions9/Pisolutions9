"""PI L2 structured handoff envelopes. Standard library only; no network, model, or shell execution.

Each stage writes one canonical JSON envelope. Its sha256 is recorded in the queue as the task's
evidence_ref, so the next stage loads the upstream artifact by the hash the queue holds, not by
trusting whatever file is on disk. Envelopes are content-addressed and carry no timestamps, so the
same inputs reproduce the same hashes. Labels such as producer are not authenticated identities.
"""
import hashlib
import json
import re
from pathlib import Path

SCHEMA = "pi.level2.handoff.v1"
MAX_BYTES = 16384
HEX = re.compile(r"^[0-9a-f]{64}$")
TASK_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
LABEL = re.compile(r"^[a-z0-9_-]{1,64}$")
FILE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$")
REF = re.compile(r"^handoff/(proposal|implementation|verification)\.json#sha256=([0-9a-f]{64})$")
ENVELOPE_KEYS = {"schema", "kind", "task_id", "producer_role", "producer", "mode", "paid_calls", "upstream_sha256", "payload"}

# kind -> (producer role, upstream kind, payload field validators)
KINDS = {
 "proposal": ("claude", None, {
  "file": ("file",), "before_sha256": ("hex",), "acceptance": ("text", 200), "change": ("text", 500)}),
 "implementation": ("codex", "proposal", {
  "file": ("file",), "before_sha256": ("hex",), "after_sha256": ("hex",)}),
 "verification": ("verifier", "implementation", {
  "passed": ("bool",), "source_sha256": ("hex_or_none",), "acceptance": ("text", 200), "reason": ("text", 64)}),
}


class HandoffError(ValueError):
 """Raised with a short machine-readable code when an envelope must be rejected."""


def canonical(envelope):
 return json.dumps(envelope, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def sha256(data):
 return hashlib.sha256(data).hexdigest()


def _check_field(name, value, rule):
 kind = rule[0]
 if kind == "hex":
  ok = isinstance(value, str) and bool(HEX.match(value))
 elif kind == "hex_or_none":
  ok = value is None or (isinstance(value, str) and bool(HEX.match(value)))
 elif kind == "file":
  ok = isinstance(value, str) and bool(FILE.match(value)) and ".." not in value
 elif kind == "text":
  ok = isinstance(value, str) and 1 <= len(value) <= rule[1]
 elif kind == "bool":
  ok = isinstance(value, bool)
 else:
  ok = False
 if not ok:
  raise HandoffError("bad_field:" + name)


def validate(envelope):
 if not isinstance(envelope, dict) or set(envelope) != ENVELOPE_KEYS:
  raise HandoffError("bad_envelope_keys")
 if envelope["schema"] != SCHEMA:
  raise HandoffError("bad_schema")
 kind = envelope["kind"]
 if kind not in KINDS:
  raise HandoffError("bad_kind")
 role, upstream_kind, fields = KINDS[kind]
 if envelope["producer_role"] != role:
  raise HandoffError("bad_producer_role")
 if not isinstance(envelope["task_id"], str) or not TASK_ID.match(envelope["task_id"]):
  raise HandoffError("bad_task_id")
 if not isinstance(envelope["producer"], str) or not LABEL.match(envelope["producer"]):
  raise HandoffError("bad_producer")
 if envelope["mode"] != "mock":
  raise HandoffError("bad_mode")
 paid = envelope["paid_calls"]
 if type(paid) is not int or paid != 0:
  raise HandoffError("paid_calls_forbidden")
 upstream = envelope["upstream_sha256"]
 if upstream_kind is None:
  if upstream is not None:
   raise HandoffError("unexpected_upstream")
 elif not isinstance(upstream, str) or not HEX.match(upstream):
  raise HandoffError("missing_upstream")
 payload = envelope["payload"]
 if not isinstance(payload, dict) or set(payload) != set(fields):
  raise HandoffError("bad_payload_keys")
 for name, rule in fields.items():
  _check_field(name, payload[name], rule)
 if len(canonical(envelope)) > MAX_BYTES:
  raise HandoffError("oversize")
 return envelope


def build(kind, task_id, producer, upstream_sha256, payload):
 if kind not in KINDS:
  raise HandoffError("bad_kind")
 return validate({"schema": SCHEMA, "kind": kind, "task_id": task_id, "producer_role": KINDS[kind][0],
  "producer": producer, "mode": "mock", "paid_calls": 0, "upstream_sha256": upstream_sha256,
  "payload": dict(payload)})


def ref_for(kind, digest):
 return "handoff/%s.json#sha256=%s" % (kind, digest)


def parse_ref(ref):
 match = REF.match(ref) if isinstance(ref, str) else None
 if not match:
  raise HandoffError("bad_ref")
 return match.group(1), match.group(2)


def write(root, envelope):
 """Write the canonical envelope under root/handoff and return the queue evidence_ref."""
 validate(envelope)
 data = canonical(envelope)
 folder = Path(root) / "handoff"
 folder.mkdir(exist_ok=True)
 (folder / (envelope["kind"] + ".json")).write_bytes(data)
 return ref_for(envelope["kind"], sha256(data))


def read(root, ref, expected_kind):
 """Load the envelope named by a queue evidence_ref; reject any byte that differs from the recorded hash."""
 kind, digest = parse_ref(ref)
 if kind != expected_kind:
  raise HandoffError("wrong_kind")
 path = Path(root) / "handoff" / (kind + ".json")
 try:
  data = path.read_bytes()
 except FileNotFoundError:
  raise HandoffError("missing_artifact") from None
 if len(data) > MAX_BYTES:
  raise HandoffError("oversize")
 if sha256(data) != digest:
  raise HandoffError("hash_mismatch")
 try:
  envelope = json.loads(data.decode("ascii"))
 except (UnicodeDecodeError, json.JSONDecodeError):
  raise HandoffError("not_json") from None
 validate(envelope)
 if canonical(envelope) != data:
  raise HandoffError("non_canonical")
 if envelope["kind"] != expected_kind:
  raise HandoffError("wrong_kind")
 return envelope
