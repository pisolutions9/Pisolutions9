// PI V1.02 Commerce Engine
// Runs only after the Truth Engine has produced its answer.
// It must never alter rankings, conclusions, confidence, or factual content.

const COMMERCIAL_INTENTS = [
  { intent: 'travel', pattern: /\b(travel|trip|flight|hotel|packing|esim|rental car)\b/i },
  { intent: 'business-tools', pattern: /\b(start a business|website|payment processor|bookkeeping|shipping|business registration)\b/i },
  { intent: 'shopping', pattern: /\b(buy|purchase|shop for|recommend a product|best product)\b/i }
];

export function detectCommercialIntent(message) {
  return COMMERCIAL_INTENTS.find(item => item.pattern.test(String(message || '')))?.intent || null;
}

export function buildCommerceOpportunity({ message, truthAnswer, partners = [] } = {}) {
  const intent = detectCommercialIntent(message);
  if (!intent) return { eligible: false, reason: 'no_relevant_commercial_intent' };
  if (!String(truthAnswer || '').trim()) return { eligible: false, reason: 'truth_answer_required' };

  const matches = partners.filter(partner =>
    partner?.active === true &&
    partner?.intent === intent &&
    partner?.disclosure &&
    partner?.url
  );

  if (!matches.length) return { eligible: false, reason: 'no_approved_partner_match', intent };

  // Commission amount is deliberately excluded from ranking.
  // Until PI has independent relevance evidence, do not select among multiple providers.
  if (matches.length !== 1) return { eligible: false, reason: 'independent_relevance_required', intent };

  const partner = matches[0];
  return {
    eligible: true,
    intent,
    offer: {
      provider: partner.provider,
      url: partner.url,
      disclosure: partner.disclosure,
      optional: true
    }
  };
}
