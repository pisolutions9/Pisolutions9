import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic two-stage proof: no broker, network, or credential imports.
const round = n => Math.round(n * 100) / 100;
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(round(n)).toFixed(2);
export const digest = record => crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
const positive = (n, label) => { if (!Number.isFinite(n) || n <= 0) throw new Error('invalid_' + label); return n; };

export function freezeDecision(t0) {
  if (t0?.provenance !== 'synthetic-fixture') throw new Error('synthetic_t0_required');
  const { at, capital, candidate, benchmark, policy, costs } = t0;
  if (!Number.isFinite(Date.parse(at))) throw new Error('invalid_t0_time');
  positive(capital, 'capital');
  positive(candidate?.price, 'candidate_price');
  positive(candidate?.shares, 'candidate_shares');
  positive(benchmark?.price, 'benchmark_price');
  if (!candidate?.symbol || !benchmark?.symbol || !Number.isFinite(policy?.maxSinglePositionWeight) || policy.maxSinglePositionWeight <= 0 || policy.maxSinglePositionWeight > 1) throw new Error('invalid_policy');
  if (!Number.isFinite(costs?.slippageBps) || costs.slippageBps < 0 || !Number.isFinite(costs?.commissionPerOrder) || costs.commissionPerOrder < 0) throw new Error('invalid_costs');
  const weight = candidate.price * candidate.shares / capital;
  const affordable = candidate.price * candidate.shares * (1 + costs.slippageBps / 10000) + costs.commissionPerOrder <= capital;
  const approved = weight <= policy.maxSinglePositionWeight && affordable;
  // Recompute in percent independently of the decision branch.
  const challengerWeight = 100 * candidate.shares * candidate.price / capital;
  if ((challengerWeight <= 100 * policy.maxSinglePositionWeight && affordable) !== approved) throw new Error('challenge_disagrees');
  const record = {
    schema: 'pi.investment-lab.decision-proof.v1', provenance: 'synthetic-fixture', at, capital,
    candidate: { symbol: candidate.symbol, shares: candidate.shares, price: candidate.price },
    benchmark: { symbol: benchmark.symbol, price: benchmark.price },
    policy: { maxSinglePositionWeight: policy.maxSinglePositionWeight },
    costs: { slippageBps: costs.slippageBps, commissionPerOrder: costs.commissionPerOrder },
    proposedWeightPercent: round(weight * 100), decision: approved ? 'paper_buy_candidate' : 'hold_cash',
    reason: approved ? 'within_owner_limit' : affordable ? 'exceeds_owner_concentration_limit' : 'insufficient_cash',
    challenge: { independentlyComputedWeightPercent: round(challengerWeight), agrees: true },
    thesis: 'An owner-set concentration rule checks a single-position bet; it is not a price forecast.'
  };
  return { record, sha256: digest(record) };
}

function roundTrip(capital, quantity, entry, exit, costs) {
  const slip = costs.slippageBps / 10000;
  const buy = quantity * entry * (1 + slip) + costs.commissionPerOrder;
  if (buy > capital + 1e-8) throw new Error('trade_exceeds_capital');
  return round(capital - buy + quantity * exit * (1 - slip) - costs.commissionPerOrder);
}

export function revealOutcome(frozen, t1) {
  if (digest(frozen?.record) !== frozen?.sha256) throw new Error('decision_record_changed');
  const r = frozen.record;
  const weight = r.candidate.price * r.candidate.shares / r.capital;
  const affordable = r.candidate.price * r.candidate.shares * (1 + r.costs.slippageBps / 10000) + r.costs.commissionPerOrder <= r.capital;
  const expectedDecision = weight <= r.policy.maxSinglePositionWeight && affordable ? 'paper_buy_candidate' : 'hold_cash';
  const expectedReason = expectedDecision === 'paper_buy_candidate' ? 'within_owner_limit' : affordable ? 'exceeds_owner_concentration_limit' : 'insufficient_cash';
  if (r.decision !== expectedDecision || r.reason !== expectedReason || r.proposedWeightPercent !== round(weight * 100)) throw new Error('decision_rule_inconsistent');
  if (r.provenance !== 'synthetic-fixture' || t1?.provenance !== 'synthetic-fixture') throw new Error('synthetic_data_required');
  if (!(Date.parse(t1.at) > Date.parse(r.at))) throw new Error('outcome_must_follow_decision');
  const candidatePrice = positive(t1.prices?.[r.candidate.symbol], 'candidate_outcome');
  const benchmarkPrice = positive(t1.prices?.[r.benchmark.symbol], 'benchmark_outcome');
  const rejectedCandidate = roundTrip(r.capital, r.candidate.shares, r.candidate.price, candidatePrice, r.costs);
  const slip = r.costs.slippageBps / 10000;
  const benchmarkShares = (r.capital - r.costs.commissionPerOrder) / (r.benchmark.price * (1 + slip));
  const benchmark = roundTrip(r.capital, benchmarkShares, r.benchmark.price, benchmarkPrice, r.costs);
  const noAction = r.capital;
  const pi = r.decision === 'hold_cash' ? noAction : rejectedCandidate;
  const independentCandidate = round(r.capital - r.candidate.shares * r.candidate.price * (1 + slip) - r.costs.commissionPerOrder + r.candidate.shares * candidatePrice * (1 - slip) - r.costs.commissionPerOrder);
  const independentBenchmark = round(r.capital - benchmarkShares * r.benchmark.price * (1 + slip) - r.costs.commissionPerOrder + benchmarkShares * benchmarkPrice * (1 - slip) - r.costs.commissionPerOrder);
  if (rejectedCandidate !== independentCandidate || benchmark !== independentBenchmark) throw new Error('independent_outcome_check_failed');
  return { schema: 'pi.investment-lab.decision-outcome.v1', provenance: 'synthetic-fixture', decisionHash: frozen.sha256, at: t1.at,
    revealedPrices: { [r.candidate.symbol]: candidatePrice, [r.benchmark.symbol]: benchmarkPrice },
    initialCapital: r.capital, endingValue: { pi, noAction, benchmark, rejectedCandidate },
    challenge: { independentCandidate, independentBenchmark, agrees: true },
    limitation: 'One invented case proves mechanics and discipline, not an investment edge or future prediction.' };
}

export function formatOwnerProof(frozen, outcome) {
  const r = frozen.record, e = outcome.endingValue;
  const row = (label, value) => '| ' + label + ' | ' + usd(value) + ' | ' + usd(value - r.capital) + ' |';
  return [
    '# PI Decision Lab — owner proof', '',
    '**SYNTHETIC ONLY · PAPER DECISION · NO BROKER CONNECTION**', '',
    'At ' + r.at + ', fictional ' + r.candidate.symbol + ' at ' + usd(r.candidate.price) + ' would consume **' + r.proposedWeightPercent.toFixed(2) + '%** of ' + usd(r.capital) + '. Owner limit: ' + (r.policy.maxSinglePositionWeight * 100).toFixed(0) + '%. An independent arithmetic check agreed.', '',
    '**Frozen decision:** ' + (r.decision === 'hold_cash' ? 'Hold cash; reject the concentrated purchase.' : 'Buy in the paper ledger.') + ' Reason: ' + r.reason + '. SHA-256: `' + frozen.sha256 + '`.', '',
    'The ' + r.benchmark.symbol + ' benchmark and trade costs (' + r.costs.slippageBps + ' bps slippage, ' + usd(r.costs.commissionPerOrder) + ' per order) were set before the outcome.', '',
    'At ' + outcome.at + ', separately revealed fictional prices: ' + r.candidate.symbol + ' ' + usd(outcome.revealedPrices[r.candidate.symbol]) + '; ' + r.benchmark.symbol + ' ' + usd(outcome.revealedPrices[r.benchmark.symbol]) + '. Every path starts with ' + usd(r.capital) + ' and uses the same costs for trades.', '',
    '| Path | Ending value | Change |', '|---|---:|---:|',
    row('PI paper decision', e.pi), row('Do nothing', e.noAction), row('Predeclared benchmark', e.benchmark), row('Rejected purchase, counterfactual', e.rejectedCandidate), '',
    '**Proved:** the plan command works with the outcome file absent, the rule is applied before reveal, and independent arithmetic agrees. The hash detects changes to the frozen record. **Limits:** these invented fixtures were authored together; the hash is not an independent timestamp. One synthetic case cannot establish an investment edge or predict returns. A rejected purchase could have risen.', ''
  ].join('\n');
}

const main = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const fixture = path.join(root, 'decision-proof-fixture');
  const frozenPath = path.join(root, 'evidence', 'decision-frozen.json');
  const stage = process.argv[2];
  if (stage === 'plan') {
    const t0 = JSON.parse(fs.readFileSync(path.join(fixture, 't0.json'), 'utf8'));
    const frozen = freezeDecision(t0); // This stage never opens the T1 file.
    fs.writeFileSync(frozenPath, JSON.stringify(frozen, null, 2) + '\n');
    console.log('Synthetic decision frozen: ' + frozen.sha256);
  } else if (stage === 'reveal') {
    const frozen = JSON.parse(fs.readFileSync(frozenPath, 'utf8'));
    const t1 = JSON.parse(fs.readFileSync(path.join(fixture, 't1.json'), 'utf8'));
    const report = formatOwnerProof(frozen, revealOutcome(frozen, t1));
    fs.writeFileSync(path.join(root, 'evidence', 'decision-proof.md'), report);
    console.log(report);
  } else {
    throw new Error('Use plan or reveal stage');
  }
}
