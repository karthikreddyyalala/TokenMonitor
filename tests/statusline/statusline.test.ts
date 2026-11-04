import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { renderStatus, runStatusline } from '../../src/statusline/statusline.ts';
import { FIVE_MINUTE_LOG, STATUS_INPUT } from '../helpers.ts';

const MINUTE = 60_000;
const state = { expiresAt: 100 * MINUTE, context: 216_000 };
const at = (minutesLeft: number) => state.expiresAt - minutesLeft * MINUTE;

test('the countdown in whole minutes, rounded up', () => {
  assert.equal(renderStatus(state, at(42), false), 'cache 42m · 216k ctx');
  assert.equal(renderStatus(state, at(0.5), false), 'cache 1m · 216k ctx');
  assert.equal(renderStatus(state, at(0), false), 'cache expired · 216k ctx');
  assert.equal(renderStatus(null, at(42), false), '');
});

test('amber under 10 minutes, red under 5 and after', () => {
  const AMBER = '\x1b[33m';
  const RED = '\x1b[31m';
  const ten = renderStatus(state, at(10), true);
  assert.ok(!ten.includes(AMBER) && !ten.includes(RED));
  assert.ok(renderStatus(state, at(9), true).startsWith(`${AMBER}cache 9m`));
  assert.ok(renderStatus(state, at(4), true).startsWith(`${RED}cache 4m`));
  assert.ok(renderStatus(state, at(-1), true).startsWith(`${RED}cache expired`));
});

test('runStatusline reads Claude Code stdin and never throws', async () => {
  const docs = await readFile(STATUS_INPUT, 'utf8');
  assert.equal(await runStatusline(docs, 1738429200 * 1000 - 42 * MINUTE, false), 'cache 42m · 16k ctx');
  const old = JSON.stringify({ transcript_path: FIVE_MINUTE_LOG });
  assert.equal(await runStatusline(old, Date.parse('2026-09-21T18:05:43.006Z'), false), 'cache 2m · 592k ctx');
  assert.equal(await runStatusline('not json', 0, false), '');
  assert.equal(await runStatusline('null', 0, false), '');
  assert.equal(await runStatusline(JSON.stringify({ transcript_path: '/no/such/file.jsonl' }), 0, false), '');
});
