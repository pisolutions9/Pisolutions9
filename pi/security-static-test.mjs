import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=new URL('../',import.meta.url);
const skip=new Set(['.git','node_modules']);
const findings=[];
const patterns=[
  ['stripe_live_secret',/\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g],
  ['stripe_webhook_secret',/\bwhsec_[A-Za-z0-9]{20,}\b/g],
  ['github_pat',/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ['openai_project_key',/\bsk-proj-[A-Za-z0-9_-]{20,}\b/g],
  ['private_key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g]
];
function walk(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(skip.has(entry.name))continue;
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())walk(full);
    else if(entry.isFile()){
      const stat=fs.statSync(full);
      if(stat.size>1_000_000)continue;
      let text='';try{text=fs.readFileSync(full,'utf8')}catch{continue}
      for(const [name,regex] of patterns){
        regex.lastIndex=0;
        for(const match of text.matchAll(regex)){
          findings.push({file:path.relative(root.pathname,full),kind:name,sample:match[0].slice(0,12)+'…'});
        }
      }
    }
  }
}
walk(root.pathname);
assert.deepEqual(findings,[],`Potential committed secrets detected: ${JSON.stringify(findings)}`);
console.log('PI static secret-safety scan passed.');
