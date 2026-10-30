// PI Investment Lab — human-reviewed tool allowlists. Code-reviewed data only:
// there is deliberately no environment variable, config file or runtime path that can extend these.

// EMPTY until an owner-controlled review verifies Robinhood's actual tools/list output and tool
// behaviour against Robinhood's official documentation (see PI_INVESTMENT_LAB.md, "Owner steps").
// While empty, the live path refuses before any network I/O.
export const ROBINHOOD_REVIEWED_ALLOWLIST = Object.freeze([]);

// Synthetic fixture only. Fingerprints are literal so any drift in the fixture's tool definitions
// breaks the pin, exactly as drift on a real server would.
export const FIXTURE_REVIEWED_ALLOWLIST = Object.freeze([
  { capability: 'accounts', name: 'get_accounts', fingerprint: '980206331cc2de8916c09bbc7d2b69e3b743d078e9fe02a173e5df5fda86afea', args: {}, accountArg: null },
  { capability: 'portfolio', name: 'get_portfolio', fingerprint: '3497ec4915c5698a9f1bdd4cd23e3fd64e947cf5158911e5a77dea7d5bcf6470', args: {}, accountArg: 'account_number' },
  { capability: 'positions', name: 'get_positions', fingerprint: '9b5f0b20f53b0c867e78ab0ed235173ae61b8e9c50656bb6203c9130b401509b', args: {}, accountArg: 'account_number' },
  { capability: 'quotes', name: 'get_quotes', fingerprint: 'a4159c1119de386061f9098745eb93d8f28b451f368db03d2f442ba2f249c193', args: { symbols: 'string' }, accountArg: null },
  { capability: 'historicals', name: 'get_historicals', fingerprint: '2d8dae945ea9afceec53197e7c7a0241ebbfb8298b03f44df45abcdfcbb2267c', args: { symbols: 'string', interval: 'string', span: 'string' }, accountArg: null }
].map(entry => Object.freeze({ ...entry, args: Object.freeze(entry.args) })));
