import { createModelProvider } from './model-contract.mjs';

export function createConfiguredModelProvider({ name, run, capabilities = [], enabled = true } = {}) {
  if (!enabled) return null;
  if (!name || typeof run !== 'function') throw new Error('invalid_model_provider');
  return createModelProvider({ name, run, capabilities });
}

export function createModelProviderAdapters(providers = []) {
  return Object.fromEntries(
    providers.filter(Boolean).map(provider => [provider.name, provider.run.bind(provider)])
  );
}

export function createOpenAIResponsesProvider({
  name = 'openai',
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.PI_OPENAI_MODEL || 'gpt-5.6-luna',
  baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  enabled = true
} = {}) {
  if (!enabled) return null;

  return createConfiguredModelProvider({
    name,
    capabilities: ['reasoning', 'text'],
    run: async input => {
      if (!apiKey) throw new Error('openai_api_key_missing');
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          input: [
            {
              role: 'system',
              content: [{ type: 'input_text', text: 'You are PI intelligence. Return only JSON with keys truth, completed, evidence, nextAction, uncertainty. Never claim an external action is completed without evidence.' }]
            },
            {
              role: 'user',
              content: [{ type: 'input_text', text: JSON.stringify(input ?? {}) }]
            }
          ]
        })
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`openai_http_${response.status}:${detail.slice(0, 500)}`);
      }
      const payload = await response.json();
      const text = payload.output_text || payload.output?.flatMap(item => item.content || []).map(item => item.text || '').join('') || '';
      if (!text) throw new Error('openai_empty_response');
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('openai_non_json_response');
      }
    }
  });
}

export function createAnthropicMessagesProvider({
  name = 'anthropic-haiku-5-5',
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.PI_ANTHROPIC_MODEL || 'claude-haiku-5-5',
  baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
  effort = process.env.PI_ANTHROPIC_EFFORT || 'low',
  maxTokens = Number(process.env.PI_ANTHROPIC_MAX_TOKENS || 1600),
  enabled = true
} = {}) {
  if (!enabled) return null;

  return createConfiguredModelProvider({
    name,
    capabilities: ['text', 'routing', 'classification', 'extraction', 'compaction', 'subagent'],
    run: async input => {
      if (!apiKey) throw new Error('anthropic_api_key_missing');
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 1600,
          output_config: { effort },
          system: 'You are a low-cost PI specialist. Return only JSON with keys truth, completed, evidence, nextAction, uncertainty. Never claim an external action is completed without evidence.',
          messages: [
            {
              role: 'user',
              content: JSON.stringify(input ?? {})
            }
          ]
        })
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`anthropic_http_${response.status}:${detail.slice(0, 500)}`);
      }
      const payload = await response.json();
      const text = Array.isArray(payload.content)
        ? payload.content.filter(item => item?.type === 'text').map(item => item.text || '').join('')
        : '';
      if (!text) throw new Error('anthropic_empty_response');
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('anthropic_non_json_response');
      }
    }
  });
}
