import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { describeChange, planSetup, runSetup, statusCommand } from '../../src/statusline/setup.ts';

const COMMAND = statusCommand('/usr/local/bin/node', '/opt/tokenxray/dist/cli/main.js');
const tempDir = () => mkdtemp(join(tmpdir(), 'tokenxray-'));
const quiet = () => {};

test('statusCommand quotes absolute paths', () => {
  assert.equal(COMMAND, '"/usr/local/bin/node" "/opt/tokenxray/dist/cli/main.js" statusline');
});

test('planSetup adds the status line and keeps every other setting', () => {
  const plan = planSetup('{"model":"opus","env":{"A":"1"}}', COMMAND);
  assert.equal(plan.kind, 'change');
  assert.deepEqual(JSON.parse(plan.kind === 'change' ? plan.text : ''), {
    model: 'opus',
    env: { A: '1' },
    statusLine: { type: 'command', command: COMMAND, refreshInterval: 30 },
  });
  assert.equal(planSetup(null, COMMAND).kind, 'change'); // no settings file yet
  assert.equal(planSetup('', COMMAND).kind, 'change');
});

test('planSetup replaces another status line but keeps its padding', () => {
  const plan = planSetup('{"statusLine":{"type":"command","command":"~/bar.sh","padding":2}}', COMMAND);
  assert.equal(plan.kind, 'change');
  if (plan.kind !== 'change') return;
  assert.deepEqual(plan.after, { type: 'command', command: COMMAND, padding: 2, refreshInterval: 30 });
  const diff = describeChange('settings.json', plan);
  assert.ok(diff.includes('\n-   "command": "~/bar.sh",\n'));
  assert.ok(diff.includes('\n+   "refreshInterval": 30\n'));
});

test('planSetup refuses files it cannot parse and notices when nothing would change', () => {
  assert.equal(planSetup('{"model": "opus",}', COMMAND).kind, 'unreadable');
  assert.equal(planSetup('[]', COMMAND).kind, 'unreadable');
  const done = planSetup(null, COMMAND);
  assert.equal(planSetup(done.kind === 'change' ? done.text : '', COMMAND).kind, 'done');
});

test('runSetup writes only after a yes, and backs up the old file', async () => {
  const dir = await tempDir();
  const file = join(dir, 'settings.json');
  await writeFile(file, '{"model":"opus"}');
  assert.equal(await runSetup(file, COMMAND, async () => 'n', quiet), 0);
  assert.equal(await readFile(file, 'utf8'), '{"model":"opus"}');
  assert.equal(await runSetup(file, COMMAND, async () => 'y', quiet), 0);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).statusLine.command, COMMAND);
  const backups = (await readdir(dir)).filter((name) => name.startsWith('settings.json.backup-'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(dir, backups[0]), 'utf8'), '{"model":"opus"}');
});

test('runSetup creates settings.json when there is none, and leaves broken JSON alone', async () => {
  const dir = await tempDir();
  const file = join(dir, 'new', 'settings.json');
  assert.equal(await runSetup(file, COMMAND, async () => 'yes', quiet), 0);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).statusLine.refreshInterval, 30);
  const broken = join(dir, 'broken.json');
  await writeFile(broken, '{ nope');
  assert.equal(await runSetup(broken, COMMAND, async () => 'y', quiet), 1);
  assert.equal(await readFile(broken, 'utf8'), '{ nope');
});
