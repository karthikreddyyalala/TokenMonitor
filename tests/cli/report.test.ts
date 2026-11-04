import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { loadChats } from '../../src/engine/logs.ts';
import { analyze } from '../../src/engine/xray.ts';
import { barCells, duration, money, renderReport, tokens } from '../../src/cli/report.ts';
import { FIXTURES, PROJECTS } from '../helpers.ts';

const run = promisify(execFile);
const MAIN = join(import.meta.dirname, '..', '..', 'src', 'cli', 'main.ts');
const cli = (args: string[], env: Record<string, string> = {}) =>
  run(process.execPath, [MAIN, ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: FIXTURES, ...env } });

test('number formats', () => {
  assert.equal(money(1234.5), '$1,234.50');
  assert.equal(money(0.004), '<$0.01');
  assert.equal(money(0), '$0.00');
  assert.equal(tokens(950), '950');
  assert.equal(tokens(72_140), '72k');
  assert.equal(tokens(1_250_000), '1.3M');
  assert.equal(duration(78 * 60_000), '1h18m');
  assert.equal(duration(404 * 3_600_000), '17d');
});

test('the bar always fills exactly 48 cells', () => {
  for (const values of [[1, 1, 1], [47, 35, 18, 0], [0.2, 3.77, 0.11, 0.00005]]) {
    assert.equal(barCells(values).reduce((a, b) => a + b, 0), 48);
  }
  assert.deepEqual(barCells([0, 0]), [0, 0]);
});

test('report leads with the re-reading share and shows reloads and heavy chats', async () => {
  const report = analyze(await loadChats(PROJECTS), 0, Date.parse('2030-01-01'));
  const text = renderReport(report, { color: false, days: 30, timeZone: 'UTC' });
  assert.match(text, /5% of your spend went to re-reading old context\./);
  assert.match(text, /\$4\.07 at API prices/);
  assert.match(text, /Cache reloads {2}2 · \$2\.59 · 64% of spend/);
  assert.match(text, /Oct 15, 17:36 +287k +\$2\.30 +model switch +Fixture chat · professordm/);
  assert.match(text, /idle 1h18m +untitled chat · home/);
  assert.ok(!text.includes('\x1b['), 'no colour codes when colour is off');
});

test('cli --json prints the engine report', async () => {
  const { stdout } = await cli(['--days', '3650', '--json']);
  assert.equal(JSON.parse(stdout).turns, 9);
});

test('cli rejects a bad --days with exit code 2', async () => {
  await assert.rejects(cli(['--days', 'abc']), (error: { code: number; stderr: string }) =>
    error.code === 2 && /whole number of days/.test(error.stderr));
});

test('cli explains what to do when there are no logs', async () => {
  const { stdout } = await cli([], { CLAUDE_CONFIG_DIR: join(FIXTURES, 'empty') });
  assert.match(stdout, /No Claude Code usage in the last 30 days/);
});
