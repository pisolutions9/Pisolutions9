import assert from 'node:assert/strict';
import {normalizePaymentEvent,createIdempotencyKey,entitlementFromSubscription,shouldProcessEvent} from './payments.mjs';

assert.deepEqual(normalizePaymentEvent({id:'evt_1',type:'checkout.completed'}).id,'evt_1');
assert.throws(()=>normalizePaymentEvent({type:'x'}),/payment_event_invalid/);
assert.equal(createIdempotencyKey({customerId:'cus_1',action:'checkout',priceId:'price_1'}),'cus_1:checkout:price_1');
assert.throws(()=>createIdempotencyKey({customerId:'cus_1',action:'checkout'}),/idempotency_input_invalid/);
assert.equal(entitlementFromSubscription({id:'sub_1',customer:'cus_1',status:'active'}).entitled,true);
assert.equal(entitlementFromSubscription({id:'sub_1',customer:'cus_1',status:'past_due'}).entitled,false);
assert.equal(entitlementFromSubscription({status:'active'}).entitled,false);
const seen=new Set(['evt_seen']);
assert.equal(shouldProcessEvent('evt_seen',seen),false);
assert.equal(shouldProcessEvent('evt_new',seen),true);
assert.throws(()=>shouldProcessEvent('',seen),/payment_event_id_required/);
console.log('PI payment core tests passed');
