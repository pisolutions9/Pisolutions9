// PI Investment Lab — tolerant normalizers from sanitized MCP payloads to lab schemas.
// Robinhood's MCP response shapes were not verifiable from this environment, so these
// accept several common field spellings and fail closed (return problems) rather than guess.

export function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function pick(object, keys) {
  for (const key of keys) if (object && object[key] !== undefined && object[key] !== null) return object[key];
  return undefined;
}

function rows(data, keys) {
  if (Array.isArray(data)) return data;
  for (const key of keys) if (Array.isArray(data?.[key])) return data[key];
  return null;
}

const symbolOf = row => {
  const value = pick(row, ['symbol', 'ticker', 'instrument_symbol']);
  return typeof value === 'string' && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(value.toUpperCase()) ? value.toUpperCase() : null;
};

export function normalizeAccounts(data) {
  const list = rows(data, ['accounts', 'results', 'data']);
  if (!list) return { ok: false, problems: ['accounts_shape_unrecognized'], accounts: [] };
  const problems = [];
  const accounts = list.map((row, index) => {
    const accountRef = pick(row, ['account_number', 'accountNumber', 'account_id', 'accountId', 'account']);
    const type = String(pick(row, ['type', 'account_type', 'accountType']) || 'unknown').toLowerCase();
    const cash = num(pick(row, ['cash', 'settled_cash', 'cash_balance', 'cashBalance']));
    if (cash === null) problems.push(`account_${index}_cash_missing`);
    return Object.freeze({
      accountRef: typeof accountRef === 'string' && accountRef.startsWith('acct_ref_') ? accountRef : null,
      type,
      cash,
      buyingPower: num(pick(row, ['buying_power', 'buyingPower'])),
      marginEnabled: type === 'margin' || num(pick(row, ['margin_limit', 'marginLimit'])) > 0
    });
  });
  if (accounts.some(account => !account.accountRef)) problems.push('account_ref_missing');
  return { ok: problems.length === 0, problems, accounts };
}

export function normalizePortfolio(data) {
  const row = Array.isArray(data) ? data[0] : (data?.portfolio || data);
  const equity = num(pick(row, ['equity', 'total_equity', 'totalEquity', 'market_value_total']));
  const marketValue = num(pick(row, ['market_value', 'marketValue', 'positions_value']));
  const problems = equity === null ? ['portfolio_equity_missing'] : [];
  return { ok: problems.length === 0, problems, portfolio: Object.freeze({ equity, marketValue }) };
}

export function normalizePositions(data) {
  const list = rows(data, ['positions', 'holdings', 'results', 'data']);
  if (!list) return { ok: false, problems: ['positions_shape_unrecognized'], positions: [] };
  const problems = [];
  const positions = [];
  list.forEach((row, index) => {
    const symbol = symbolOf(row);
    const quantity = num(pick(row, ['quantity', 'shares', 'qty']));
    const averageCost = num(pick(row, ['average_buy_price', 'average_cost', 'averageCost', 'avg_cost', 'cost_basis_per_share']));
    if (!symbol || quantity === null) { problems.push(`position_${index}_unparseable`); return; }
    if (quantity < 0) problems.push(`position_${index}_short_detected`);
    if (quantity === 0) return;
    positions.push(Object.freeze({ symbol, quantity, averageCost }));
  });
  return { ok: problems.length === 0, problems, positions };
}

export function normalizeQuotes(data) {
  const list = rows(data, ['quotes', 'results', 'data']);
  if (!list) return { ok: false, problems: ['quotes_shape_unrecognized'], quotes: {} };
  const problems = [];
  const quotes = {};
  list.forEach((row, index) => {
    const symbol = symbolOf(row);
    const last = num(pick(row, ['last_trade_price', 'last_price', 'price', 'last', 'mark_price']));
    if (!symbol || last === null || last <= 0) { problems.push(`quote_${index}_unparseable`); return; }
    const updatedAt = pick(row, ['updated_at', 'updatedAt', 'timestamp', 'as_of']);
    quotes[symbol] = Object.freeze({ symbol, last, bid: num(pick(row, ['bid_price', 'bid'])), ask: num(pick(row, ['ask_price', 'ask'])), updatedAt: typeof updatedAt === 'string' ? updatedAt : null });
  });
  return { ok: problems.length === 0, problems, quotes };
}

export function normalizeHistoricals(data) {
  const list = rows(data, ['historicals', 'results', 'data', 'series']);
  if (!list) return { ok: false, problems: ['historicals_shape_unrecognized'], series: {} };
  const problems = [];
  const series = {};
  list.forEach((row, index) => {
    const symbol = symbolOf(row);
    const bars = rows(row, ['historicals', 'bars', 'candles', 'data']);
    if (!symbol || !bars) { problems.push(`historicals_${index}_unparseable`); return; }
    const points = bars.map(bar => ({ at: String(pick(bar, ['begins_at', 't', 'time', 'date']) || ''), close: num(pick(bar, ['close_price', 'close', 'c'])) }))
      .filter(point => point.at && point.close !== null && point.close > 0)
      .sort((a, b) => a.at.localeCompare(b.at));
    if (points.length < 2) { problems.push(`historicals_${symbol}_too_short`); return; }
    series[symbol] = Object.freeze(points.map(point => Object.freeze(point)));
  });
  return { ok: problems.length === 0, problems, series };
}
