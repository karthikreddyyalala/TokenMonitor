'use strict';

// Token X-ray: where a period's spend actually went.
//
// Coding agents re-send the whole conversation on every turn, so most of the
// bill is the model re-reading context it has already seen. analyzeXray splits
// the app's own session totals (any client that reports cache tokens) into
// re-reading, cache loads, writing and new input, each at its model's price.
//
// For Claude Code it also audits the transcripts for full cache rebuilds: a turn
// that writes most of its context to the cache again instead of reading it.
// Those happen when the cache expired while idle, when the model changed, or
// with no visible reason at all.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { robustStats } = require('./runawayDetector');

const MIN = 60_000;
const PARTS = [
  ['cacheRead', 'cacheReadTokens', 'cacheReadInputTokenCost'],
  ['cacheWrite', 'cacheWriteTokens', 'cacheCreationInputTokenCost'],
  ['output', 'outputTokens', 'outputCostPerToken'],
  ['input', 'inputTokens', 'inputCostPerToken']
];
// A rebuild re-writes at least this share of a context of at least this size.
const REBUILD_SHARE = 0.6;
const REBUILD_MIN_CONTEXT = 20_000;
// A context this much smaller than the last one was compacted, not reloaded.
const COMPACTED_BELOW = 0.7;
const HEAVIEST = 3;

const validRate = (rate) => Number.isFinite(rate) && rate >= 0;
// Claude Code mostly keeps a 1-hour cache, whose writes cost more than the
// base (5-minute) rate. Models without a listed 1-hour rate keep the base one.
const withCacheLifetime = (rates, oneHour) => (oneHour && validRate(rates?.cacheCreation1hInputTokenCost)
  ? { ...rates, cacheCreationInputTokenCost: rates.cacheCreation1hInputTokenCost }
  : rates);

function summarizeRebuilds(audit, pricing, skipped) {
  const kinds = Object.fromEntries(['expired', 'unexplained', 'modelSwitch'].map((k) => [k, { count: 0, tokens: 0, costUsd: 0 }]));
  for (const event of audit.events) {
    const kind = kinds[event.kind];
    const rate = withCacheLifetime(pricing[event.model], event.oneHour)?.cacheCreationInputTokenCost;
    kind.count += 1;
    kind.tokens += event.tokens;
    if (validRate(rate)) kind.costUsd += event.tokens * rate;
    else skipped.add(event.model);
  }
  const all = Object.values(kinds);
  return {
    ...kinds,
    count: all.reduce((a, k) => a + k.count, 0),
    costUsd: all.reduce((a, k) => a + k.costUsd, 0),
    startContextTokens: Math.round(robustStats(audit.startContexts).median)
  };
}

function analyzeXray(period, { pricing = {}, audit = null } = {}) {
  const parts = Object.fromEntries(PARTS.map(([key]) => [key, { tokens: 0, costUsd: 0 }]));
  const skipped = new Set();
  const heaviest = [];
  let sessionCount = 0;

  for (const session of Object.values(period?.sessions || {})) {
    let reReadUsd = 0;
    let priced = false;
    // ponytail: uses the session's last seen cache lifetime; per-turn split if sessions mix 5-minute and 1-hour writes.
    const oneHour = session.promptCache?.ttlSeconds === 3600;
    for (const [model, components] of Object.entries(session.modelTokenComponents || {})) {
      const rates = pricing[model] && withCacheLifetime(pricing[model], oneHour);
      if (!rates || PARTS.some(([, field, rate]) => components[field] > 0 && !validRate(rates[rate]))) {
        skipped.add(model);
        continue;
      }
      priced = true;
      for (const [key, field, rate] of PARTS) {
        const tokens = components[field] || 0;
        if (!tokens) continue;
        parts[key].tokens += tokens;
        parts[key].costUsd += tokens * rates[rate];
      }
      reReadUsd += (components.cacheReadTokens || 0) * (rates.cacheReadInputTokenCost || 0);
    }
    if (!priced) continue;
    sessionCount += 1;
    if (reReadUsd > 0) {
      heaviest.push({ client: session.client, sessionId: session.sessionId, title: session.title, reReadUsd, contextTokens: session.contextTokens || 0 });
    }
  }

  const totalUsd = Object.values(parts).reduce((a, p) => a + p.costUsd, 0);
  for (const part of Object.values(parts)) part.share = totalUsd > 0 ? part.costUsd / totalUsd : 0;
  heaviest.sort((a, b) => b.reReadUsd - a.reReadUsd);
  const rebuilds = audit ? summarizeRebuilds(audit, pricing, skipped) : null;
  return {
    totalUsd,
    sessionCount,
    parts,
    reReadShare: parts.cacheRead.share,
    readPerWritten: parts.output.tokens > 0 ? parts.cacheRead.tokens / parts.output.tokens : 0,
    heaviest: heaviest.slice(0, HEAVIEST),
    rebuilds,
    skippedModels: [...skipped]
  };
}

// Claude Code logs each assistant turn once per content block, all carrying the
// same usage; keeping one line per message id + request id counts it once.
async function readClaudeTurns(file) {
  const turns = [];
  const seen = new Set();
  const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const usage = row?.message?.usage;
    const t = Date.parse(row?.timestamp);
    if (row?.type !== 'assistant' || !usage || !Number.isFinite(t)) continue;
    const id = `${row.message.id}|${row.requestId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    turns.push({
      t,
      model: row.message.model || '',
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheWrite: usage.cache_creation_input_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      oneHourCache: (usage.cache_creation?.ephemeral_1h_input_tokens || 0) > 0,
      sidechain: row.isSidechain === true
    });
  }
  return turns.sort((a, b) => a.t - b.t);
}

// Each turn is compared with the last turn of the same model, because the
// cache is per model: switching away and back within the cache lifetime is free.
function auditClaudeTurns(turns) {
  const rebuilds = [];
  const lastByModel = new Map();
  let minContext = Infinity;
  let startedAt = null;
  for (const x of turns) {
    if (x.sidechain) continue;
    const context = x.input + x.cacheWrite + x.cacheRead;
    if (startedAt === null) startedAt = x.t;
    if (context > 0) minContext = Math.min(minContext, context);
    const otherModelsSeen = lastByModel.size > 0;
    const prev = lastByModel.get(x.model);
    lastByModel.set(x.model, { t: x.t, context });
    if (context < REBUILD_MIN_CONTEXT || x.cacheWrite < REBUILD_SHARE * context) continue;
    let kind;
    if (!prev) {
      if (!otherModelsSeen) continue;
      kind = 'modelSwitch';
    } else if (context < COMPACTED_BELOW * prev.context) {
      continue;
    } else {
      kind = x.t - prev.t > (x.oneHourCache ? 60 : 5) * MIN ? 'expired' : 'unexplained';
    }
    rebuilds.push({ t: x.t, kind, model: x.model, tokens: x.cacheWrite, oneHour: x.oneHourCache });
  }
  return { rebuilds, minContext: Number.isFinite(minContext) ? minContext : 0, startedAt };
}

const defaultAuditCache = new Map();

// Audits every transcript touched since `since`. Results are kept per file and
// reused while its size and mtime are unchanged, so a refresh only re-reads the
// sessions that are still being written. Returns null when Claude Code is absent.
async function auditClaudeLogs({ projectsDir, since = 0, cache = defaultAuditCache }) {
  let dirs;
  try {
    dirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const events = [];
  const startContexts = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const folder = path.join(projectsDir, dir.name);
    for (const name of await fs.promises.readdir(folder)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(folder, name);
      let entry;
      try {
        const stat = await fs.promises.stat(file);
        if (stat.mtimeMs < since) continue;
        entry = cache.get(file);
        if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
          entry = { mtimeMs: stat.mtimeMs, size: stat.size, result: auditClaudeTurns(await readClaudeTurns(file)) };
          cache.set(file, entry);
        }
      } catch (error) {
        // Claude Code prunes old transcripts, so one can vanish mid-scan.
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const event of entry.result.rebuilds) if (event.t >= since) events.push(event);
      if (entry.result.startedAt >= since && entry.result.minContext > 0) startContexts.push(entry.result.minContext);
    }
  }
  return { events, startContexts };
}

// Says yes once per session, the first time it is both heavy and in use.
function createHeavySessionWatch({ minContext = 150_000, activeWithinMs = 5 * MIN } = {}) {
  const told = new Set();
  return (session, now = Date.now()) => {
    const key = `${session.client}:${session.sessionId}`;
    if (told.has(key) || !(session.contextTokens >= minContext)) return false;
    if (!(now - Date.parse(session.lastUsedAt) <= activeWithinMs)) return false;
    told.add(key);
    return true;
  };
}

module.exports = { analyzeXray, auditClaudeLogs, auditClaudeTurns, createHeavySessionWatch, readClaudeTurns };
