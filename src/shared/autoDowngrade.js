'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Claude Code reads its default model from the "model" key of ~/.claude/settings.json,
// so switching that key only changes sessions started afterwards.
const CHEAPER_MODEL = 'sonnet';
const DEFAULT_THRESHOLD = 80;
const ALREADY_CHEAP = /sonnet|haiku/i;

// Highest used percent across Claude's quota windows (5-hour session and weekly).
function claudePeakUsage(limits) {
  let peak = null;
  for (const provider of limits?.providers || []) {
    if (provider?.provider !== 'claude') continue;
    for (const window of provider.windows || []) {
      const used = Number(window?.usedPercent);
      if (Number.isFinite(used) && (!peak || used > peak.usedPercent)) {
        peak = { usedPercent: used, kind: window.kind, resetsAt: window.resetsAt };
      }
    }
  }
  return peak;
}

function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} is not a JSON object`);
  return value;
}

// Write a sibling temp file and rename it over the target, so a crash mid-write
// never leaves Claude Code with a half-written settings file.
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch (_) {}
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function clearState(statePath) {
  fs.rmSync(statePath, { force: true });
}

// One check: downgrade when Claude usage reaches `threshold`, restore once it drops
// back (the window reset) or the feature is turned off. Returns { action } where
// action is 'downgraded', 'restored', 'released' (user changed the model meanwhile,
// so it is left alone), 'error' or null.
function runAutoDowngrade({ limits, threshold = DEFAULT_THRESHOLD, enabled = true, settingsPath, statePath, now = Date.now() }) {
  try {
    const state = readJson(statePath, null);
    const peak = claudePeakUsage(limits);

    if (state?.active) {
      const resetPassed = Date.parse(state.resetsAt || '') <= now;
      const shouldRestore = !enabled || (peak ? peak.usedPercent < threshold : resetPassed);
      if (!shouldRestore) return { action: null, peak };
      const settings = readJson(settingsPath, {});
      clearState(statePath);
      if (settings.model !== CHEAPER_MODEL) return { action: 'released', peak };
      if (state.previousModel == null) delete settings.model;
      else settings.model = state.previousModel;
      writeJsonAtomic(settingsPath, settings);
      return { action: 'restored', model: state.previousModel ?? null, peak };
    }

    if (!enabled || !peak || peak.usedPercent < threshold) return { action: null, peak };
    const settings = readJson(settingsPath, {});
    if (typeof settings.model === 'string' && ALREADY_CHEAP.test(settings.model)) return { action: null, peak };
    const previousModel = typeof settings.model === 'string' ? settings.model : null;
    // State first: if the settings write then fails, the next check just releases.
    writeJsonAtomic(statePath, { active: true, previousModel, resetsAt: peak.resetsAt || null, since: new Date(now).toISOString() });
    writeJsonAtomic(settingsPath, { ...settings, model: CHEAPER_MODEL });
    return { action: 'downgraded', previousModel, peak };
  } catch (error) {
    return { action: 'error', error: error.message };
  }
}

module.exports = { CHEAPER_MODEL, DEFAULT_THRESHOLD, claudePeakUsage, runAutoDowngrade };
