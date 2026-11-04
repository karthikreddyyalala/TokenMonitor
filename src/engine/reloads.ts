// Cache reloads: turns that paid to write (almost) the whole conversation into the cache again
// instead of reading it, because the cache expired, the model changed, or for no visible reason.
import type { Entry, Turn } from './logs.ts';

export type ReloadKind = 'expired' | 'modelSwitch' | 'unexplained';
export interface Reload { turn: Turn; kind: ReloadKind; tokens: number; gapMs: number | null }

const MIN_CONTEXT = 20_000; // smaller rebuilds are noise
const REWRITE_SHARE = 0.6; // a reload re-writes at least this share of the context
const SHRUNK_BELOW = 0.7; // a context this much smaller than before was compacted, not reloaded
const FIVE_MINUTES = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;

// `entries` is one chat, sorted by time. Subagent turns have their own caches, so they are skipped.
export function findReloads(entries: Entry[]): Reload[] {
  const reloads: Reload[] = [];
  // The cache is per model: switching away and back within its lifetime is free.
  let lastByModel = new Map<string, { t: number; context: number; ttl: number }>();
  let lastAny: { t: number; ttl: number } | null = null;
  for (const entry of entries) {
    if (entry.kind === 'compact') {
      lastByModel = new Map(); // after /compact a fresh write is expected, not waste
      lastAny = null;
      continue;
    }
    if (entry.sidechain) continue;
    const write = entry.write5m + entry.write1h;
    const context = entry.input + write + entry.cacheRead;
    const prev = lastByModel.get(entry.model);
    const before = lastAny;
    // A write states its tier; a pure read does not, so it keeps the tier seen before.
    const ttl = entry.write1h > 0 ? ONE_HOUR : entry.write5m > 0 ? FIVE_MINUTES : (prev?.ttl ?? ONE_HOUR);
    lastByModel.set(entry.model, { t: entry.t, context, ttl });
    lastAny = { t: entry.t, ttl };
    if (context < MIN_CONTEXT || write < REWRITE_SHARE * context) continue;
    if (!prev) {
      if (!before) continue; // the chat's first turn
      // If the chat sat idle past the cache lifetime, it would have reloaded on any model.
      const gapMs = entry.t - before.t;
      const kind = gapMs > before.ttl ? 'expired' : 'modelSwitch';
      reloads.push({ turn: entry, kind, tokens: write, gapMs: kind === 'expired' ? gapMs : null });
      continue;
    }
    if (context < SHRUNK_BELOW * prev.context) continue;
    const gapMs = entry.t - prev.t;
    // The previous turn's tier decides how long the cache lived.
    reloads.push({ turn: entry, kind: gapMs > prev.ttl ? 'expired' : 'unexplained', tokens: write, gapMs });
  }
  return reloads;
}
