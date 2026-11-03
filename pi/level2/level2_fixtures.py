"""Reusable isolated fixtures for PI L2 tests. Each workspace is a fresh temp directory; no network or providers."""
import json
from pathlib import Path

import handoff
from experiment import seed, run_stage
from queue_sqlite import Queue


def workspace(parent, name):
 """Fresh seeded workspace: fixture candidate, manifest, and the root 'propose' task."""
 return seed(Path(parent) / name)


def rows(root):
 q = Queue(str(Path(root) / "queue.db"))
 try:
  return {r["id"]: r for r in q.rows()}
 finally:
  q.close()


def artifact_path(root, kind):
 return Path(root) / "handoff" / (kind + ".json")


def load(root, kind):
 return json.loads(artifact_path(root, kind).read_text(encoding="ascii"))


def rewrite(root, kind, mutate):
 """Simulate on-disk tampering: mutate the envelope and rewrite it canonically (queue record unchanged)."""
 envelope = load(root, kind)
 mutate(envelope)
 artifact_path(root, kind).write_bytes(handoff.canonical(envelope))
 return envelope


__all__ = ["workspace", "rows", "artifact_path", "load", "rewrite", "run_stage"]
