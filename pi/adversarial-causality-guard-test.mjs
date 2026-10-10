import assert from 'node:assert/strict';
import { hasUnsupportedCampaignAttribution } from './adversarial-causality-guard.mjs';

const legitimate = [
  'You cannot prove causality from a before/after revenue change alone. Other factors—seasonality, promotions, pricing, competitor activity, or demand—could have changed. Use a counterfactual or A/B test.',
  'Competitor activity is a possible confounder, not evidence that customers switched.',
  'A causal estimate requires a control group; no competitor-loss finding can be inferred.'
];
for (const answer of legitimate) assert.equal(hasUnsupportedCampaignAttribution(answer), false, `valid_confounder_rejected: ${answer}`);

const unsupported = [
  'Customers switched to a competitor, explaining the change.',
  'A competitor stole our customers.',
  'Competitors drove the 9% increase.',
  'The campaign caused the 9% increase.',
  'The campaign generated nine percent of revenue.'
];
for (const answer of unsupported) assert.equal(hasUnsupportedCampaignAttribution(answer), true, `fabricated_attribution_accepted: ${answer}`);

console.log(JSON.stringify({ ok: true, legitimate: legitimate.length, unsupported: unsupported.length }));
