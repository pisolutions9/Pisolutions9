// PI Investment Lab — deterministic quantitative analysis. No models, no network.
// Every figure is reproducible from its inputs; nothing here is a forecast or advice.

const TRADING_DAYS = 252;
const round = (value, places = 6) => (Number.isFinite(value) ? Number(value.toFixed(places)) : null);

export function portfolioSnapshot({ positions = [], quotes = {}, cash = 0 }) {
  const missingQuotes = [];
  const holdings = positions.map(position => {
    const quote = quotes[position.symbol];
    if (!quote) { missingQuotes.push(position.symbol); return null; }
    const marketValue = position.quantity * quote.last;
    const costBasis = position.averageCost === null ? null : position.quantity * position.averageCost;
    return { symbol: position.symbol, quantity: position.quantity, last: quote.last, marketValue, costBasis, unrealizedPnl: costBasis === null ? null : marketValue - costBasis };
  }).filter(Boolean);
  const invested = holdings.reduce((sum, item) => sum + item.marketValue, 0);
  const totalEquity = invested + cash;
  const withWeights = holdings.map(item => ({ ...item, weight: totalEquity > 0 ? item.marketValue / totalEquity : 0 }))
    .sort((a, b) => b.marketValue - a.marketValue)
    .map(item => Object.freeze(Object.fromEntries(Object.entries(item).map(([key, value]) => [key, typeof value === 'number' ? round(value) : value]))));
  const hhi = withWeights.reduce((sum, item) => sum + item.weight ** 2, 0);
  const pnlKnown = holdings.filter(item => item.unrealizedPnl !== null);
  return Object.freeze({
    holdings: withWeights,
    cash: round(cash),
    invested: round(invested),
    totalEquity: round(totalEquity),
    cashWeight: round(totalEquity > 0 ? cash / totalEquity : 1),
    topWeight: round(withWeights[0]?.weight ?? 0),
    herfindahl: round(hhi),
    effectiveHoldings: round(hhi > 0 ? 1 / hhi : 0, 3),
    unrealizedPnl: pnlKnown.length === holdings.length ? round(pnlKnown.reduce((sum, item) => sum + item.unrealizedPnl, 0)) : null,
    missingQuotes
  });
}

export function logReturns(points = []) {
  const out = [];
  for (let i = 1; i < points.length; i++) out.push({ at: points[i].at, r: Math.log(points[i].close / points[i - 1].close) });
  return out;
}

const mean = values => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
function stdev(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

export function maxDrawdown(closes = []) {
  let peak = -Infinity;
  let worst = 0;
  for (const close of closes) {
    peak = Math.max(peak, close);
    worst = Math.min(worst, close / peak - 1);
  }
  return worst;
}

export function seriesStats(points = []) {
  const returns = logReturns(points).map(item => item.r);
  const closes = points.map(point => point.close);
  const daily = stdev(returns);
  const lookback = Math.min(20, closes.length - 1);
  return Object.freeze({
    observations: points.length,
    totalReturn: round(closes.at(-1) / closes[0] - 1),
    annualizedVolatility: daily === null ? null : round(daily * Math.sqrt(TRADING_DAYS)),
    maxDrawdown: round(maxDrawdown(closes)),
    momentum20d: lookback > 0 ? round(closes.at(-1) / closes.at(-1 - lookback) - 1) : null
  });
}

// Portfolio return series built from the dates every held symbol has in common.
export function portfolioRisk({ holdings = [], series = {}, confidence = 0.95 }) {
  const invested = holdings.filter(item => series[item.symbol]);
  const missing = holdings.filter(item => !series[item.symbol]).map(item => item.symbol);
  if (!invested.length) return Object.freeze({ ok: false, reason: 'no_historicals', missing });
  const returnMaps = invested.map(item => new Map(logReturns(series[item.symbol]).map(row => [row.at, row.r])));
  const dates = [...returnMaps[0].keys()].filter(date => returnMaps.every(map => map.has(date))).sort();
  if (dates.length < 10) return Object.freeze({ ok: false, reason: 'insufficient_overlapping_history', observations: dates.length, missing });
  const totalWeight = invested.reduce((sum, item) => sum + item.weight, 0);
  const daily = dates.map(date => invested.reduce((sum, item, index) => sum + item.weight * returnMaps[index].get(date), 0));
  const sorted = [...daily].sort((a, b) => a - b);
  const tailIndex = Math.max(0, Math.floor((1 - confidence) * sorted.length) - 1);
  const sd = stdev(daily);
  return Object.freeze({
    ok: true,
    observations: dates.length,
    coveredWeight: round(totalWeight),
    missing,
    annualizedVolatility: round(sd * Math.sqrt(TRADING_DAYS)),
    historicalVaR1d: round(-sorted[tailIndex]),
    varConfidence: confidence,
    method: 'historical simulation on equity-weighted daily log returns over overlapping dates; cash assumed zero-return'
  });
}
