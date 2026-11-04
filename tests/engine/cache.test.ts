import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cacheFromEntries, cacheFromLog, cacheFromStatus, liveCache, type StatusInput } from '../../src/engine/cache.ts';
import { readLog } from '../../src/engine/logs.ts';
import { COMPACT_CHAT, FIVE_MINUTE_LOG, PURE_READ_LOG, STATUS_INPUT, SUBAGENT_LOG } from '../helpers.ts';

const MINUTE = 60_000;
const statusInput = async (): Promise<StatusInput> => JSON.parse(await readFile(STATUS_INPUT, 'utf8'));

test('a 5-minute write logged three times expires 5 minutes after its first copy', async () => {
  assert.deepEqual(await cacheFromLog(FIVE_MINUTE_LOG), {
    expiresAt: Date.parse('2026-09-21T18:02:43.006Z') + 5 * MINUTE,
    context: 2 + 304 + 592020,
  });
});

test('a pure cache read refreshes the cache on the tier written before it', async () => {
  const expected = { expiresAt: Date.parse('2026-09-24T18:46:57.161Z') + 60 * MINUTE, context: 4 + 556340 };
  assert.deepEqual(await cacheFromLog(PURE_READ_LOG), expected);
  // A window too small for the earlier write has to grow until it finds it.
  assert.deepEqual(await cacheFromLog(PURE_READ_LOG, 200), expected);
});

test('cacheFromEntries asks for more of the log only when the end cannot tell', async () => {
  const [write, read] = (await readLog(PURE_READ_LOG)).entries;
  assert.equal(cacheFromEntries([read], false), undefined); // tier unknown yet
  assert.equal(cacheFromEntries([], false), undefined);
  assert.equal(cacheFromEntries([], true), null);
  assert.deepEqual(cacheFromEntries([read], true), cacheFromEntries([write, read], false)); // whole log: 1 hour default
});

test('after /compact there is no cache until the next response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenxray-'));
  const lines = (await readFile(COMPACT_CHAT, 'utf8')).trim().split('\n');
  const beforeNextResponse = join(dir, 'chat.jsonl');
  await writeFile(beforeNextResponse, `${lines.slice(0, 3).join('\n')}\n`); // the log as it was right after /compact
  assert.equal(await cacheFromLog(beforeNextResponse), null);
  assert.deepEqual(await cacheFromLog(COMPACT_CHAT), {
    expiresAt: Date.parse('2026-10-29T22:45:12.758Z') + 60 * MINUTE,
    context: 2 + 94898,
  });
});

test('subagent turns do not count: they have their own cache', async () => {
  assert.equal(await cacheFromLog(SUBAGENT_LOG), null);
});

test('Claude Code 2.1.251+ states the expiry on stdin', async () => {
  const input = await statusInput();
  assert.deepEqual(cacheFromStatus(input), { expiresAt: 1738429200 * 1000, context: 8500 + 5000 + 2000 });
  assert.equal(cacheFromStatus({ ...input, prompt_cache: { ...input.prompt_cache, expires_at: null } }), null);
  assert.equal(cacheFromStatus({ transcript_path: '/x.jsonl' }), undefined); // older versions
  assert.equal(cacheFromStatus({ ...input, prompt_cache: { expires_at: 'soon' as unknown as number } }), null); // never "cache NaNm"
  assert.equal(cacheFromStatus({ ...input, context_window: { current_usage: null } }), undefined); // right after /compact
});

test('liveCache falls back to the log when stdin has no expiry', async () => {
  assert.deepEqual(await liveCache({ transcript_path: FIVE_MINUTE_LOG }), await cacheFromLog(FIVE_MINUTE_LOG));
  assert.equal(await liveCache({}), null);
});
