import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');

// Release blocker #148: hard-reasoning retries must compact rather than reuse
// the original long-form instructions inside the smaller 700-token budget.
assert.match(source, /const\s+HARD_COMPACT_RETRY_INSTRUCTIONS\s*=/, 'hard-reasoning compact retry instructions must exist');
assert.match(source, /HARD_REASONING_INSTRUCTIONS\s*\?[^\n]*HARD_COMPACT_RETRY_INSTRUCTIONS|instructions\s*===\s*HARD_REASONING_INSTRUCTIONS[\s\S]{0,240}HARD_COMPACT_RETRY_INSTRUCTIONS/, 'hard reasoning must route to hard compact retry instructions');

// Preserve the bounded V1.02 output budgets and fail-closed incomplete detector.
assert.match(source, /const\s+MAX_OUTPUT_TOKENS\s*=\s*1200\s*;/, 'global output ceiling must remain bounded at 1200');
assert.match(source, /const\s+COMPACT_OUTPUT_TOKENS\s*=\s*700\s*;/, 'compact retry budget must remain bounded at 700');
assert.match(source, /function\s+edgeResultIncomplete\s*\(/, 'fail-closed incomplete detector must remain present');

console.log('hard compact retry contract: ok');
