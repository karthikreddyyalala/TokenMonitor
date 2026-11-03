'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { analyzeSavings } = require('../../src/shared/costOptimizer');

// Per-token rates shaped like lookupModelPricing().pricing.
const pricing = {
  'claude-opus-4': { inputCostPerToken: 15e-6, outputCostPerToken: 75e-6, cacheReadInputTokenCost: 1.5e-6, cacheCreationInputTokenCost: 18.75e-6 },
  'claude-sonnet-4': { inputCostPerToken: 3e-6, outputCostPerToken: 15e-6, cacheReadInputTokenCost: 0.3e-6, cacheCreationInputTokenCost: 3.75e-6 }
};

function session(id, model, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, messages = 1 } = {}) {
  return {
    client: 'claude', sessionId: id, title: id, messageCount: messages,
    modelTokenComponents: {
      [model]: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite }
    }
  };
}

test('re-prices light Opus sessions on Sonnet and skips heavy ones', () => {
  const period = {
    sessions: [
      session('light', 'claude-opus-4', { input: 10_000, output: 1_000, messages: 4 }),
      session('long-chat', 'claude-opus-4', { input: 10_000, output: 1_000, messages: 30 }),
      session('big-answer', 'claude-opus-4', { input: 10_000, output: 9_000, messages: 2 }),
      session('already-sonnet', 'claude-sonnet-4', { input: 10_000, output: 1_000, messages: 2 })
    ]
  };
  const result = analyzeSavings(period, { pricing, cheaperModel: 'claude-sonnet-4' });

  // Opus: 10k*15e-6 + 1k*75e-6 = 0.225. Sonnet: 10k*3e-6 + 1k*15e-6 = 0.045.
  assert.deepEqual(result.candidates.map(c => c.sessionId), ['light']);
  assert.ok(Math.abs(result.candidates[0].currentCostUsd - 0.225) < 1e-9);
  assert.ok(Math.abs(result.candidates[0].cheaperCostUsd - 0.045) < 1e-9);
  assert.ok(Math.abs(result.totalSavingsUsd - 0.18) < 1e-9);
  assert.equal(result.skippedModels.length, 0);
});

test('never guesses: models without pricing are skipped and reported', () => {
  const period = { sessions: [session('mystery', 'claude-opus-9', { input: 500, output: 100 })] };
  const result = analyzeSavings(period, { pricing, cheaperModel: 'claude-sonnet-4' });

  assert.equal(result.totalSavingsUsd, 0);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.skippedModels, ['claude-opus-9']);
});

test('handles an empty or missing period', () => {
  assert.equal(analyzeSavings(undefined, { pricing, cheaperModel: 'claude-sonnet-4' }).totalSavingsUsd, 0);
  assert.equal(analyzeSavings({ sessions: [] }, { pricing, cheaperModel: 'claude-sonnet-4' }).shareOfSpend, 0);
});
