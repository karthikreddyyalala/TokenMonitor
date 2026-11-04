import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readLog, type Turn } from '../../src/engine/logs.ts';
import { FIVE_MINUTES, findReloads, ONE_HOUR, tierOf } from '../../src/engine/reloads.ts';
import { COMPACT_CHAT, FIVE_MINUTE_LOG, HOME_CHAT, PURE_READ_LOG, RENAMED_CHAT, SWITCH_CHAT } from '../helpers.ts';

const entriesOf = async (file: string) => (await readLog(file)).entries.sort((a, b) => a.t - b.t);

test('a full rewrite after 78 idle minutes on a 1-hour cache is an expired reload', async () => {
  const reloads = findReloads(await entriesOf(HOME_CHAT));
  assert.equal(reloads.length, 1);
  assert.equal(reloads[0].kind, 'expired');
  assert.equal(reloads[0].tokens, 72140);
  assert.equal(reloads[0].gapMs, 4_671_091);
});

test('the same rewrite inside the cache lifetime is unexplained', async () => {
  const entries = await entriesOf(HOME_CHAT);
  const [, previous, reload] = entries as Turn[];
  const sooner = entries.map((e) => (e === reload ? { ...reload, t: previous.t + 30 * 60_000 } : e));
  assert.equal(findReloads(sooner)[0].kind, 'unexplained');
});

test('a full rewrite right after switching model is a model-switch reload', async () => {
  const reloads = findReloads(await entriesOf(SWITCH_CHAT));
  assert.deepEqual(reloads.map((r) => [r.kind, r.tokens, r.gapMs]), [['modelSwitch', 287359, null]]);
});

test('switching model after the cache already expired counts as expired, not model switch', async () => {
  const entries = await entriesOf(SWITCH_CHAT);
  const [previous, reload] = entries.filter((e): e is Turn => e.kind === 'turn');
  const dayLater = entries.map((e) => (e === reload ? { ...reload, t: previous.t + 27 * 3_600_000 } : e));
  assert.deepEqual(findReloads(dayLater).map((r) => [r.kind, r.gapMs]), [['expired', 27 * 3_600_000]]);
});

test('a rewrite right after /compact is expected, even with a new model', async () => {
  assert.deepEqual(findReloads(await entriesOf(COMPACT_CHAT)), []);
});

test('the first turn of a chat is never a reload', async () => {
  assert.deepEqual(findReloads(await entriesOf(RENAMED_CHAT)), []);
});

test('tierOf: a cache write states its tier, a pure read does not', async () => {
  const [write, read] = (await readLog(PURE_READ_LOG)).entries as Turn[];
  assert.equal(tierOf(write), ONE_HOUR);
  assert.equal(tierOf(read), null);
  const [five] = (await readLog(FIVE_MINUTE_LOG)).entries as Turn[];
  assert.equal(tierOf(five), FIVE_MINUTES);
});
