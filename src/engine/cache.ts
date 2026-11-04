// The live prompt cache of one chat: when it goes cold and how big it is. The status line shows this.
// Two sources: the JSON Claude Code 2.1.251+ pipes to the status line, or the end of the chat's log.
import { open } from 'node:fs/promises';
import { count, parseRow, toEntry, type Entry, type Turn } from './logs.ts';
import { ONE_HOUR, tierOf } from './reloads.ts';

export interface CacheState { expiresAt: number; context: number }

// What Claude Code pipes to a status line command (only the fields read here).
// Docs: https://code.claude.com/docs/en/statusline
export interface StatusInput {
  transcript_path?: string;
  context_window?: { current_usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null };
  prompt_cache?: { ttl?: string; expires_at?: number | null };
}

const FIRST_WINDOW = 64 * 1024; // the last response is almost always in the final few KB
const MAX_WINDOW = 64 * 1024 * 1024;

// `entries` is the end of one chat's log, oldest first; `whole` says whether it is the entire log.
// Returns undefined when the end is not enough to tell, so an earlier part must be read too.
export function cacheFromEntries(entries: Entry[], whole: boolean): CacheState | null | undefined {
  let last: Turn | null = null;
  let ttl: number | null = null;
  let compacted = false;
  const firstSeen = new Map<string, number>(); // a response logged several times refreshed the cache once, at its first copy
  for (const entry of entries) {
    if (entry.kind === 'compact') {
      last = null; // /compact starts a new conversation; its cache starts with the next response
      compacted = true;
      continue;
    }
    if (entry.sidechain || entry.cacheRead + entry.write5m + entry.write1h === 0) continue;
    if (!firstSeen.has(entry.id)) firstSeen.set(entry.id, entry.t);
    ttl = tierOf(entry) ?? ttl;
    last = entry;
  }
  if (!last) return compacted || whole ? null : undefined;
  if (ttl === null && !whole) return undefined; // a pure read: the tier was written earlier
  return {
    expiresAt: firstSeen.get(last.id)! + (ttl ?? ONE_HOUR),
    context: last.input + last.write5m + last.write1h + last.cacheRead,
  };
}

// Reads the log backwards in growing windows until the answer is known. Fast on 100 MB logs.
export async function cacheFromLog(file: string, firstWindow = FIRST_WINDOW): Promise<CacheState | null> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    for (let window = firstWindow; ; window *= 8) {
      const length = Math.min(window, size);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const whole = length === size;
      const lines = buffer.toString('utf8').split('\n');
      if (!whole) lines.shift(); // cut off mid-line
      const entries: Entry[] = [];
      for (const line of lines) {
        const row = parseRow(line);
        const entry = row && toEntry(row);
        if (entry) entries.push(entry);
      }
      const state = cacheFromEntries(entries, whole);
      if (state !== undefined) return state;
      if (window >= MAX_WINDOW) return null;
    }
  } finally {
    await handle.close();
  }
}

// Claude Code 2.1.251+ states the expiry itself. Returns undefined when it does not (older versions).
export function cacheFromStatus(input: StatusInput): CacheState | null | undefined {
  const cache = input.prompt_cache;
  if (!cache || cache.expires_at === undefined) return undefined;
  if (cache.expires_at === null) return null; // the last response used no cache
  const usage = input.context_window?.current_usage;
  if (!usage) return undefined;
  return {
    expiresAt: cache.expires_at * 1000,
    context: count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens),
  };
}

export async function liveCache(input: StatusInput): Promise<CacheState | null> {
  const stated = cacheFromStatus(input);
  if (stated !== undefined) return stated;
  return input.transcript_path ? cacheFromLog(input.transcript_path) : null;
}
