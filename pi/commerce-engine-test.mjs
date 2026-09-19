import { strict as assert } from 'node:assert';
import { detectCommercialIntent, buildCommerceOpportunity } from './commerce-engine.mjs';

assert.equal(detectCommercialIntent('What is 17 x 24?'), null);
assert.equal(detectCommercialIntent('What should I pack for my trip?'), 'travel');

const none = buildCommerceOpportunity({ message: 'What is 17 x 24?', truthAnswer: '408', partners: [] });
assert.equal(none.eligible, false);

const partner = {
  active: true,
  intent: 'travel',
  provider: 'Example Travel Service',
  url: 'https://example.com',
  disclosure: 'PI may receive a commission if you choose this optional service.'
};
const one = buildCommerceOpportunity({ message: 'Help with my trip', truthAnswer: 'Pack light.', partners: [partner] });
assert.equal(one.eligible, true);
assert.equal(one.offer.optional, true);
assert.match(one.offer.disclosure, /commission/i);

const higherCommission = { ...partner, provider: 'Higher Commission Co', url: 'https://example.org', commission: 999 };
const ambiguous = buildCommerceOpportunity({ message: 'Help with my trip', truthAnswer: 'Pack light.', partners: [partner, higherCommission] });
assert.equal(ambiguous.eligible, false);
assert.equal(ambiguous.reason, 'independent_relevance_required');

const noTruth = buildCommerceOpportunity({ message: 'Help with my trip', truthAnswer: '', partners: [partner] });
assert.equal(noTruth.eligible, false);
assert.equal(noTruth.reason, 'truth_answer_required');

console.log(JSON.stringify({ ok: true, truthFirst: true, optionalCommerce: true, commissionIndependent: true }));
