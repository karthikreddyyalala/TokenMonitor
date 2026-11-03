'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { claudePeakUsage, runAutoDowngrade } = require('../../src/shared/autoDowngrade');

function limits(session, weekly) {
  return {
    providers: [
      { provider: 'codex', windows: [{ kind: 'session', usedPercent: 99 }] },
      { provider: 'claude', windows: [
        { kind: 'session', usedPercent: session, resetsAt: '2026-11-02T18:00:00Z' },
        { kind: 'weekly', usedPercent: weekly, resetsAt: '2026-11-06T09:00:00Z' }
      ] }
    ]
  };
}

function sandbox(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-downgrade-'));
  const settingsPath = path.join(dir, 'settings.json');
  if (settings !== undefined) fs.writeFileSync(settingsPath, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  return { settingsPath, statePath: path.join(dir, 'state.json'), read: () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
}

test('peak usage is the highest Claude window and ignores other providers', () => {
  assert.deepEqual(claudePeakUsage(limits(40, 83)), { usedPercent: 83, kind: 'weekly', resetsAt: '2026-11-06T09:00:00Z' });
  assert.equal(claudePeakUsage({ providers: [] }), null);
  assert.equal(claudePeakUsage(undefined), null);
});

test('switches to Sonnet at 80% and keeps every other setting', () => {
  const box = sandbox({ model: 'opus', permissions: { allow: ['Bash(ls)'] }, theme: 'dark' });
  const result = runAutoDowngrade({ limits: limits(20, 80), threshold: 80, ...box });

  assert.equal(result.action, 'downgraded');
  assert.deepEqual(box.read(), { model: 'sonnet', permissions: { allow: ['Bash(ls)'] }, theme: 'dark' });
  // Nothing changes on the next check while usage stays high.
  assert.equal(runAutoDowngrade({ limits: limits(20, 91), threshold: 80, ...box }).action, null);
});

test('restores the original model after the limit resets', () => {
  const box = sandbox({ model: 'opus' });
  runAutoDowngrade({ limits: limits(85, 10), threshold: 80, ...box });
  const result = runAutoDowngrade({ limits: limits(2, 10), threshold: 80, ...box });

  assert.equal(result.action, 'restored');
  assert.deepEqual(box.read(), { model: 'opus' });
});

test('restores "no model set" by removing the key it added', () => {
  const box = sandbox({ theme: 'dark' });
  runAutoDowngrade({ limits: limits(90, 0), threshold: 80, ...box });
  assert.equal(box.read().model, 'sonnet');
  runAutoDowngrade({ limits: limits(0, 0), threshold: 80, ...box });
  assert.deepEqual(box.read(), { theme: 'dark' });
});

test('respects a model the user picked while downgraded', () => {
  const box = sandbox({ model: 'opus' });
  runAutoDowngrade({ limits: limits(90, 0), threshold: 80, ...box });
  fs.writeFileSync(box.settingsPath, JSON.stringify({ model: 'haiku' }));
  const result = runAutoDowngrade({ limits: limits(0, 0), threshold: 80, ...box });

  assert.equal(result.action, 'released');
  assert.deepEqual(box.read(), { model: 'haiku' });
});

test('does nothing when the user already runs Sonnet', () => {
  const box = sandbox({ model: 'claude-sonnet-4-6' });
  assert.equal(runAutoDowngrade({ limits: limits(95, 0), threshold: 80, ...box }).action, null);
  assert.deepEqual(box.read(), { model: 'claude-sonnet-4-6' });
});

test('never overwrites a settings file it cannot parse', () => {
  const box = sandbox('{ "model": "opus", broken');
  const result = runAutoDowngrade({ limits: limits(95, 0), threshold: 80, ...box });

  assert.equal(result.action, 'error');
  assert.equal(fs.readFileSync(box.settingsPath, 'utf8'), '{ "model": "opus", broken');
});

test('creates the settings file when Claude Code has none yet', () => {
  const box = sandbox(undefined);
  runAutoDowngrade({ limits: limits(95, 0), threshold: 80, ...box });
  assert.deepEqual(box.read(), { model: 'sonnet' });
  runAutoDowngrade({ limits: limits(0, 0), threshold: 80, ...box });
  assert.deepEqual(box.read(), {});
});

test('turning the feature off restores right away', () => {
  const box = sandbox({ model: 'opus' });
  runAutoDowngrade({ limits: limits(95, 0), threshold: 80, ...box });
  const result = runAutoDowngrade({ limits: limits(95, 0), threshold: 80, enabled: false, ...box });

  assert.equal(result.action, 'restored');
  assert.deepEqual(box.read(), { model: 'opus' });
});

test('no limits data means no change', () => {
  const box = sandbox({ model: 'opus' });
  assert.equal(runAutoDowngrade({ limits: null, threshold: 80, ...box }).action, null);
  assert.deepEqual(box.read(), { model: 'opus' });
});
