'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const pkg = require(path.join(ROOT, 'package.json'));
const { sharedDataDir } = require(path.join(ROOT, 'src/shared/config.js'));
const { GITHUB_REPO } = require(path.join(ROOT, 'src/shared/appUpdater.js'));
const mainSource = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');

test('app identity belongs to this fork, not the upstream app', () => {
  assert.equal(pkg.productName, 'Token X-ray');
  assert.equal(pkg.build.productName, 'Token X-ray');
  assert.equal(pkg.build.appId, 'io.github.karthikreddyyalala.tokenxray');
});

test('auto-update feed points at this fork in both places', () => {
  assert.equal(GITHUB_REPO, 'karthikreddyyalala/TokenMonitor');
  const [publish] = pkg.build.publish;
  assert.equal(`${publish.owner}/${publish.repo}`, GITHUB_REPO);
});

test('Electron app name, shared data dir and product name agree', () => {
  const appName = mainSource.match(/^const APP_NAME = '([^']+)';$/m)?.[1];
  assert.equal(appName, pkg.productName);
  assert.equal(path.basename(sharedDataDir({ platform: 'darwin', homeDir: '/h', env: {} })), pkg.productName);
  assert.match(mainSource, new RegExp(`setAppUserModelId\\('${pkg.build.appId.replace(/\./g, '\\.')}'\\)`));
});
