import { createConfiguredModelProvider, createModelProviderAdapters, createAnthropicMessagesProvider } from './model-adapters.mjs';

const provider = createConfiguredModelProvider({
  name: 'test-model',
  capabilities: ['reasoning'],
  run: async input => ({ truth: 'probable', completed: [], evidence: [{ source: 'test-model', claim: String(input.objective) }] })
});

if (!provider) throw new Error('provider_not_created');
const adapters = createModelProviderAdapters([provider]);
if (typeof adapters['test-model'] !== 'function') throw new Error('adapter_not_exposed');
const result = await adapters['test-model']({ objective: 'test' });
if (result.truth !== 'probable') throw new Error('adapter_result_failed');

const disabled = createConfiguredModelProvider({ name: 'disabled', run: async () => ({}), enabled: false });
if (disabled !== null) throw new Error('disabled_provider_exposed');

const missingKeyProvider = createAnthropicMessagesProvider({ apiKey: '', enabled: true });
let missingKeyRejected = false;
try {
  await missingKeyProvider.run({ objective: 'classify this request' });
} catch (error) {
  missingKeyRejected = String(error?.message || error) === 'anthropic_api_key_missing';
}
if (!missingKeyRejected) throw new Error('anthropic_missing_key_not_rejected');

const originalFetch = globalThis.fetch;
let capturedRequest = null;
globalThis.fetch = async (url, options = {}) => {
  capturedRequest = { url: String(url), options };
  return new Response(JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify({ truth: 'probable', completed: [], evidence: [], nextAction: 'benchmark_only', uncertainty: 'low' }) }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

try {
  const haiku = createAnthropicMessagesProvider({ apiKey: 'test-key', effort: 'low', maxTokens: 800 });
  const value = await haiku.run({ objective: 'route a low-cost classification task' });
  if (value.nextAction !== 'benchmark_only') throw new Error('anthropic_result_parse_failed');
  if (!capturedRequest?.url.endsWith('/v1/messages')) throw new Error('anthropic_wrong_endpoint');
  if (capturedRequest.options.headers.authorization !== 'Bearer test-key') throw new Error('anthropic_auth_header_missing');
  if (capturedRequest.options.headers['anthropic-version'] !== '2023-06-01') throw new Error('anthropic_version_header_missing');
  const body = JSON.parse(capturedRequest.options.body);
  if (body.model !== 'claude-haiku-5-5') throw new Error('anthropic_wrong_model');
  if (body.output_config?.effort !== 'low') throw new Error('anthropic_wrong_effort');
  if (body.max_tokens !== 800) throw new Error('anthropic_wrong_max_tokens');
} finally {
  globalThis.fetch = originalFetch;
}

console.log(JSON.stringify({
  ok: true,
  providerBoundary: true,
  disabledProvidersExcluded: true,
  anthropicHaiku55Adapter: true,
  noLiveSpendInTest: true
}));
