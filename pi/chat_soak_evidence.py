"""Per-request customer chat soak evidence for the PI V1 stress workflow.

The answer contracts and the zero-byte classification are moved here unchanged from
.github/workflows/pi-v1-tests.yml so they can be exercised without a live provider.
The workflow keeps every aggregate gate and threshold inline.

New in this module: curl transport timing and the Worker's x-pi-request-id and
server-timing headers are attached to each request's evidence. Those are numbers,
fixed stage tokens and a random id only; no prompt, history, credential or answer
text is added by this evidence.
"""
import json, subprocess, time

legacy_markers=('classification:','i recognized this as an informational question','temporarily operating in verified recovery mode','live model execution is currently unavailable')
readiness_truth={'model-response','verified-model-response','deterministic-verified'}
def valid_answer(status,data):
    answer=data.get('answer','') if isinstance(data,dict) else ''; low=answer.lower() if isinstance(answer,str) else ''
    return status=='200' and isinstance(data,dict) and data.get('ok') is True and data.get('truth') in readiness_truth and data.get('source','').startswith(('pi-chat-cloudflare-ai:','pi-chat-openai:','pi-chat-fallback','pi-chat-deterministic-recovery','pi-deterministic-')) and isinstance(answer,str) and len(answer.strip())>=120 and not low.lstrip().startswith('classification:') and not any(marker in low for marker in legacy_markers[1:])
def provisional_answer(status,data):
    answer=data.get('answer','') if isinstance(data,dict) else ''
    return status=='200' and isinstance(data,dict) and data.get('ok') is True and data.get('truth')=='provisional-model-response' and isinstance(answer,str) and bool(answer.strip())
def safe_refusal(status,data):
    return status=='503' and isinstance(data,dict) and data.get('ok') is False and data.get('status')=='verification_failed' and data.get('error')=='hard_reasoning_not_verified' and data.get('truth')=='unknown' and isinstance(data.get('answer'),str) and bool(data['answer'].strip())
def honest_timeout(status,data):
    return status=='503' and isinstance(data,dict) and data.get('ok') is False and data.get('status')=='provider_timeout' and data.get('error')=='customer_request_deadline_exceeded' and data.get('truth')=='unknown' and isinstance(data.get('answer'),str) and bool(data['answer'].strip())
def safe_recovery(status,data):
    return status=='200' and isinstance(data,dict) and data.get('ok') is True and data.get('truth') in ('deterministic','deterministic-verified') and data.get('source')=='pi-chat-deterministic-recovery' and isinstance(data.get('answer'),str) and bool(data['answer'].strip())

TRANSPORT_MARKER='PI_TRANSPORT'
TRANSPORT_FIELDS=('dns','connect','tls','pretransfer','first_byte','total')
# %{stderr} sends the timing line to stderr so stdout keeps the exact body + '\n%{http_code}' shape.
WRITE_OUT='\n%{http_code}%{stderr}\n'+TRANSPORT_MARKER+'\t'+'\t'.join(['%{time_namelookup}','%{time_connect}','%{time_appconnect}','%{time_pretransfer}','%{time_starttransfer}','%{time_total}','%{size_download}','%{num_connects}','%header{x-pi-request-id}','%header{server-timing}'])+'\n'

def curl_command(url,payload,max_time=22,connect_timeout=5):
    return ['curl','--silent','--show-error','--connect-timeout',str(connect_timeout),'--max-time',str(max_time),'-H','content-type: application/json','-H','origin: https://pisolutions9.github.io','-d',payload,'-w',WRITE_OUT,url]

def parse_server_timing(value):
    """Parse only pi_* Server-Timing metrics into {'durations': {stage: ms}, 'inflight': stage|None}."""
    durations={}; inflight=None
    for metric in (value or '').split(','):
        parts=[part.strip() for part in metric.split(';')]
        name=parts[0]
        if not name.startswith('pi_') or not name[3:].replace('_','').isalnum(): continue
        stage=name[3:]; params=dict(part.split('=',1) for part in parts[1:] if '=' in part)
        try: dur=int(float(params.get('dur','')))
        except ValueError: continue
        durations[stage]=durations.get(stage,0)+dur
        if params.get('desc')=='"inflight"': inflight=stage
    return {'durations':durations,'inflight':inflight} if durations else None

def stall_phase(timing,https=True):
    """Where a transfer stopped, from curl's raw cumulative phase timers (exactly 0 means not reached)."""
    if not timing: return 'unknown'
    if timing['connect']==0: return 'connect'
    if https and timing['tls']==0: return 'tls'
    if timing['first_byte']==0: return 'awaiting_first_byte'
    return 'body'

def split_transport(stderr):
    """Remove the write-out line from stderr and return (transport_evidence|None, remaining_stderr)."""
    kept=[]; evidence=None
    for line in (stderr or '').split('\n'):
        if line.startswith(TRANSPORT_MARKER+'\t'):
            fields=line.split('\t')[1:]
            if len(fields)>=8:
                try:
                    raw_timing={name:float(raw) for name,raw in zip(TRANSPORT_FIELDS,fields[:6])}
                    evidence={'timing_ms':{name:round(value*1000,1) for name,value in raw_timing.items()},'raw_timing_s':raw_timing,'bytes':int(fields[6]),'connects':int(fields[7]),'request_id':(fields[8].strip() if len(fields)>8 else '') or None,'server_timing':parse_server_timing(fields[9] if len(fields)>9 else '')}
                except ValueError: evidence=None
        else:
            kept.append(line)
    return evidence,'\n'.join(kept).strip('\n')

def classify(case,returncode,stdout,stderr,elapsed,https=True):
    """Per-request (ready, elapsed, detail). Classification identical to the inline #211 logic."""
    round_i,q_i,_q=case
    transport,stderr=split_transport(stderr)
    evidence={'transport_evidence':transport}
    if transport: evidence['stall_phase']=stall_phase(transport.pop('raw_timing_s'),https)
    if returncode!=0:return False,elapsed,{'round':round_i+1,'question':q_i,'transport':f'curl:{returncode}','zero_byte':not stdout.strip() or stdout.strip()=='000','stderr':stderr[-240:],**evidence}
    if '\n' not in stdout:return False,elapsed,{'round':round_i+1,'question':q_i,'transport':'missing-http-status','zero_byte':not stdout.strip(),'prefix':stdout[:120],**evidence}
    body,status=stdout.rsplit('\n',1)
    if not body:return False,elapsed,{'round':round_i+1,'question':q_i,'transport':'empty-response-body','zero_byte':True,'http':status,**evidence}
    try:d=json.loads(body)
    except Exception:return False,elapsed,{'round':round_i+1,'question':q_i,'transport':'invalid-json','http':status,'body_prefix':body[:240],**evidence}
    ans=d.get('answer','') if isinstance(d,dict) else ''; ready=valid_answer(status,d)
    safe=ready or provisional_answer(status,d) or safe_refusal(status,d) or honest_timeout(status,d) or safe_recovery(status,d)
    return ready,elapsed,{'round':round_i+1,'question':q_i,'http':status,'ok':d.get('ok') if isinstance(d,dict) else None,'status':d.get('status') if isinstance(d,dict) else None,'length':len(ans) if isinstance(ans,str) else 0,'truth':d.get('truth') if isinstance(d,dict) else None,'source':d.get('source') if isinstance(d,dict) else None,'safe':safe,'verificationReason':d.get('verificationReason') if isinstance(d,dict) else None,'prefix':ans[:120] if isinstance(ans,str) else '',**evidence}

def ask(case,url,max_time=22):
    _round_i,_q_i,q=case
    payload=json.dumps({'message':q}); t=time.time(); p=subprocess.run(curl_command(url,payload,max_time=max_time),capture_output=True,text=True); elapsed=time.time()-t
    return classify(case,p.returncode,p.stdout,p.stderr,elapsed,https=url.startswith('https:'))

def transport_summary(details):
    """Aggregate, content-free transport evidence for the soak log."""
    def pct(values,q):
        if not values: return None
        values=sorted(values); return values[max(0,int(len(values)*q)-1)] if q<1 else values[-1]
    with_evidence=[d for d in details if d.get('transport_evidence')]
    first_byte=[d['transport_evidence']['timing_ms']['first_byte'] for d in with_evidence if d['transport_evidence']['timing_ms']['first_byte']>0]
    failed=[d for d in details if d.get('transport')]
    phases={}; inflight={}
    for d in failed: phases[d.get('stall_phase','unknown')]=phases.get(d.get('stall_phase','unknown'),0)+1
    for d in with_evidence:
        st=d['transport_evidence'].get('server_timing')
        if st and st.get('inflight'): inflight[st['inflight']]=inflight.get(st['inflight'],0)+1
    return {'requests':len(details),'with_transport_evidence':len(with_evidence),'with_request_id':sum(1 for d in with_evidence if d['transport_evidence'].get('request_id')),'first_byte_ms_p50':pct(first_byte,.5),'first_byte_ms_p95':pct(first_byte,.95),'first_byte_ms_max':pct(first_byte,1),'transport_failures':len(failed),'transport_failure_phase':phases,'worker_inflight_stage':inflight}
