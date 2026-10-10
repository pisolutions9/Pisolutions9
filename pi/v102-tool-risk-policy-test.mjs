import assert from 'node:assert/strict';
import { createExecutionPolicy, normalizeToolRisk } from './policy.mjs';
import { createPrincipal } from './capability-guard.mjs';

const policy = createExecutionPolicy({ allowedTools:['read','write','charge','deploy','secret'] });
const reader = createPrincipal('research-agent',['tool:read']);
const writer = createPrincipal('engineering-agent',['tool:read','tool:write']);
const deployer = createPrincipal('release-agent',['tool:read','tool:write','production:change']);
const finance = createPrincipal('finance-agent',['tool:read','money:transfer']);
const secretOperator = createPrincipal('secret-operator',['secret:use','secret:rotate']);

const read = policy.checkAction({
  tool:'read',
  principal:reader,
  risk:{ readOnly:true, retrySafe:true, idempotent:true }
});
assert.equal(read.ok,true);
assert.equal(read.risk.ownerRequired,false);
assert.equal(read.authorization.principalId,'research-agent');
assert.equal(policy.recoveryPolicy({tool:'read',risk:{readOnly:true}}).retryAllowed,true);

const anonymousRead = policy.checkAction({ tool:'read', risk:{ readOnly:true } });
assert.equal(anonymousRead.ok,true);

const anonymousWrite = policy.checkAction({
  tool:'write',
  risk:{ externalSideEffect:true, idempotent:true, verificationRequired:true }
});
assert.equal(anonymousWrite.ok,false);
assert.equal(anonymousWrite.reason,'principal_required');

const underScopedWrite = policy.checkAction({
  tool:'write',
  principal:reader,
  risk:{ externalSideEffect:true, idempotent:true }
});
assert.equal(underScopedWrite.ok,false);
assert.equal(underScopedWrite.reason,'capability_not_granted');
assert.deepEqual(underScopedWrite.authorization.missingScopes,['tool:write']);

const write = policy.checkAction({
  tool:'write',
  principal:writer,
  risk:{ externalSideEffect:true, idempotent:true, verificationRequired:true }
});
assert.equal(write.ok,true);
assert.equal(policy.recoveryPolicy({tool:'write',risk:{externalSideEffect:true,idempotent:true}}).retryAllowed,true);

const charge = policy.checkAction({
  tool:'charge',
  principal:finance,
  risk:{ spendsMoney:true, externalSideEffect:true }
});
assert.equal(charge.ok,false);
assert.equal(charge.reason,'capability_not_granted');
assert.deepEqual(charge.authorization.missingScopes,['tool:write']);

const financeWriter = createPrincipal('finance-executor',['tool:write','money:transfer']);
const unapprovedCharge = policy.checkAction({
  tool:'charge',
  principal:financeWriter,
  risk:{ spendsMoney:true, externalSideEffect:true }
});
assert.equal(unapprovedCharge.ok,false);
assert.equal(unapprovedCharge.reason,'human_approval_required');
assert.equal(unapprovedCharge.risk.ownerRequired,true);
assert.equal(policy.recoveryPolicy({tool:'charge',risk:{spendsMoney:true}}).retryAllowed,false);

const approvedCharge = policy.checkAction({
  tool:'charge',
  principal:financeWriter,
  risk:{spendsMoney:true,externalSideEffect:true},
  approved:true
});
assert.equal(approvedCharge.ok,true);

const deployWithoutScope = policy.checkAction({
  tool:'deploy',
  type:'production_deploy',
  principal:writer,
  risk:{ externalSideEffect:true },
  approved:true
});
assert.equal(deployWithoutScope.ok,false);
assert.equal(deployWithoutScope.reason,'capability_not_granted');

const deployWithScopeButNoOwner = policy.checkAction({
  tool:'deploy',
  type:'production_deploy',
  principal:deployer,
  risk:{ externalSideEffect:true }
});
assert.equal(deployWithScopeButNoOwner.ok,false);
assert.equal(deployWithScopeButNoOwner.reason,'human_approval_required');

assert.equal(policy.checkAction({
  tool:'deploy',
  type:'production_deploy',
  principal:deployer,
  risk:{ externalSideEffect:true },
  approved:true
}).ok,true);

const secretRotation = policy.checkAction({
  tool:'secret',
  type:'secret_rotation',
  principal:secretOperator,
  approved:true
});
assert.equal(secretRotation.ok,true);

const destructive = normalizeToolRisk({tool:'write',risk:{destructive:true,irreversible:true}});
assert.equal(destructive.ownerRequired,true);

console.log('PI tool-risk + least-privilege policy tests passed.');
