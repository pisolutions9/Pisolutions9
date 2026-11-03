"""PI L2 local transactional queue. Standard-library SQLite; no model or shell execution."""
import hashlib
import json
import sqlite3
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks(
 id TEXT PRIMARY KEY, role TEXT NOT NULL, action TEXT NOT NULL, goal TEXT NOT NULL,
 status TEXT NOT NULL, depth INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 lease_owner TEXT, lease_until INTEGER, evidence_ref TEXT, result TEXT,
 verifier TEXT, review_ref TEXT, parent_id TEXT, completed_by TEXT,
 failure_reason TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events(
 seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
 kind TEXT NOT NULL, payload TEXT NOT NULL, previous_hash TEXT, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS budget(
 id INTEGER PRIMARY KEY CHECK(id=1), spent_cents INTEGER NOT NULL DEFAULT 0,
 model_calls INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO budget(id, spent_cents, model_calls) VALUES (1,0,0);
"""
ACTIONS = {"research", "plan", "write_patch", "test", "review"}
ROLES = {"claude", "codex", "verifier"}
MAX_TASKS, MAX_ATTEMPTS, MAX_DEPTH = 12, 2, 2

class Queue:
 def __init__(self, path, now=None):
  self.db=sqlite3.connect(path, timeout=5, isolation_level=None)
  self.db.row_factory=sqlite3.Row
  self.db.execute("PRAGMA busy_timeout=5000")
  self.db.execute("PRAGMA journal_mode=WAL")
  self.db.executescript(SCHEMA)
  if "completed_by" not in {row[1] for row in self.db.execute("PRAGMA table_info(tasks)")}:
   self.db.execute("ALTER TABLE tasks ADD COLUMN completed_by TEXT")
  if "failure_reason" not in {row[1] for row in self.db.execute("PRAGMA table_info(tasks)")}:
   self.db.execute("ALTER TABLE tasks ADD COLUMN failure_reason TEXT")
  self.now=now or (lambda: int(time.time()))

 def close(self): self.db.close()

 def _event(self, tid, kind, payload):
  last=self.db.execute("SELECT hash FROM events ORDER BY seq DESC LIMIT 1").fetchone()
  prev=last["hash"] if last else None
  content=json.dumps([tid,kind,payload,prev], sort_keys=True, separators=(",",":"))
  digest=hashlib.sha256(content.encode()).hexdigest()
  self.db.execute("INSERT INTO events(task_id,kind,payload,previous_hash,hash) VALUES (?,?,?,?,?)",
                  (tid,kind,json.dumps(payload,sort_keys=True),prev,digest))

 def submit(self, task):
  if not isinstance(task,dict): return "invalid"
  tid=task.get("id")
  if not isinstance(tid,str) or not tid or len(tid)>64 or not all(c.isalnum() or c in "_-" for c in tid): return "bad_id"
  if task.get("role") not in ROLES or task.get("action") not in ACTIONS: return "bad_capability"
  if not isinstance(task.get("goal"),str) or not 4<=len(task["goal"])<=500: return "bad_goal"
  if not isinstance(task.get("depth"),int) or not 0<=task["depth"]<=MAX_DEPTH: return "depth"
  acceptance=task.get("acceptance")
  if not isinstance(acceptance,list) or not acceptance or any(not isinstance(x,str) or len(x)>200 for x in acceptance): return "acceptance"
  # This broker holds research metadata only. No arbitrary commands, credentials or paths.
  if set(task)-{"id","role","action","goal","depth","acceptance","parent_id"}: return "unexpected_fields"
  import re
  if re.search(r"deploy|production|billing|stripe|cloudflare|secret|credential|shell|gpio|relay|main branch",task["goal"],re.I): return "restricted"
  with self.db:
   self.db.execute("BEGIN IMMEDIATE")
   if self.db.execute("SELECT 1 FROM tasks WHERE id=?",(tid,)).fetchone(): return "duplicate"
   if self.db.execute("SELECT COUNT(*) AS n FROM tasks").fetchone()["n"]>=MAX_TASKS:return "task_limit"
   parent_id=task.get("parent_id")
   if parent_id:
    parent=self.db.execute("SELECT depth,status FROM tasks WHERE id=?",(parent_id,)).fetchone()
    if not parent:return "unknown_parent"
    if task["depth"]!=parent["depth"]+1:return "invalid_parent_depth"
    if parent["status"]!="verified" and not (task["role"]=="verifier" and parent["status"]=="awaiting_review"):
     return "parent_not_ready"
   elif task["depth"]!=0:return "root_depth"
   self.db.execute("INSERT INTO tasks(id,role,action,goal,status,depth,created_at,parent_id) VALUES (?,?,?,?,?,?,?,?)",
     (tid,task["role"],task["action"],task["goal"],"queued",task["depth"],self.now(),task.get("parent_id")))
   self._event(tid,"submitted",{"role":task["role"]})
  return "accepted"

 def claim(self,role,worker,lease_seconds=30):
  if role not in ROLES or not worker or not isinstance(lease_seconds,int) or not 1<=lease_seconds<=300:raise ValueError("invalid_claim")
  with self.db:
   self.db.execute("BEGIN IMMEDIATE")
   self._reap_expired_locked()
   task=self.db.execute("""SELECT * FROM tasks WHERE role=? AND
     (status='queued' OR (status='running' AND lease_until<=?))
     AND attempts<? ORDER BY created_at,id LIMIT 1""",(role,self.now(),MAX_ATTEMPTS)).fetchone()
   if task is None:return None
   self.db.execute("UPDATE tasks SET status='running',attempts=attempts+1,lease_owner=?,lease_until=? WHERE id=?",
                   (worker,self.now()+lease_seconds,task["id"]))
   self._event(task["id"],"claimed",{"worker":worker,"attempt":task["attempts"]+1})
   return {"id":task["id"],"goal":task["goal"],"role":role,"attempt":task["attempts"]+1}

 def _reap_expired_locked(self):
  expired=self.db.execute("""SELECT id,attempts FROM tasks WHERE status='running'
    AND lease_until<=? AND attempts>=? ORDER BY created_at,id""",
    (self.now(),MAX_ATTEMPTS)).fetchall()
  changed=0
  for task in expired:
   cursor=self.db.execute("""UPDATE tasks SET status='blocked',failure_reason='lease_expired_max_attempts',
     lease_owner=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_until<=? AND attempts>=?""",
     (task["id"],self.now(),MAX_ATTEMPTS))
   if cursor.rowcount:
    self._event(task["id"],"lease_attempts_exhausted",{"attempts":task["attempts"]})
    changed+=1
  return changed

 def reap_expired(self):
  """Block exhausted expired leases even when no worker is claiming that role."""
  with self.db:
   self.db.execute("BEGIN IMMEDIATE")
   return self._reap_expired_locked()

 def finish(self,tid,worker,result,evidence_ref):
  if not isinstance(result,str) or not result or len(result)>4096 or not evidence_ref or len(evidence_ref)>300:raise ValueError("bad_output")
  with self.db:
   self.db.execute("BEGIN IMMEDIATE")
   t=self.db.execute("SELECT * FROM tasks WHERE id=?",(tid,)).fetchone()
   if not t or t["status"]!="running" or t["lease_owner"]!=worker or t["lease_until"]<=self.now():return "lease_invalid"
   self.db.execute("UPDATE tasks SET status='awaiting_review',result=?,evidence_ref=?,completed_by=?,lease_owner=NULL,lease_until=NULL WHERE id=?",
                   (result,evidence_ref,worker,tid))
   self._event(tid,"submitted_for_review",{"ref":evidence_ref})
   return "awaiting_review"

 def review(self,tid,verifier,passed,review_ref):
  if not isinstance(verifier,str) or not verifier.startswith("reviewer:") or not review_ref or not isinstance(passed,bool):raise ValueError("bad_review")
  with self.db:
   self.db.execute("BEGIN IMMEDIATE")
   t=self.db.execute("SELECT * FROM tasks WHERE id=?",(tid,)).fetchone()
   if not t or t["status"]!="awaiting_review":return "not_ready"
   if verifier.removeprefix("reviewer:")==t["completed_by"]:return "same_identity"
   # These are process labels, not authenticated identities.
   status="verified" if passed else ("blocked" if t["attempts"]>=MAX_ATTEMPTS else "queued")
   self.db.execute("UPDATE tasks SET status=?,verifier=?,review_ref=? WHERE id=?",(status,verifier,review_ref,tid))
   self._event(tid,"review",{"verifier":verifier,"passed":passed,"ref":review_ref})
   return status

 def reserve_paid_call(self,estimated_cents):
  # Explicitly deny model calls in zero-paid-call candidate, even nominally free calls.
  raise PermissionError("model_calls_disabled")

 def rows(self):
  return [dict(x) for x in self.db.execute("SELECT * FROM tasks ORDER BY created_at,id")]

