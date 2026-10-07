import assert from 'node:assert/strict';
import { buildTaskContract, capabilityRoute } from './task-contract.mjs';
import { evaluateTaskPolicy, policyAllowsAutomaticSideEffect } from './policy-engine.mjs';

const mixedArithmetic = buildTaskContract({ message: '29 mandi each 14 checks chesthe total enta?' });
assert.equal(mixedArithmetic.capability, 'calculation');
assert.equal(mixedArithmetic.deterministicPreferred, true);
assert.equal(mixedArithmetic.freshnessRequired, false);
assert.equal(capabilityRoute(mixedArithmetic), 'deterministic');

const weather = buildTaskContract({ message: 'mobile al weather now next six hrs rain?' });
assert.equal(weather.capability, 'weather');
assert.equal(weather.freshnessRequired, true);
assert.equal(weather.verification, 'source-grounded');
assert.equal(capabilityRoute(weather), 'live');

const topicSwitch = buildTaskContract({
  message: 'postgres migration gurinchi vadiley. 37 servers each 460 req/sec total enta?',
  history: [{ role: 'user', content: 'We are discussing a postgres migration.' }]
});
assert.equal(topicSwitch.capability, 'calculation');
assert.equal(topicSwitch.explicitTopicReset, true);
assert.equal(topicSwitch.historyDependent, false);
assert.equal(topicSwitch.deterministicPreferred, true);

const news = buildTaskContract({ message: 'AI lo kotha news enti ivala?' });
assert.equal(news.capability, 'news');
assert.equal(news.freshnessRequired, true);
assert.equal(capabilityRoute(news), 'live');

const payment = buildTaskContract({ message: 'Charge the customer $10 now' });
const paymentPolicy = evaluateTaskPolicy(payment);
assert.equal(payment.action, 'payment');
assert.equal(paymentPolicy.requiresApproval, true);
assert.equal(paymentPolicy.denyModelOnlyCompletion, true);
assert.equal(paymentPolicy.maxAutonomy, 'prepare-only');
assert.equal(policyAllowsAutomaticSideEffect(payment, paymentPolicy), false);

const send = buildTaskContract({ message: 'Send this email to the customer' });
const sendPolicy = evaluateTaskPolicy(send);
assert.equal(send.action, 'send');
assert.equal(send.risk, 'medium');
assert.equal(sendPolicy.maxAutonomy, 'bounded');

console.log('execution kernel task/policy regressions: ok');
