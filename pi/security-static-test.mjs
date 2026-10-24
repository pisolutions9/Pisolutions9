import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
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
          findings.push({file:path.relative(root,full),kind:name,sample:match[0].slice(0,12)+'…'});
        }
      }
    }
  }
}
walk(root);
assert.deepEqual(findings,[],`Potential committed secrets detected: ${JSON.stringify(findings)}`);
console.log('PI static secret-safety scan passed.');

// Production deployment must be inert outside the canonical repository main branch.
// This is defense-in-depth; revoking credentials exposed to forks is a separate owner action.
const deployWorkflow=fs.readFileSync(path.join(root,'.github/workflows/pi-chat-worker.yml'),'utf8');
const deployLines=deployWorkflow.split(/\r?\n/);
const deployIndex=deployLines.indexOf('  deploy:');
assert.notEqual(deployIndex,-1,'Production deploy job must exist.');
const firstDeployProperty=deployLines.slice(deployIndex+1).find(line=>line.trim());
const expectedDeployGuard="    if: ${{ github.repository == 'pisolutions9/Pisolutions9' && github.ref == 'refs/heads/main' }}";
assert.equal(firstDeployProperty,expectedDeployGuard,'Production deploy job must deny forks and non-main refs before steps run.');
const contexts=[
  ['canonical main push','pisolutions9/Pisolutions9','refs/heads/main',true],
  ['canonical main dispatch','pisolutions9/Pisolutions9','refs/heads/main',true],
  ['fork main push','PrEM21032/Pisolutions','refs/heads/main',false],
  ['fork main dispatch','PrEM21032/Pisolutions','refs/heads/main',false],
  ['canonical feature branch','pisolutions9/Pisolutions9','refs/heads/feature',false],
  ['unrelated repository','someone/other','refs/heads/main',false]
];
for(const [label,repository,ref,allowed] of contexts){
  assert.equal(repository==='pisolutions9/Pisolutions9' && ref==='refs/heads/main',allowed,label);
}
console.log('PI production deployment identity guard contract passed (6 contexts).');
