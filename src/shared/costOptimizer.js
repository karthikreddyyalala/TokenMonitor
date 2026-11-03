'use strict';

const { estimatedCost } = require('./providers/codex/localUsage');

// ponytail: "light task" is a size heuristic (short chat, short answer). The
// smart classifier (Task 5) replaces it.
const LIGHT_MAX_OUTPUT_TOKENS = 4000;
const LIGHT_MAX_MESSAGES = 10;

function isLightTask(session, components) {
  return (session.messageCount || 0) <= LIGHT_MAX_MESSAGES
    && (components.outputTokens || 0) <= LIGHT_MAX_OUTPUT_TOKENS;
}

function toUsage(components) {
  return {
    input: components.inputTokens || 0,
    cacheRead: components.cacheReadTokens || 0,
    cacheWrite: components.cacheWriteTokens || 0,
    output: components.outputTokens || 0,
    total: components.totalTokens || 0
  };
}

// Re-prices the Opus tokens of light sessions at `cheaperModel` rates.
// `pricing` maps model id -> per-token rates; models missing from it are
// reported in skippedModels instead of being guessed.
function analyzeSavings(period, { pricing = {}, cheaperModel, isLight = isLightTask } = {}) {
  const candidates = [];
  const skipped = new Set();
  let totalSpendUsd = 0;
  const cheaperPricing = pricing[cheaperModel];

  for (const session of period?.sessions || []) {
    for (const [model, components] of Object.entries(session.modelTokenComponents || {})) {
      const usage = toUsage(components);
      const current = pricing[model] ? estimatedCost(usage, pricing[model]) : null;
      if (current) totalSpendUsd += current.cost;
      if (!/opus/i.test(model) || !isLight(session, components)) continue;
      if (!current || current.unpricedTokens) { skipped.add(model); continue; }
      if (!cheaperPricing) { skipped.add(cheaperModel); continue; }
      const cheaper = estimatedCost(usage, cheaperPricing);
      if (cheaper.unpricedTokens) { skipped.add(cheaperModel); continue; }
      candidates.push({
        client: session.client,
        sessionId: session.sessionId,
        title: session.title,
        model,
        currentCostUsd: current.cost,
        cheaperCostUsd: cheaper.cost,
        savingsUsd: current.cost - cheaper.cost
      });
    }
  }

  candidates.sort((a, b) => b.savingsUsd - a.savingsUsd);
  const totalSavingsUsd = candidates.reduce((sum, c) => sum + c.savingsUsd, 0);
  return {
    totalSavingsUsd,
    affectedSpendUsd: candidates.reduce((sum, c) => sum + c.currentCostUsd, 0),
    shareOfSpend: totalSpendUsd > 0 ? totalSavingsUsd / totalSpendUsd : 0,
    candidates,
    skippedModels: [...skipped]
  };
}

module.exports = { analyzeSavings, isLightTask };
