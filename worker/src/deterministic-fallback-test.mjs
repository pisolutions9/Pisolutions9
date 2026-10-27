import assert from 'node:assert/strict';
import { deterministicArithmetic, deterministicFallback, deterministicFallbackResult } from './deterministic-fallback.mjs';

assert.equal(deterministicFallback('What is 2 plus 2?'), 'The answer is 4.');
assert.match(deterministicFallback('Why is the sky blue?'), /scatters shorter blue wavelengths/);
assert.match(deterministicFallback('Say hello in one short sentence.'), /^Hello/);
assert.match(deterministicFallback('Hello'), /^Hello/);
assert.equal(deterministicFallback('What is 12 divided by 3?'), 'The answer is 4.');
assert.match(deterministicFallback('Tell me the stock price of Apple right now.'), /live model provider is currently unavailable/);
assert.match(deterministicFallback('Tell me something cool'), /Venus/);
assert.match(deterministicFallback('What is the difference between RAM and storage?'), /RAM is fast, temporary working memory/);
assert.match(deterministicFallback('What is opportunity cost?'), /Opportunity cost is what you give up/);
const marketplaceRecovery = deterministicFallback('Build me a website for launching my own products like Amazon.');
assert.match(marketplaceRecovery, /concrete marketplace MVP blueprint/i);
assert.match(marketplaceRecovery, /users, sellers, products/i);
assert.match(marketplaceRecovery, /POST \/checkout\/session/);
assert.match(marketplaceRecovery, /idempotency keys/);
assert.match(marketplaceRecovery, /webhook replay tests/);
assert.match(marketplaceRecovery, /No external website.*was created/i);
assert.match(deterministicFallback('Create a website for my business.'), /software build/);

const growth = deterministicFallback('You are given a company with $2M annual revenue, 35% gross margin, 18% churn, and $300k cash. Design a 12-month plan to reach $5M revenue while preserving cash runway. State assumptions, calculate key metrics, identify risks, and give a prioritized execution sequence.');
assert.ok(growth.length >= 160);
assert.match(growth, /2.5x growth/);
assert.match(growth, /gross profit/);
assert.match(growth, /cash runway|cash burn/);

const quantum = deterministicFallback('Explain quantum computing to a software engineer. Compare it with classical computing, give one concrete example where it could matter, and clearly separate what is practical today from what is still experimental.');
assert.ok(quantum.length >= 160);
assert.match(quantum, /quantum states/);
assert.match(quantum, /classical/);
assert.match(quantum, /experimental/);

const semiconductor = deterministicFallback('A country wants to reduce semiconductor import dependence by 30% in five years. Build a neutral analytical framework covering supply chain, capital, talent, technology, tradeoffs, measurable milestones, and key uncertainties. Do not assume any particular policy is best.');
assert.ok(semiconductor.length >= 160);
assert.match(semiconductor, /supply chain|packaging|manufacturing/);
assert.match(semiconductor, /30%/);
assert.match(semiconductor, /uncertainty/);

console.log('Deterministic chat recovery tests passed.');


const verifiedMarketplace = deterministicFallbackResult('Build me a website for launching my own products like Amazon.');
assert.equal(verifiedMarketplace.verified, true);
assert.equal(verifiedMarketplace.verification, 'curated-deterministic-recovery');

const verifiedQuantum = deterministicFallbackResult('Explain quantum computing to a software engineer. Compare it with classical computing, give one concrete example where it could matter, and clearly separate what is practical today from what is still experimental.');
assert.equal(verifiedQuantum.verified, true);

const genericUnavailable = deterministicFallbackResult('Tell me the stock price of Apple right now.');
assert.equal(genericUnavailable.verified, false);
assert.equal(genericUnavailable.verification, 'unverified-generic-recovery');

console.log('Curated deterministic recovery metadata tests passed.');

assert.equal(deterministicArithmetic('Calculate 17 * 19.'), '323');
assert.equal(deterministicArithmetic('What is 17 plus 25?'), '42');
assert.equal(deterministicArithmetic('17 * 19. explain'), null);
assert.equal(deterministicArithmetic('17 * 19..'), null);
assert.equal(deterministicArithmetic('17 * 19,'), null);
console.log('Arithmetic sentence punctuation regressions passed.');

