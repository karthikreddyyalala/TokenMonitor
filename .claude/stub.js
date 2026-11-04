const days = Array.from({ length: 120 }, (_, i) => { const d = new Date(Date.now() - i * 864e5); return { date: d.toISOString().slice(0, 10), tokens: 2e6 + (i * 7919 % 9e6), cost: 3 + (i * 31 % 40) }; });
window.tokenMonitor = {
  dashboard: { ready() {}, close() {}, minimize() {} },
  getDashboardHistory: async () => ({ daily: days, monthly: [{ month: days[0].date.slice(0, 7), tokens: 4e8, cost: 412.37 }], summary: { totalTokens: 4.1e8, totalCost: 412.37, activeDays: 28, currentStreak: 9, messages: 3871, favoriteModel: 'claude-opus-4-6' } }),
  getSettings: async () => ({ currency: 'USD' }),
  getNativeMaterialState: async () => null,
  onNativeMaterialState() {}, onSettingsPush() {}, onDashboardHistoryChanged() {}, updateSettings() {},
  getXray: () => new Promise((r) => setTimeout(() => r(window.__xray || {
    totalUsd: 412.37, sessionCount: 21, reReadShare: 0.607, readPerWritten: 376.4, skippedModels: [],
    parts: {
      cacheRead: { tokens: 500640000, costUsd: 250.31, share: 0.607 },
      cacheWrite: { tokens: 20650000, costUsd: 129.07, share: 0.313 },
      output: { tokens: 1336000, costUsd: 33.40, share: 0.081 },
      input: { tokens: 12100, costUsd: 0.06, share: 0.00015 }
    },
    rebuilds: { count: 245, costUsd: 71.84, startContextTokens: 65275,
      expired: { count: 160, tokens: 38139326, costUsd: 46.9 }, unexplained: { count: 54, tokens: 15886951, costUsd: 16.3 }, modelSwitch: { count: 31, tokens: 6979022, costUsd: 8.64 } },
    heaviest: [
      { title: 'Refactor limits collector to stream provider windows', reReadUsd: 38.12, contextTokens: 482000 },
      { title: 'Savings card glass and odometer', reReadUsd: 21.7, contextTokens: 0 },
      { title: 'Runaway detector replay evaluation', reReadUsd: 14.05, contextTokens: 213400 }
    ]
  }), 900)),
  getSavings: (p) => new Promise((r) => setTimeout(() => r(window.__savings || {
    totalSavingsUsd: 47.83, affectedSpendUsd: 61.2, shareOfSpend: 0.116, skippedModels: [],
    candidates: [
      { title: 'Fix flaky date parsing test in collector', currentCostUsd: 9.42, cheaperCostUsd: 1.88, savingsUsd: 7.54 },
      { title: 'Rename helper and update imports', currentCostUsd: 6.1, cheaperCostUsd: 1.22, savingsUsd: 4.88 },
      { title: 'Update README install steps', currentCostUsd: 3.35, cheaperCostUsd: 0.67, savingsUsd: 2.68 },
      { title: 'x', currentCostUsd: 1, cheaperCostUsd: 0.2, savingsUsd: 0.8 }
    ]
  }), 900))
};
