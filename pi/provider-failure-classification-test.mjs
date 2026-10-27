import assert from 'node:assert/strict';
import { isFailClosedProviderFailure } from './provider-failure-classification.mjs';

const honestWeatherFailure = {
  status: 502,
  body: {
    ok: false,
    truth: 'unknown',
    answer: 'PI could not verify current information from the available live research providers, so it will not guess.'
  }
};
assert.equal(isFailClosedProviderFailure(honestWeatherFailure), true);
assert.equal(isFailClosedProviderFailure({ status: 503, body: { ...honestWeatherFailure.body } }), true);
assert.equal(isFailClosedProviderFailure({ status: 502, body: { ok: false, truth: 'unknown', answer: 'It is currently sunny.' } }), false);
assert.equal(isFailClosedProviderFailure({ status: 502, body: { ok: false, truth: 'unknown', answer: 'unknown' } }), false);
assert.equal(isFailClosedProviderFailure({ status: 502, body: { ok: false, answer: 'I could not verify this.' } }), false);
assert.equal(isFailClosedProviderFailure({ status: 200, body: honestWeatherFailure.body }), false);
console.log('PI provider failure classification tests passed.');

