"""Provider-free tests for pi/chat_soak_evidence.py using real curl against local fixture servers."""
import json, os, socket, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import chat_soak_evidence as soak

REQUEST_ID='0b6d6f1e-3c1a-4a55-9a43-6f2f2b7e9c10'
READY={'ok':True,'truth':'model-response','source':'pi-chat-cloudflare-ai:test','answer':'Prioritized Remediation Plan: '+('verified customer guidance '*8)}
TIMEOUT={'ok':False,'status':'provider_timeout','error':'customer_request_deadline_exceeded','truth':'unknown','answer':'PI could not complete this answer within the safe response window. Please try again.'}
ROUTES={
  '/ready':(200,READY,'pi_chat;dur=812, pi_ingress;dur=3, pi_route;dur=9, pi_edge_model;dur=800'),
  '/bounded-503':(503,TIMEOUT,'pi_chat;dur=19515, pi_ingress;dur=9, pi_route;dur=21, pi_edge_model;dur=19485;desc="inflight"'),
}
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length') or 0))
        if self.path in ROUTES:
            status,body,timing=ROUTES[self.path]; raw=json.dumps(body).encode()
            self.send_response(status); self.send_header('content-type','application/json'); self.send_header('x-pi-request-id',REQUEST_ID); self.send_header('server-timing',timing); self.send_header('content-length',str(len(raw))); self.end_headers(); self.wfile.write(raw)
        elif self.path=='/empty':
            self.send_response(200); self.send_header('content-length','0'); self.end_headers()
        elif self.path=='/headers-then-stall':
            self.send_response(200); self.send_header('content-type','application/json'); self.send_header('x-pi-request-id',REQUEST_ID); self.send_header('content-length','100'); self.end_headers(); self.wfile.flush(); time.sleep(4)
        elif self.path=='/no-response':
            time.sleep(4)

server=ThreadingHTTPServer(('127.0.0.1',0),Handler); server.daemon_threads=True
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_address[1]}'
PROMPT='private-prompt-marker: explain the water cycle'
case=(0,1,PROMPT)
def run(path): return soak.ask(case,base+path,max_time=2)
def no_content_leak(detail):
    blob=json.dumps(detail.get('transport_evidence'))+json.dumps(detail.get('stall_phase'))
    assert 'private-prompt-marker' not in blob and 'guidance' not in blob, blob

# Contract fixtures still hold (same expression the workflow evaluates).
valid_fixture=READY; timeout_fixture=TIMEOUT
assert soak.valid_answer('200',valid_fixture) and soak.honest_timeout('503',timeout_fixture) and not soak.valid_answer('503',timeout_fixture)

# Success: ready, with request id, Worker stage durations and curl phase timings.
ready,elapsed,d=run('/ready')
assert ready is True and d['http']=='200' and d['safe'] is True, d
ev=d['transport_evidence']
assert ev['request_id']==REQUEST_ID, ev
assert ev['server_timing']=={'durations':{'chat':812,'ingress':3,'route':9,'edge_model':800},'inflight':None}, ev
assert set(ev['timing_ms'])==set(soak.TRANSPORT_FIELDS) and ev['timing_ms']['first_byte']>0 and ev['bytes']>0 and ev['connects']==1, ev
assert 'stall_phase' in d and d['stall_phase']=='body'
no_content_leak(d)

# Bounded honest 503: safe degraded (not ready, not zero-byte) with the in-flight Worker stage.
ready,_,d=run('/bounded-503')
assert ready is False and d['safe'] is True and d['status']=='provider_timeout' and not d.get('zero_byte'), d
assert d['transport_evidence']['server_timing']['inflight']=='edge_model', d
assert d['transport_evidence']['server_timing']['durations']['edge_model']==19485
no_content_leak(d)

# Zero-byte: accepted connection, no response before curl --max-time (curl 28), no request id.
ready,elapsed,d=run('/no-response')
assert ready is False and d['transport']=='curl:28' and d['zero_byte'] is True, d
assert d['stall_phase']=='awaiting_first_byte' and d['transport_evidence']['request_id'] is None and d['transport_evidence']['bytes']==0, d
assert soak.TRANSPORT_MARKER not in d['stderr'] and 'curl: (28)' in d['stderr'], d['stderr']
assert 1.5<elapsed<3.5, elapsed
no_content_leak(d)

# Headers arrive but the body stalls: transport failure in the body phase, attributable by request id.
# The inline #211 rule leaves this as not-zero-byte (stdout carries the 200 status), so it stays an unsafe failure.
ready,_,d=run('/headers-then-stall')
assert d['transport']=='curl:28' and d['zero_byte'] is False and d['stall_phase']=='body', d
assert d['transport_evidence']['request_id']==REQUEST_ID, d

# Empty 200 body: zero-byte by the #211 empty-response-body rule.
ready,_,d=run('/empty')
assert d['transport']=='empty-response-body' and d['zero_byte'] is True and d['http']=='200', d

# Connection refused: zero-byte, stalled before connect.
sock=socket.socket(); sock.bind(('127.0.0.1',0)); closed_port=sock.getsockname()[1]; sock.close()
ready,_,d=soak.ask(case,f'http://127.0.0.1:{closed_port}/',max_time=2)
assert d['transport']=='curl:7' and d['zero_byte'] is True and d['stall_phase']=='connect', d

# Unit: parsing ignores non-PI metrics and malformed values; https requires a TLS phase.
assert soak.parse_server_timing('cfRequestDuration;dur=5, pi_chat;dur=7, pi_bad name;dur=1, pi_route;dur=x')=={'durations':{'chat':7},'inflight':None}
assert soak.parse_server_timing('')==None
assert soak.stall_phase({'dns':1,'connect':5,'tls':0,'pretransfer':0,'first_byte':0,'total':22000})=='tls'
assert soak.stall_phase({'dns':1,'connect':5,'tls':0,'pretransfer':6,'first_byte':0,'total':22000},https=False)=='awaiting_first_byte'
assert soak.split_transport('curl: (28) timeout\n')==(None,'curl: (28) timeout')

# Aggregate summary is content-free counts and milliseconds.
details=[run(p)[2] for p in ('/ready','/bounded-503','/no-response')]
summary=soak.transport_summary(details)
assert summary['requests']==3 and summary['with_request_id']==2 and summary['transport_failures']==1, summary
assert summary['transport_failure_phase']=={'awaiting_first_byte':1} and summary['worker_inflight_stage']=={'edge_model':1}, summary
assert 'private-prompt-marker' not in json.dumps(summary)
server.shutdown()
print('PI chat soak evidence passed')
