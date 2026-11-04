import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { statusCommand } from '../../src/statusline/setup.ts';
import { FIVE_MINUTE_LOG } from '../helpers.ts';

const MAIN = join(import.meta.dirname, '..', '..', 'src', 'cli', 'main.ts');
const cli = (args: string[], input: string, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [MAIN, ...args], { input, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env } });

test('tokenxray statusline prints one line from stdin', () => {
  const result = cli(['statusline'], JSON.stringify({ transcript_path: FIVE_MINUTE_LOG }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'cache expired · 592k ctx\n'); // the fixture is from September
});

test('tokenxray setup asks first and writes CLAUDE_CONFIG_DIR/settings.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenxray-'));
  const declined = cli(['setup'], '', { CLAUDE_CONFIG_DIR: dir });
  assert.equal(declined.status, 0);
  assert.deepEqual(await readdir(dir), []); // stdin closed without an answer: nothing changes
  const accepted = cli(['setup'], 'y\n', { CLAUDE_CONFIG_DIR: dir });
  assert.equal(accepted.status, 0);
  assert.match(accepted.stdout, /Apply this change\? \[y\/N\]/);
  const { statusLine } = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
  assert.equal(statusLine.command, statusCommand(process.execPath, MAIN));
});

test('an unknown command explains the usage', () => {
  const result = cli(['stauts'], '');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown command "stauts"/);
});
