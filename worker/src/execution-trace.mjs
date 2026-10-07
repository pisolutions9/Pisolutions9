function clean(value){
  if(value===undefined) return null;
  if(typeof value==='string') return value.length>500?`${value.slice(0,500)}…`:value;
  if(Array.isArray(value)) return value.slice(0,20).map(clean);
  if(value&&typeof value==='object'){
    const out={};
    for(const [k,v] of Object.entries(value)){
      if(/secret|token|authorization|password|cookie|api[_-]?key/i.test(k)) out[k]='[REDACTED]';
      else out[k]=clean(v);
    }
    return out;
  }
  return value;
}

export function createExecutionTrace({runId,taskId=null,now=Date.now()}={}){
  if(!runId) throw new Error('run_id_required');
  return {schema:'pi.trace.v1',runId:String(runId),taskId:taskId?String(taskId):String(runId),startedAt:Number(now),events:[]};
}

export function appendTrace(trace,event,{now=Date.now()}={}){
  if(!trace||trace.schema!=='pi.trace.v1') throw new Error('invalid_trace');
  const normalized={seq:trace.events.length+1,at:Number(now),type:String(event?.type||'event'),component:String(event?.component||'unknown'),status:event?.status?String(event.status):null,latencyMs:Number.isFinite(event?.latencyMs)?Number(event.latencyMs):null,costUsd:Number.isFinite(event?.costUsd)?Number(event.costUsd):null,data:clean(event?.data??null)};
  trace.events.push(Object.freeze(normalized));
  return normalized;
}

export function traceSummary(trace){
  if(!trace||trace.schema!=='pi.trace.v1') throw new Error('invalid_trace');
  return Object.freeze({runId:trace.runId,taskId:trace.taskId,eventCount:trace.events.length,totalLatencyMs:trace.events.reduce((n,e)=>n+(e.latencyMs||0),0),totalCostUsd:Number(trace.events.reduce((n,e)=>n+(e.costUsd||0),0).toFixed(8)),failures:trace.events.filter(e=>e.status==='failure').map(e=>({seq:e.seq,component:e.component,type:e.type}))});
}
