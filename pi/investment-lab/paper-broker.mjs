// PI Investment Lab — simulated (paper) trades only.
// This module intentionally imports nothing that can reach a broker: it has no MCP client,
// no gateway, no network. Fills are hypothetical, priced from the inspected quote snapshot.
// Cash-only: no margin, no shorting, no options. Every record says simulated: true.

const SIDES = new Set(['buy', 'sell']);

export function createPaperBroker({ cash, positions = [], quotes = {}, slippageBps = 5, maxQuoteAgeMs = null, now = () => Date.now() } = {}) {
  if (!Number.isFinite(cash) || cash < 0) throw new Error('paper_broker_requires_non_negative_cash');
  const ledger = { cash, holdings: new Map(positions.map(position => [position.symbol, position.quantity])) };
  const fills = [];
  const rejections = [];

  function reject(order, reason) {
    const record = Object.freeze({ simulated: true, submittedToBroker: false, status: 'rejected', reason, order: { ...order } });
    rejections.push(record);
    return record;
  }

  return Object.freeze({
    simulateOrder(order = {}) {
      const side = String(order.side || '').toLowerCase();
      const symbol = String(order.symbol || '').toUpperCase();
      const quantity = Number(order.quantity);
      if (!SIDES.has(side)) return reject(order, 'invalid_side');
      if (order.type && order.type !== 'market') return reject(order, 'only_simulated_market_orders_supported');
      if (!Number.isFinite(quantity) || quantity <= 0) return reject(order, 'invalid_quantity');
      const quote = quotes[symbol];
      if (!quote) return reject(order, 'no_quote_for_symbol');
      if (maxQuoteAgeMs !== null) {
        const age = now() - Date.parse(quote.updatedAt || '');
        if (!Number.isFinite(age) || age > maxQuoteAgeMs) return reject(order, 'stale_or_undated_quote');
      }
      const reference = side === 'buy' ? (quote.ask ?? quote.last) : (quote.bid ?? quote.last);
      const price = reference * (1 + (side === 'buy' ? 1 : -1) * slippageBps / 10_000);
      const notional = Number((price * quantity).toFixed(6));
      const held = ledger.holdings.get(symbol) || 0;
      if (side === 'buy' && notional > ledger.cash + 1e-9) return reject(order, 'insufficient_settled_cash_no_margin');
      if (side === 'sell' && quantity > held + 1e-9) return reject(order, 'exceeds_holding_no_shorting');
      const cashBefore = ledger.cash;
      ledger.cash = Number((ledger.cash + (side === 'buy' ? -notional : notional)).toFixed(6));
      const after = held + (side === 'buy' ? quantity : -quantity);
      if (after === 0) ledger.holdings.delete(symbol); else ledger.holdings.set(symbol, after);
      const fill = Object.freeze({
        simulated: true,
        submittedToBroker: false,
        status: 'simulated_fill',
        id: `sim_${fills.length + 1}`,
        at: new Date(now()).toISOString(),
        side, symbol, quantity,
        referencePrice: reference,
        price: Number(price.toFixed(6)),
        slippageBps,
        notional,
        cashBefore,
        cashAfter: ledger.cash
      });
      fills.push(fill);
      return fill;
    },
    state() {
      return Object.freeze({
        simulated: true,
        cash: ledger.cash,
        positions: [...ledger.holdings].map(([symbol, quantity]) => ({ symbol, quantity, averageCost: null })),
        fills: [...fills],
        rejections: [...rejections]
      });
    }
  });
}
