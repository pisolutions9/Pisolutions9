import os
import sqlite3
import tempfile
import threading
from queue_sqlite import Queue, MAX_ATTEMPTS

def task(i, role="claude"):
 return {"id":i,"role":role,"action":"research","goal":"Compare candidate algorithms","depth":0,"acceptance":["Document hypothesis"]}
count=0
def check(cond):
 global count
 assert cond, f"assertion {count+1} failed"
 count+=1

with tempfile.TemporaryDirectory() as d:
 p=os.path.join(d,"queue.db")
 now=[1000]
 q=Queue(p,now=lambda:now[0])
 check(q.submit(task("a"))=="accepted")
 check(q.submit({**task("premature"),"depth":1,"parent_id":"a"})=="parent_not_ready")
 check(q.submit(task("a"))=="duplicate")
 check(q.submit({**task("bad"),"goal":"deploy production"})=="restricted")
 check(q.submit({**task("bad"),"role":"admin"})=="bad_capability")
 check(q.submit({**task("bad"),"depth":3})=="depth")
 check(q.submit({**task("bad"),"extra":"shell"})=="unexpected_fields")
 check(q.claim("codex","worker-a") is None)
 claim=q.claim("claude","worker-a",lease_seconds=10)
 check(claim["attempt"]==1)
 check(q.finish("a","worker-b","done","evidence:1")=="lease_invalid")
 check(q.finish("a","worker-a","done","evidence:1")=="awaiting_review")
 check(q.review("a","reviewer:independent",True,"review:1")=="verified")
 check(q.claim("claude","worker-c") is None)
 check(q.submit(task("b"))=="accepted")
 check(q.claim("claude","worker-a",lease_seconds=10)["id"]=="b")
 now[0]+=11
 check(q.finish("b","worker-a","stale","evidence:stale")=="lease_invalid")
 check(q.claim("claude","worker-b")["attempt"]==2)
 check(q.finish("b","worker-b","retry","evidence:2")=="awaiting_review")
 check(q.review("b","reviewer:independent",False,"review:failed")=="blocked")
 check(q.claim("claude","worker-c") is None)
 try:q.reserve_paid_call(0);check(False)
 except PermissionError:check(True)
 q2=Queue(p,now=lambda:now[0])
 check(len(q2.rows())==2)
 check(q2.submit(task("a"))=="duplicate")
 check(q2.submit({**task("depth-root"),"depth":1})=="root_depth")
 check(q2.submit({**task("wrong-depth"),"depth":2,"parent_id":"a"})=="invalid_parent_depth")
 check(q2.submit({**task("child"),"depth":1,"parent_id":"a"})=="accepted")
 check(q2.claim("claude","worker-child")["id"]=="child")
 check(q2.finish("child","worker-child","done","evidence:child")=="awaiting_review")
 check(q2.review("child","reviewer:worker-child",True,"review:self")=="same_identity")
 check(q2.review("child","reviewer:independent",True,"review:child")=="verified")
 check(q2.submit(task("c","codex"))=="accepted")
 check(q.claim("codex","worker-z")["id"]=="c")
 check(q2.claim("codex","worker-x") is None)
 # Deliberate stale lease recovery, including only one lease owner.
 now[0]+=31
 check(q2.claim("codex","worker-x")["attempt"]==2)
 check(q.finish("c","worker-z","late","evidence:late")=="lease_invalid")
 check(q2.finish("c","worker-x","done","evidence:done")=="awaiting_review")
 check(q.review("c","reviewer:independent",True,"review:ok")=="verified")
 check(q.submit(task("expired"))=="accepted")
 check(q.claim("claude","first",lease_seconds=5)["id"]=="expired")
 now[0]+=6
 check(q2.claim("claude","second",lease_seconds=5)["attempt"]==2)
 check(q2.reap_expired()==0)
 check(next(x for x in q.rows() if x["id"]=="expired")["status"]=="running")
 now[0]+=6
 check(q.reap_expired()==1)
 check(q2.reap_expired()==0)
 exhausted=next(x for x in q.rows() if x["id"]=="expired")
 check(exhausted["status"]=="blocked" and exhausted["failure_reason"]=="lease_expired_max_attempts")
 check(exhausted["lease_owner"] is None and exhausted["lease_until"] is None and exhausted["attempts"]==2)
 check(q.db.execute("SELECT COUNT(*) FROM tasks WHERE status='running' AND lease_until<=? AND attempts>=?",(now[0],MAX_ATTEMPTS)).fetchone()[0]==0)
 check(q.finish("expired","second","late","evidence:late")=="lease_invalid")
 check(q.claim("claude","third") is None)
 # A depth-two terminal verifier blocks its direct implementation parent.
 implement={**task("implement","codex"),"action":"write_patch","depth":1,"parent_id":"a"}
 check(q.submit(implement)=="accepted")
 check(q.claim("codex","patch-worker")["id"]=="implement")
 check(q.finish("implement","patch-worker","patch","evidence:patch")=="awaiting_review")
 check(q.review("implement","reviewer:independent",True,"review:early")=="verifier_not_verified")
 verifier={**task("verify","verifier"),"action":"review","depth":2,"parent_id":"implement"}
 check(q.submit(verifier)=="accepted")
 check(q.review("implement","reviewer:independent",True,"review:pending")=="verifier_not_verified")
 check(q.claim("verifier","verify-worker",lease_seconds=5)["id"]=="verify")
 check(q.finish("verify","verify-worker","failed check","evidence:verify")=="awaiting_review")
 check(q.review("verify","reviewer:broker",False,"review:fail1")=="queued")
 check(next(x for x in q.rows() if x["id"]=="implement")["status"]=="awaiting_review")
 check(q.claim("verifier","verify-worker-2",lease_seconds=5)["attempt"]==2)
 check(q.finish("verify","verify-worker-2","failed again","evidence:verify2")=="awaiting_review")
 check(q.review("verify","reviewer:broker",False,"review:fail2")=="blocked")
 parent=next(x for x in q.rows() if x["id"]=="implement")
 check(parent["status"]=="blocked" and parent["failure_reason"]=="verifier_child_terminal")
 check(q.review("implement","reviewer:independent",True,"review:late")=="not_ready")
 check(q.reap_expired()==0)
 check(q.db.execute("SELECT COUNT(*) FROM events WHERE task_id='implement' AND kind='verifier_child_terminal'").fetchone()[0]==1)
 check(q.db.execute("""SELECT COUNT(*) FROM tasks p JOIN tasks c ON c.parent_id=p.id
  WHERE p.status='awaiting_review' AND c.role='verifier' AND c.depth=2 AND c.status='blocked'""").fetchone()[0]==0)
 # An expired verifier's final lease takes the same fail-closed parent path.
 lease_parent={**task("lease_parent","codex"),"action":"write_patch","depth":1,"parent_id":"a"}
 check(q.submit(lease_parent)=="accepted")
 check(q.claim("codex","lease-patch")["id"]=="lease_parent")
 check(q.finish("lease_parent","lease-patch","patch","evidence:lease-patch")=="awaiting_review")
 lease_child={**task("lease_verify","verifier"),"action":"review","depth":2,"parent_id":"lease_parent"}
 check(q.submit(lease_child)=="accepted")
 check(q.claim("verifier","lease-v1",lease_seconds=5)["attempt"]==1)
 now[0]+=6
 check(q.claim("verifier","lease-v2",lease_seconds=5)["attempt"]==2)
 now[0]+=6
 check(q.reap_expired()==1)
 rows={x["id"]:x for x in q.rows()}
 check(rows["lease_verify"]["status"]=="blocked" and rows["lease_verify"]["failure_reason"]=="lease_expired_max_attempts")
 check(rows["lease_parent"]["status"]=="blocked" and rows["lease_parent"]["failure_reason"]=="verifier_child_terminal")
 check(q.reap_expired()==0)
 check(q.db.execute("SELECT COUNT(*) FROM events WHERE task_id='lease_parent' AND kind='verifier_child_terminal'").fetchone()[0]==1)
 # Two connections racing for one queued task must produce one lease.
 check(q.submit(task("race"))=="accepted")
 start=threading.Barrier(3)
 results=[]
 def race_claim(worker):
  connection=Queue(p,now=lambda:now[0])
  try:
   start.wait(timeout=5)
   results.append(connection.claim("claude",worker))
  finally:connection.close()
 threads=[threading.Thread(target=race_claim,args=(f"racer-{i}",)) for i in range(2)]
 for thread in threads:thread.start()
 start.wait(timeout=5)
 for thread in threads:thread.join(timeout=5)
 check(all(not thread.is_alive() for thread in threads))
 check(len(results)==2 and sorted(x is None for x in results)==[False,True])
 check(next(x for x in q.rows() if x["id"]=="race")["attempts"]==1)
 check(q.db.execute("PRAGMA integrity_check").fetchone()[0]=="ok")
 events=list(q.db.execute("SELECT previous_hash,hash FROM events ORDER BY seq"))
 check(all(e["previous_hash"]==(events[i-1]["hash"] if i else None) for i,e in enumerate(events)))
 q2.close();q.close()
print({"status":"PASS","assertions":count,"backend":"sqlite","providers_invoked":0,"cost_usd":0,"production_mutations":0})

