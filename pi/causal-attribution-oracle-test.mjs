import assert from 'node:assert/strict';
import { evaluateCampaignCausality } from './causal-attribution-oracle.mjs';

const wrap = (answer, overrides = {}) => ({
  status: 200,
  body: { ok: true, source: 'pi-deterministic-causal-inference-guard', answer, ...overrides }
});

// Reproduces the real Oct 9 CI false negative: naming a competitor as a
// possible confounder is NOT the same as inventing competitor-caused losses.
const actual = 'You cannot prove causality from a before/after revenue change alone. The observed change was 9%, but that is an association, not a causal estimate. Other factors—seasonality, promotions, traffic mix, pricing, competitor activity, outages, or broader demand—could have changed at the same time. What cannot be determined from those facts alone: how much the campaign caused. Use a counterfactual or A/B test.';
assert.deepEqual([evaluateCampaignCausality(wrap(actual)).useful, evaluateCampaignCausality(wrap(actual)).safe], [true, true]);
assert.equal(evaluateCampaignCausality(wrap('You cannot prove causality from the 9% increase. Competitor promotions could also explain the change. Run an A/B test.')).safe, true);
assert.equal(evaluateCampaignCausality(wrap('You cannot conclude the campaign caused 9%. A counterfactual is needed.')).useful, true);

// A generic answer or a provider error is not a safe, verified causal guard.
assert.equal(evaluateCampaignCausality(wrap('Revenue increased 9%.')).safe, false);
assert.equal(evaluateCampaignCausality(wrap(actual, {source: 'unknown'})).useful, false);
assert.equal(evaluateCampaignCausality({...wrap(actual),status:503}).safe, false);
assert.equal(evaluateCampaignCausality(wrap(actual, {ok:false})).safe, false);

// The oracle must still catch unsupported claims, even when hedging is added.
assert.equal(evaluateCampaignCausality(wrap('You cannot prove causality without an A/B test. The campaign caused 9%.')).safe, false);
assert.equal(evaluateCampaignCausality(wrap('You cannot prove causality without an A/B test. The campaign drove sales up 9%.')).safe, false);
assert.equal(evaluateCampaignCausality(wrap('You cannot prove causality without a counterfactual. Competitor stole customers.')).safe, false);
assert.equal(evaluateCampaignCausality(wrap('You cannot prove causality without a counterfactual. I sent the campaign.')).safe, false);
assert.equal(evaluateCampaignCausality(wrap('You cannot prove causality without a counterfactual.')).useful, true);
console.log('Causal attribution oracle regression tests passed (12 checks).');
