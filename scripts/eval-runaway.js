#!/usr/bin/env node
'use strict';

// Replays your real Claude Code logs through the runaway detector, then injects
// synthetic runaways (a rate spike and a repeating loop) to measure recall.
// Usage: node scripts/eval-runaway.js [~/.claude/projects]
// Reads token counts and timestamps only; prints no prompts or file names.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunawayDetector, robustStats } = require('../src/shared/runawayDetector');

const MIN = 60_000;
const root = process.argv[2] || path.join(os.homedir(), '.claude', 'projects');

function loadEvents() {
  const events = [];
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full).filter((f) => f.endsWith('.jsonl'))) {
      const key = `${dir}/${file}`;
      for (const line of fs.readFileSync(path.join(full, file), 'utf8').split('\n')) {
        if (!line.includes('"usage"')) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const usage = row?.message?.usage;
        const t = Date.parse(row?.timestamp);
        if (row?.type !== 'assistant' || !usage || !Number.isFinite(t)) continue;
        const fresh = (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0);
        events.push({ key, t, fresh });
      }
    }
  }
  return events.sort((a, b) => a.t - b.t);
}

function replay(detector, events) {
  const totals = new Map();
  const alerts = [];
  for (const { key, t, fresh } of events) {
    const total = totals.get(key) || { freshTokens: 0, turns: 0 };
    total.freshTokens += fresh;
    total.turns += 1;
    totals.set(key, total);
    const alert = detector.observe({ key, label: key, t, ...total });
    if (alert) alerts.push({ ...alert, t });
  }
  return alerts;
}

// Turns a per-minute plan [[tokens, turns], ...] into turn events starting at `start`.
function synth(key, start, plan) {
  const events = [{ key, t: start, fresh: 0 }];
  plan.forEach(([tokens, turns], m) => {
    for (let i = 0; i < turns; i += 1) events.push({ key, t: start + (m + 1) * MIN - (turns - i) * 5_000, fresh: tokens / turns });
  });
  events.push({ key, t: start + (plan.length + 1) * MIN + 1, fresh: 0 });
  return events;
}

const events = loadEvents();
if (!events.length) {
  console.log(`No Claude Code usage found under ${root}`);
  process.exit(0);
}

const detector = createRunawayDetector();
const realAlerts = replay(detector, events);
const sessions = new Set(events.map((e) => e.key)).size;
const minuteRates = new Map();
for (const e of events) {
  const k = `${e.key}|${Math.floor(e.t / MIN)}`;
  minuteRates.set(k, (minuteRates.get(k) || 0) + e.fresh);
}
const { median } = robustStats([...minuteRates.values()].filter((v) => v > 0));

// Injected cases start after your real history so they see the learned baseline.
let start = Math.ceil(events.at(-1).t / MIN) * MIN + 60 * MIN;
const cases = [];
for (let i = 0; i < 20; i += 1) {
  const warm = Array.from({ length: 5 }, (_, m) => [Math.round(median * (0.5 + ((i + m) % 3) * 0.4)), 1 + (m % 2)]);
  const spikeMul = 6 + (i % 5) * 2;
  cases.push({ kind: 'rate', size: spikeMul, events: synth(`rate-${i}`, start, [...warm, ...Array.from({ length: 10 }, (_, m) => [Math.round(median * spikeMul * (0.9 + (m % 3) * 0.1)), 3 + (m % 3)])]) });
  start += 120 * MIN;
  const turn = Math.round(median * (1 + (i % 4) * 0.5));
  cases.push({ kind: 'loop', events: synth(`loop-${i}`, start, [...warm, ...Array.from({ length: 12 }, () => [turn * 3, 3])]) });
  start += 120 * MIN;
}

const caught = { rate: [], loop: [] };
const bySize = new Map();
for (const c of cases) {
  const alerts = replay(detector, c.events);
  const injectedAt = c.events[0].t + 5 * MIN;
  const hit = alerts.find((a) => a.t >= injectedAt);
  if (hit) caught[c.kind].push((hit.t - injectedAt) / MIN);
  if (c.kind === 'rate') {
    const row = bySize.get(c.size) || { hit: 0, total: 0 };
    row.total += 1;
    if (hit) row.hit += 1;
    bySize.set(c.size, row);
  }
}

const days = (events.at(-1).t - events[0].t) / (24 * 60 * MIN);
const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`;
const avg = (list) => (list.length ? (list.reduce((a, b) => a + b, 0) / list.length).toFixed(1) : '-');
const injectedTotal = cases.length;
const injectedCaught = caught.rate.length + caught.loop.length;
// Every alert on real history is counted as false, the strictest reading.
const precision = injectedCaught / (injectedCaught + realAlerts.length);

console.log(`Real history: ${sessions} sessions, ${events.length} turns over ${days.toFixed(1)} days`);
console.log(`Your usual pace: ${Math.round(median).toLocaleString()} fresh tokens per active minute`);
console.log(`Alerts on real history: ${realAlerts.length} (${(realAlerts.length / Math.max(days, 1)).toFixed(2)} per day)`);
console.log(`Recall, rate spikes: ${caught.rate.length}/${injectedTotal / 2} (${pct(caught.rate.length, injectedTotal / 2)}), avg ${avg(caught.rate)} min to alert`);
for (const [size, row] of [...bySize].sort((a, b) => a[0] - b[0])) console.log(`  ${size}x your usual pace: ${row.hit}/${row.total}`);
console.log(`Recall, loops:       ${caught.loop.length}/${injectedTotal / 2} (${pct(caught.loop.length, injectedTotal / 2)}), avg ${avg(caught.loop)} min to alert`);
console.log(`Precision (real alerts counted as false): ${pct(injectedCaught, injectedCaught + realAlerts.length)}`);
if (precision < 1) for (const a of realAlerts) console.log(`  real alert: ${a.reason}, ${a.ratio.toFixed(1)}x, ${a.tokensPerMinute.toLocaleString()} tokens/min at ${new Date(a.t).toISOString()}`);
