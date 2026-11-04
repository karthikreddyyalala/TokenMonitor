import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readLog, type Turn } from '../../src/engine/logs.ts';
import { splitTotal, turnCost } from '../../src/engine/spend.ts';
import { HOME_CHAT, SUBAGENT_LOG } from '../helpers.ts';

const firstTurn = async (file: string) => (await readLog(file)).entries.find((e): e is Turn => e.kind === 'turn')!;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('a 1-hour cache write is priced at the 1-hour rate (Sonnet 5: $4/M)', async () => {
  const cost = turnCost(await firstTurn(HOME_CHAT))!;
  close(cost.cacheWrite, 30828 * 4e-6);
  close(cost.output, 410 * 10e-6);
  close(cost.input, 2 * 2e-6);
  close(cost.cacheRead, 0);
  close(splitTotal(cost), 0.127416);
});

test('a 5-minute cache write is priced at the 5-minute rate (Opus 5.5: $5/M)', async () => {
  const cost = turnCost(await firstTurn(SUBAGENT_LOG))!;
  close(cost.cacheWrite, 53804 * 5e-6);
});

test('a model without a price costs null, not zero', async () => {
  const turn = await firstTurn(HOME_CHAT);
  assert.equal(turnCost({ ...turn, model: 'claude-unreleased-9' }), null);
});
