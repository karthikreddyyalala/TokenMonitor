import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadChats } from '../../src/engine/logs.ts';
import { analyze, xray } from '../../src/engine/xray.ts';
import { FIXTURES, PROJECTS } from '../helpers.ts';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const ALL_TIME = [0, Date.parse('2030-01-01')] as const;

test('totals across every fixture chat', async () => {
  const report = analyze(await loadChats(PROJECTS), ...ALL_TIME);
  assert.equal(report.chats, 5);
  assert.equal(report.turns, 9);
  assert.equal(report.unpricedTurns, 0);
  assert.deepEqual(report.tokens, { cacheRead: 1_120_288, cacheWrite: 591_730, output: 6745, input: 18 });
  close(report.totalCost, 4.0702127);
  close(report.cost.cacheRead, 0.1955667);
});

test('reloads are counted by cause and the worst comes first', async () => {
  const { reloads } = analyze(await loadChats(PROJECTS), ...ALL_TIME);
  assert.equal(reloads.count, 2);
  close(reloads.cost, 2.587432);
  assert.deepEqual(reloads.worst.map((r) => [r.kind, r.title, r.project]), [
    ['modelSwitch', 'Fixture chat', 'professordm'],
    ['expired', null, 'home'],
  ]);
  assert.equal(reloads.byKind.unexplained.count, 0);
});

test('heaviest chats are sorted by cost', async () => {
  const { heaviest } = analyze(await loadChats(PROJECTS), ...ALL_TIME);
  assert.deepEqual(heaviest.map((c) => c.chatId.slice(0, 8)), ['8ec33eea', '401e8b1d', '1eb4e9bd', 'aeb2a777', '9139fb89']);
  assert.equal(heaviest[1].peakContext, 728_519);
});

test('turns outside the range are left out', async () => {
  const report = analyze(await loadChats(PROJECTS), Date.parse('2026-10-16'), Date.parse('2026-10-21'));
  assert.equal(report.chats, 1); // only the home chat falls between Oct 16 and Oct 21
  assert.equal(report.turns, 3);
  assert.equal(report.reloads.count, 1);
});

test('xray reads <dir>/projects for the last N days', async () => {
  const report = await xray({ days: 30, now: Date.parse('2026-11-03T12:00:00Z'), dir: FIXTURES });
  assert.equal(report.turns, 9);
});
