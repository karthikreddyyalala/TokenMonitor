import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelKey, priceFor, PRICES } from '../../src/engine/pricing.ts';

test('dated model ids map to their price row', () => {
  assert.equal(modelKey('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.deepEqual(priceFor('claude-haiku-4-5-20251001', 1000), PRICES['claude-haiku-4-5']);
});

test('cache reads use each model listed rate, not a flat 10% of input', () => {
  assert.equal(PRICES['claude-opus-5-5'].read, 0.2); // 0.05x of $4
  assert.equal(PRICES['claude-fable-5-1'].read, 0.25); // 0.025x of $10
  assert.equal(PRICES['claude-opus-5'].read, 0.5); // 0.1x of $5
});

test('1-hour cache writes cost 2x input, 5-minute writes 1.25x', () => {
  for (const [model, p] of Object.entries(PRICES)) {
    assert.equal(p.write1h, p.input * 2, model);
    assert.equal(p.write5m, p.input * 1.25, model);
  }
});

test('Haiku 5.5 prompts over 100k tokens pay the long-prompt rates', () => {
  assert.equal(priceFor('claude-haiku-5-5', 100_000)?.input, 0.1);
  assert.equal(priceFor('claude-haiku-5-5', 100_001)?.input, 0.5);
});

test('unknown models have no price', () => {
  assert.equal(priceFor('claude-unreleased-9', 10), undefined);
});
