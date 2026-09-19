import OpenAI from 'openai';

const ALLOWED_ORIGIN = 'https://pisolutions9.github.io';
const MAX_INPUT = 8000;
const DEFAULT_MAX_TOKENS = 700;

function json(body, statusCode = 200, origin = '') {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin'
  };
  if (origin === ALLOWED_ORIGIN) headers['access-control-allow-origin'] = ALLOWED_ORIGIN;
  return { statusCode, headers, body: JSON.stringify(body) };
}

function requestOrigin(event) {
  return event?.headers?.origin || event?.headers?.Origin || '';
}

function classify(message) {
  const current = /\b(today|current|currently|latest|live|now|weather|forecast|price|stock|score|news|election|availability)\b/i.test(message);
  const consequential = /\b(invest|investment|loan|legal|medical|health|immigration|tax|contract|insurance|security|password|credential)\b/i.test(message);
  const complex = message.length > 900 || /\b(compare|research|analy[sz]e|strategy|plan|evaluate|investigate|best option|pros and cons)\b/i.test(message);
  return {
    current,
    consequential,
    complex,
    verification: current || consequential ? 'required' : complex ? 'targeted' : 'light',
    route: current ? 'needs-live-evidence' : consequential || complex ? 'reasoned' : 'fast'
  };
}

function tokenBudget(profile) {
  if (profile.route === 'fast') return 450;
  if (profile.route === 'reasoned') return 750;
  return DEFAULT_MAX_TOKENS;
}

function systemPrompt(profile) {
  return `You are PI V1.02, coordinated by Krishna. Your goal is maximum useful accuracy per unit of compute.
Answer the user's actual question directly, naturally, and concisely. Never expose internal chain-of-thought.
Do not invent current facts, sources, actions, prices, availability, or verification. If live evidence is required but unavailable in this runtime, clearly say what cannot be verified and still provide the useful non-current part.
For consequential claims, distinguish established facts from assumptions or estimates. Mention uncertainty only where it changes the user's decision.
Before finalizing, silently challenge the most important conclusion: identify the strongest failure condition or missing fact and correct the answer if needed.
When genuinely useful, include one short "PI discovered" insight: something material the user did not explicitly ask but should know. Do not force this section on trivial questions.
Never recommend a commercial option because it pays PI. Truth and user benefit are independent from monetization.
Never claim an external action was completed unless execution evidence exists.
Verification policy: ${profile.verification}. Route: ${profile.route}.`;
}

export async function handler(event) {
  const origin = requestOrigin(event);
  if (origin && origin !== ALLOWED_ORIGIN) return json({ ok: false, error: 'origin_not_allowed' }, 403, origin);
  if (event.httpMethod === 'OPTIONS') return json({ ok: true }, 204, origin);
  if (event.httpMethod !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json({ ok: false, error: 'invalid_json' }, 400, origin); }
  const message = String(payload?.message || '').trim();
  if (!message) return json({ ok: false, error: 'message_required' }, 400, origin);
  if (message.length > MAX_INPUT) return json({ ok: false, error: 'message_too_large' }, 413, origin);

  const profile = classify(message);
  const maxTokens = tokenBudget(profile);

  try {
    const client = new OpenAI();
    const completion = await client.chat.completions.create({
      model: process.env.PI_CHAT_MODEL || 'gpt-4o-mini',
      temperature: 0.15,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt(profile) },
        { role: 'user', content: message }
      ]
    });
    const answer = completion.choices?.[0]?.message?.content?.trim();
    if (!answer) return json({ ok: false, error: 'empty_model_response' }, 502, origin);
    const usage = completion.usage || {};
    return json({
      ok: true,
      answer,
      source: 'pi-v1.02-governor',
      truth: profile.current ? 'live-verification-unavailable' : 'model-response',
      intelligence: {
        route: profile.route,
        verification: profile.verification,
        maxOutputTokens: maxTokens
      },
      usage: {
        promptTokens: usage.prompt_tokens ?? null,
        completionTokens: usage.completion_tokens ?? null,
        totalTokens: usage.total_tokens ?? null
      }
    }, 200, origin);
  } catch (error) {
    return json({ ok: false, error: 'chat_provider_unavailable', detail: String(error?.message || error).slice(0, 240) }, 503, origin);
  }
}
