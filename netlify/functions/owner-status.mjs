const json=(status,body)=>({statusCode:status,headers:{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"},body:JSON.stringify(body)});
export async function handler(event){
 const expected=process.env.PI_OWNER_DASHBOARD_TOKEN;
 if(!expected) return json(503,{error:"owner dashboard not configured"});
 const supplied=event.headers?.["x-pi-owner-token"]||event.headers?.["X-Pi-Owner-Token"];
 if(!supplied||supplied!==expected) return json(401,{error:"owner authentication required"});
 // V1 intentionally exposes no guessed telemetry. A trusted server-side state producer must populate PI_OWNER_STATUS_JSON.
 let state; try{state=JSON.parse(process.env.PI_OWNER_STATUS_JSON||"");}catch{return json(503,{error:"verified owner state unavailable"});}
 if(!state||state.verified!==true) return json(503,{error:"verified owner state unavailable"});
 return json(200,{...state,generated_at:state.generated_at||new Date().toISOString()});
}