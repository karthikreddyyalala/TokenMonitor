'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  analyzeXray, auditClaudeLogs, auditClaudeTurns, createHeavySessionWatch, readClaudeTurns
} = require('../../src/shared/tokenXray');

const MIN = 60_000;
const pricing = {
  'claude-opus-4': { inputCostPerToken: 5e-6, outputCostPerToken: 25e-6, cacheReadInputTokenCost: 0.5e-6, cacheCreationInputTokenCost: 6.25e-6, cacheCreation1hInputTokenCost: 10e-6 },
  'claude-sonnet-4': { inputCostPerToken: 3e-6, outputCostPerToken: 15e-6, cacheReadInputTokenCost: 0.3e-6, cacheCreationInputTokenCost: 3.75e-6 }
};

function session(id, model, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, context = 0 } = {}) {
  return {
    client: 'claude', sessionId: id, title: id, contextTokens: context,
    modelTokenComponents: { [model]: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } }
  };
}

// Periods key sessions by id, as the collector builds them.
const keyed = (...list) => Object.fromEntries(list.map((s) => [`${s.client}:${s.sessionId}`, s]));

// One assistant turn as auditClaudeTurns expects it.
function turn(minute, { model = 'claude-opus-4', context = 100_000, cacheWrite = 2_000, oneHour = true, sidechain = false } = {}) {
  return { t: minute * MIN, model, input: 0, output: 500, cacheWrite, cacheRead: context - cacheWrite, oneHourCache: oneHour, sidechain };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xray-'));
}

test('splits spend into re-reading, cache loads, writing and new input with each model\'s prices', () => {
  const result = analyzeXray({
    sessions: keyed(
      session('big', 'claude-opus-4', { input: 1_000, output: 10_000, cacheRead: 2_000_000, cacheWrite: 100_000, context: 400_000 }),
      session('small', 'claude-sonnet-4', { output: 1_000, cacheRead: 100_000, cacheWrite: 10_000, context: 30_000 })
    )
  }, { pricing });

  // Opus: read 2M*0.5e-6 = 1.00, write 100k*6.25e-6 = 0.625, out 10k*25e-6 = 0.25, in 1k*5e-6 = 0.005.
  // Sonnet: read 100k*0.3e-6 = 0.03, write 10k*3.75e-6 = 0.0375, out 1k*15e-6 = 0.015.
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  close(result.parts.cacheRead.costUsd, 1.03);
  close(result.parts.cacheWrite.costUsd, 0.6625);
  close(result.parts.output.costUsd, 0.265);
  close(result.parts.input.costUsd, 0.005);
  close(result.totalUsd, 1.9625);
  close(result.reReadShare, 1.03 / 1.9625);
  assert.equal(result.readPerWritten, 2_100_000 / 11_000);
  assert.deepEqual(result.heaviest.map((s) => s.sessionId), ['big', 'small']);
  assert.equal(result.heaviest[0].contextTokens, 400_000);
  assert.equal(result.sessionCount, 2);
});

test('never guesses: models without full pricing are left out and reported', () => {
  const result = analyzeXray({
    sessions: keyed(
      session('priced', 'claude-sonnet-4', { output: 1_000, cacheRead: 10_000 }),
      session('mystery', 'claude-opus-9', { output: 1_000, cacheRead: 10_000 }),
      session('partial', 'half-priced', { output: 1_000, cacheRead: 10_000 })
    )
  }, { pricing: { ...pricing, 'half-priced': { outputCostPerToken: 1e-6 } } });

  assert.deepEqual(result.skippedModels.sort(), ['claude-opus-9', 'half-priced']);
  assert.equal(result.parts.cacheRead.tokens, 10_000);
  assert.deepEqual(result.heaviest.map((s) => s.sessionId), ['priced']);
});

test('prices cache writes at the 1-hour rate for sessions that keep a 1-hour cache', () => {
  const oneHour = { ...session('long-cache', 'claude-opus-4', { cacheWrite: 100_000 }), promptCache: { ttlSeconds: 3600 } };
  const noOneHourRate = { ...session('short-cache', 'claude-sonnet-4', { cacheWrite: 100_000 }), promptCache: { ttlSeconds: 3600 } };
  const result = analyzeXray({ sessions: keyed(oneHour, noOneHourRate) }, { pricing });

  // Opus has a 1-hour rate: 100k*10e-6 = 1.00. Sonnet has none listed, so it keeps its base rate: 100k*3.75e-6 = 0.375.
  assert.ok(Math.abs(result.parts.cacheWrite.costUsd - 1.375) < 1e-9);
  assert.deepEqual(result.skippedModels, []);
});

test('an empty or missing period reports zero without dividing by zero', () => {
  for (const period of [undefined, { sessions: {} }]) {
    const result = analyzeXray(period, { pricing });
    assert.equal(result.totalUsd, 0);
    assert.equal(result.reReadShare, 0);
    assert.equal(result.readPerWritten, 0);
    assert.deepEqual(result.heaviest, []);
    assert.equal(result.rebuilds, null);
  }
});

test('reads each Claude Code turn once, even though the log repeats it per content block', async () => {
  const dir = tempDir();
  const file = path.join(dir, 's.jsonl');
  const usage = { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 1_200, cache_creation: { ephemeral_1h_input_tokens: 1_200, ephemeral_5m_input_tokens: 0 } };
  const line = (id, extra = {}) => JSON.stringify({ type: 'assistant', requestId: `r-${id}`, timestamp: `2026-10-01T10:0${id}:00.000Z`, message: { id: `m-${id}`, model: 'claude-opus-4', usage }, ...extra });
  fs.writeFileSync(file, [
    line(2), line(2), JSON.stringify({ type: 'user', message: { content: 'hi' } }), '{not json', line(1), line(3, { isSidechain: true }), ''
  ].join('\n'));

  const turns = await readClaudeTurns(file);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((x) => x.t), [Date.parse('2026-10-01T10:01:00Z'), Date.parse('2026-10-01T10:02:00Z'), Date.parse('2026-10-01T10:03:00Z')]);
  assert.deepEqual(turns[0], { t: turns[0].t, model: 'claude-opus-4', input: 3, output: 40, cacheWrite: 1_200, cacheRead: 90_000, oneHourCache: true, sidechain: false });
  assert.equal(turns[2].sidechain, true);
});

test('finds full cache rebuilds and tells apart expired, model switch and unexplained ones', () => {
  const result = auditClaudeTurns([
    turn(0, { context: 70_000, cacheWrite: 70_000 }), // session start: not a rebuild
    turn(1),
    turn(2, { cacheWrite: 30_000 }), // big but under 60% of context: new files, not a rebuild
    turn(90, { cacheWrite: 100_000 }), // 88 min idle > 1h cache
    turn(91, { cacheWrite: 100_000 }), // no gap at all
    turn(92, { model: 'claude-sonnet-4', cacheWrite: 100_000 }), // first Sonnet turn
    turn(93, { context: 40_000, cacheWrite: 40_000 }), // context shrank: compacted, not a reload
    turn(94, { context: 10_000, cacheWrite: 10_000, sidechain: true }), // subagent: ignored
    turn(95, { context: 41_000, cacheWrite: 1_000, oneHour: false }),
    turn(101, { context: 42_000, cacheWrite: 42_000, oneHour: false }) // 6 min idle > 5 min cache
  ]);

  assert.deepEqual(result.rebuilds.map((r) => [r.t / MIN, r.kind, r.tokens]), [
    [90, 'expired', 100_000], [91, 'unexplained', 100_000], [92, 'modelSwitch', 100_000], [101, 'expired', 42_000]
  ]);
  assert.deepEqual(result.rebuilds.map((r) => r.oneHour), [true, true, true, false]);
  assert.equal(result.minContext, 40_000);
  assert.equal(result.startedAt, 0);
});

test('audits a projects folder, keeps only the period, and reuses unchanged files', async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'proj'));
  const write = (name, rows) => fs.writeFileSync(path.join(root, 'proj', name), rows.map((r) => JSON.stringify(r)).join('\n'));
  const row = (i, iso, cacheWrite) => ({
    type: 'assistant', requestId: `r${i}`, timestamp: iso,
    message: { id: `m${i}`, model: 'claude-opus-4', usage: { input_tokens: 0, output_tokens: 10, cache_read_input_tokens: 100_000 - cacheWrite, cache_creation_input_tokens: cacheWrite, cache_creation: { ephemeral_1h_input_tokens: cacheWrite } } }
  });
  write('a.jsonl', [row(1, '2026-10-01T09:00:00Z', 60_000), row(2, '2026-10-01T09:01:00Z', 1_000), row(3, '2026-10-01T09:02:00Z', 100_000)]);
  write('b.jsonl', [row(4, '2026-09-01T09:00:00Z', 60_000), row(5, '2026-09-01T09:01:00Z', 100_000)]);
  fs.writeFileSync(path.join(root, 'proj', 'notes.txt'), 'ignored');
  fs.utimesSync(path.join(root, 'proj', 'b.jsonl'), new Date('2026-09-01T10:00:00Z'), new Date('2026-09-01T10:00:00Z'));

  const cache = new Map();
  const since = Date.parse('2026-10-01T00:00:00Z');
  const audit = await auditClaudeLogs({ projectsDir: root, since, cache });
  assert.deepEqual(audit.events.map((e) => e.kind), ['unexplained']);
  assert.deepEqual(audit.startContexts, [100_000]);
  assert.equal(cache.size, 1, 'b.jsonl was last written before the period, so it is never read');

  const cached = cache.get(path.join(root, 'proj', 'a.jsonl'));
  assert.equal((await auditClaudeLogs({ projectsDir: root, since, cache })).events.length, 1);
  assert.equal(cache.get(path.join(root, 'proj', 'a.jsonl')), cached, 'unchanged file is not re-read');

  assert.equal(await auditClaudeLogs({ projectsDir: path.join(root, 'missing'), since }), null);
});

test('prices rebuilds at each model\'s cache-write rate and reports the typical starting size', () => {
  const result = analyzeXray({ sessions: {} }, {
    pricing,
    audit: {
      events: [
        { t: 0, kind: 'expired', model: 'claude-opus-4', tokens: 200_000, oneHour: true },
        { t: 1, kind: 'unexplained', model: 'claude-sonnet-4', tokens: 100_000 },
        { t: 2, kind: 'unexplained', model: 'claude-opus-9', tokens: 100_000 }
      ],
      startContexts: [65_000, 20_000, 90_000]
    }
  });

  assert.equal(result.rebuilds.count, 3);
  assert.equal(result.rebuilds.expired.count, 1);
  assert.equal(result.rebuilds.unexplained.count, 2);
  assert.equal(result.rebuilds.modelSwitch.count, 0);
  assert.ok(Math.abs(result.rebuilds.costUsd - (200_000 * 10e-6 + 100_000 * 3.75e-6)) < 1e-9);
  assert.equal(result.rebuilds.startContextTokens, 65_000);
  assert.deepEqual(result.skippedModels, ['claude-opus-9']);
});

test('heavy-session watch speaks once per active heavy session', () => {
  const watch = createHeavySessionWatch({ minContext: 150_000, activeWithinMs: 5 * MIN });
  const now = Date.parse('2026-10-01T12:00:00Z');
  const s = (id, context, minutesAgo) => ({ client: 'claude', sessionId: id, contextTokens: context, lastUsedAt: new Date(now - minutesAgo * MIN).toISOString() });

  assert.equal(watch(s('light', 90_000, 0), now), false);
  assert.equal(watch(s('idle', 400_000, 30), now), false, 'heavy but idle for 30 minutes');
  assert.equal(watch(s('heavy', 180_000, 1), now), true);
  assert.equal(watch(s('heavy', 220_000, 0), now + MIN), false, 'already told');
  assert.equal(watch({ client: 'codex', sessionId: 'x', contextTokens: 0, lastUsedAt: '' }, now), false);
});
