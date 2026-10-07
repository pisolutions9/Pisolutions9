const FRESHNESS_PATTERNS = [
  /\b(?:now|right\s+now|today|tonight|current|currently|latest|live|breaking|this\s+(?:hour|morning|afternoon|evening|week))\b/i,
  /\b(?:ippudu|ivala|ee\s+roju|kotha|latest)\b/i
];

const TOPIC_RESET_PATTERNS = [
  /\b(?:forget|ignore|drop|skip|leave)\b.{0,50}\b(?:that|this|previous|prior|above|topic|discussion|migration)\b/i,
  /\b(?:vadiley|odiley|marchipo)\b/i
];

function hasAny(value, patterns) {
  return patterns.some(pattern => pattern.test(value));
}

function arithmeticStructure(value) {
  const numbers = value.match(/[-+]?\d[\d,]*(?:\.\d+)?/g) || [];
  const operator = /[×*÷/+-]/.test(value) || /\b(?:plus|minus|times|multipl(?:y|ied)|divide|divided|total|sum|product|each|per)\b/i.test(value);
  return numbers.length >= 2 && operator;
}

function detectCapability(message = '', attachmentInfo = null) {
  const value = String(message);
  if (attachmentInfo) return 'file';
  if (arithmeticStructure(value)) return 'calculation';
  if (/\b(?:weather|forecast|rain|temperature|temp|snow|storm|humidity|wind)\b/i.test(value)) return 'weather';
  if (/\b(?:news|headline|headlines|breaking|latest\s+(?:update|updates|development|developments))\b/i.test(value)) return 'news';
  if (/\b(?:buy|shopping|shop|price|deal|deals|cheapest|product|amazon|walmart|best\s+price)\b/i.test(value)) return 'shopping';
  if (/\b(?:email|send\s+(?:a\s+)?message|delete|deploy|purchase|pay|payment|charge|refund|cancel\s+subscription)\b/i.test(value)) return 'external_action';
  if (/\b(?:code|debug|bug|function|javascript|typescript|python|repository|github|api|sql|server|migration)\b/i.test(value)) return 'coding';
  return 'general_reasoning';
}

function detectAction(message = '') {
  const value = String(message);
  if (/\b(?:delete|remove|erase|trash)\b/i.test(value)) return 'delete';
  if (/\b(?:pay|payment|charge|purchase|buy)\b/i.test(value)) return 'payment';
  if (/\b(?:send|email|message|post|publish)\b/i.test(value)) return 'send';
  if (/\b(?:deploy|release|merge|push\s+to\s+production)\b/i.test(value)) return 'deploy';
  return null;
}

function inferHistoryDependency(message = '', history = []) {
  if (!Array.isArray(history) || history.length === 0) return false;
  if (hasAny(String(message), TOPIC_RESET_PATTERNS)) return false;
  return /\b(?:it|that|those|them|same|again|change|instead|previous|above|month\s*\d+)\b/i.test(String(message));
}

export function buildTaskContract({ message = '', history = [], attachmentInfo = null } = {}) {
  const raw = String(message).trim();
  const capability = detectCapability(raw, attachmentInfo);
  const action = detectAction(raw);
  const freshnessRequired = capability === 'weather' || capability === 'news' || hasAny(raw, FRESHNESS_PATTERNS);
  const explicitTopicReset = hasAny(raw, TOPIC_RESET_PATTERNS);
  const historyDependent = inferHistoryDependency(raw, history);

  const risk = action === 'payment' || action === 'delete' || action === 'deploy'
    ? 'high'
    : action === 'send'
      ? 'medium'
      : 'low';

  return Object.freeze({
    schema: 'pi.task.v1',
    raw,
    capability,
    action,
    freshnessRequired,
    explicitTopicReset,
    historyDependent,
    risk,
    deterministicPreferred: capability === 'calculation',
    verification: capability === 'calculation'
      ? 'deterministic'
      : freshnessRequired
        ? 'source-grounded'
        : risk === 'high'
          ? 'external-outcome-plus-human'
          : 'risk-proportional'
  });
}

export function capabilityRoute(task = {}) {
  if (task.freshnessRequired) return 'live';
  if (task.capability === 'coding' || task.capability === 'general_reasoning') return 'reasoning';
  if (task.deterministicPreferred) return 'deterministic';
  return 'tool';
}
