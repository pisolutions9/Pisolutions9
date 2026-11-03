import os
import sqlite3
import tempfile
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
 now[0]+=6
 check(q.reap_expired()==1)
 check(q2.reap_expired()==0)
 check(next(x for x in q.rows() if x["id"]=="expired")["status"]=="blocked")
 check(q.finish("expired","second","late","evidence:late")=="lease_invalid")
 check(q.claim("claude","third") is None)
 check(q.db.execute("PRAGMA integrity_check").fetchone()[0]=="ok")
 events=list(q.db.execute("SELECT previous_hash,hash FROM events ORDER BY seq"))
 check(all(e["previous_hash"]==(events[i-1]["hash"] if i else None) for i,e in enumerate(events)))
 q2.close();q.close()
print({"status":"PASS","assertions":count,"backend":"sqlite","providers_invoked":0,"cost_usd":0,"production_mutations":0})

