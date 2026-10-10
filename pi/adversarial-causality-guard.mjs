// The adversarial test must reject unsupported causal attribution without
// rejecting a legitimate mention of competitors as possible confounders.
export function hasUnsupportedCampaignAttribution(answer = '') {
  const value = String(answer);
  return [
    /\bcustomers?\s+(?:switched|moved|left|went)\s+(?:to|for)\s+(?:a\s+)?competitors?\b/i,
    /\bcompetitors?\s+(?:stole|poached|took|captured)\s+(?:our\s+)?customers?\b/i,
    /\b(?:competitors?|campaign)\s+(?:caused|drove|generated)\s+(?:the\s+)?(?:entire\s+)?(?:9\s*%|nine\s+percent)(?=\s|[.,;!?]|$)/i
  ].some(pattern => pattern.test(value));
}
