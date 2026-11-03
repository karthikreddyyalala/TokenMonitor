'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRunawayDetector, robustStats } = require('../../src/shared/runawayDetector');

const MIN = 60_000;

// Feeds one cumulative sample per minute: perMinute[i] = [freshTokens, turns] added that minute.
function feed(detector, key, perMinute, startMinute = 0) {
  const alerts = [];
  let tokens = 0;
  let turns = 0;
  detector.observe({ key, label: key, t: startMinute * MIN, freshTokens: 0, turns: 0 });
  perMinute.forEach(([addTokens, addTurns], i) => {
    tokens += addTokens;
    turns += addTurns;
    const alert = detector.observe({ key, label: key, t: (startMinute + i + 1) * MIN + 1, freshTokens: tokens, turns });
    if (alert) alerts.push({ ...alert, minute: i + 1 });
  });
  return alerts;
}

// Normal human-paced work: uneven bursts with idle minutes in between.
function normalSession(minutes, seed = 1) {
  let x = seed;
  const rand = () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
  return Array.from({ length: minutes }, () => (rand() < 0.35 ? [0, 0] : [Math.round(1500 + rand() * 6000), 1 + Math.floor(rand() * 3)]));
}

function warmedUp() {
  const detector = createRunawayDetector();
  for (let s = 0; s < 6; s += 1) feed(detector, `warm-${s}`, normalSession(40, s + 7), s * 100);
  return detector;
}

test('robustStats returns median and MAD', () => {
  assert.deepEqual(robustStats([1, 2, 3, 4, 100]), { median: 3, mad: 1 });
  assert.deepEqual(robustStats([]), { median: 0, mad: 0 });
});

test('normal sessions never alert', () => {
  const detector = warmedUp();
  for (let s = 0; s < 10; s += 1) {
    assert.deepEqual(feed(detector, `normal-${s}`, normalSession(60, s + 101), 1000 + s * 100), []);
  }
});

test('a sustained spike far above your usual pace alerts once, with the ratio', () => {
  const detector = warmedUp();
  const spike = [...normalSession(10, 3), ...Array.from({ length: 12 }, () => [60_000, 4])];
  const alerts = feed(detector, 'runaway', spike, 5000);

  assert.equal(alerts.length, 1, 'cooldown keeps it to one alert');
  assert.equal(alerts[0].reason, 'rate');
  assert.ok(alerts[0].minute <= 14, `caught within 4 minutes, got minute ${alerts[0].minute}`);
  assert.ok(alerts[0].ratio >= 5);
});

test('a one-minute burst is not a runaway', () => {
  const detector = warmedUp();
  const burst = [...normalSession(10, 4), [80_000, 3], ...normalSession(10, 5)];
  assert.deepEqual(feed(detector, 'burst', burst, 6000), []);
});

test('near-identical turns repeating for minutes look like a loop', () => {
  const detector = warmedUp();
  const loop = [...normalSession(5, 9), ...Array.from({ length: 10 }, () => [12_000, 3])];
  const alerts = feed(detector, 'loop', loop, 7000);

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].reason, 'loop');
});

test('stays quiet until it has learned a baseline', () => {
  const detector = createRunawayDetector();
  assert.deepEqual(feed(detector, 'first', Array.from({ length: 12 }, () => [60_000, 4])), []);
});

test('a counter that goes backwards (new day, reset) is treated as a fresh start', () => {
  const detector = warmedUp();
  detector.observe({ key: 'reset', label: 'reset', t: 9000 * MIN, freshTokens: 500_000, turns: 90 });
  const alert = detector.observe({ key: 'reset', label: 'reset', t: 9001 * MIN + 1, freshTokens: 2_000, turns: 1 });
  assert.equal(alert, null);
});
