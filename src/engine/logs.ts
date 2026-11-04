// Finds Claude Code's JSONL logs and turns them into chats: billed turns plus /compact markers.
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

export interface Turn {
  kind: 'turn';
  id: string; // message.id + requestId: one response, however many times it was logged
  t: number; // when the response was first logged (ms since 1970)
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
  sidechain: boolean; // a subagent's turn, with its own cache
}
export interface Compact { kind: 'compact'; t: number }
export type Entry = Turn | Compact;
export interface Chat { id: string; title: string | null; project: string; entries: Entry[] }

export function claudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const lastFolder = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? '';

// Every .jsonl under projects/, including subagent logs in <chat>/subagents/, changed since `since`.
export async function findLogFiles(projectsDir: string, since = 0): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(projectsDir, { recursive: true });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = join(projectsDir, name);
    try {
      if ((await stat(file)).mtimeMs >= since) files.push(file);
    } catch (error) {
      if (!missing(error)) throw error; // Claude Code prunes old logs, so one can vanish mid-scan
    }
  }
  return files.sort();
}

// The fields of a log line that Token X-ray reads. Everything else is ignored.
export interface Row {
  type?: string; subtype?: string; timestamp?: string; sessionId?: string; cwd?: string; requestId?: string;
  isSidechain?: boolean; isApiErrorMessage?: boolean; isCompactSummary?: boolean;
  aiTitle?: string; customTitle?: string;
  message?: {
    id?: string; model?: string;
    usage?: {
      input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown;
      cache_creation?: { ephemeral_1h_input_tokens?: unknown };
    };
  };
}

// Logs run to hundreds of MB and only a few lines matter, so skip the rest before parsing.
// Returns null for a line that does not matter or is half-written (Claude Code may be mid-write).
export function parseRow(line: string): Row | null {
  if (!line.includes('"usage"') && !line.includes('compact_boundary') && !line.includes('isCompactSummary') && !line.includes('Title"')) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// One row -> a billed turn, a /compact marker, or null for everything else.
export function toEntry(row: Row): Entry | null {
  const t = Date.parse(row.timestamp ?? '');
  if (!Number.isFinite(t)) return null;
  if ((row.subtype === 'compact_boundary' || row.isCompactSummary === true) && row.isSidechain !== true) return { kind: 'compact', t };
  const usage = row.message?.usage;
  if (row.type !== 'assistant' || !usage || row.isApiErrorMessage === true || row.message?.model === '<synthetic>') return null;
  const write = count(usage.cache_creation_input_tokens);
  const write1h = Math.min(count(usage.cache_creation?.ephemeral_1h_input_tokens), write);
  return {
    kind: 'turn',
    id: `${row.message?.id}|${row.requestId}`,
    t,
    model: String(row.message?.model ?? ''),
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    write5m: write - write1h,
    write1h,
    sidechain: row.isSidechain === true,
  };
}

export interface Log { sessionId: string; title: string | null; cwd: string | null; entries: Entry[] }

export async function readLog(file: string): Promise<Log> {
  const log: Log = { sessionId: basename(file, '.jsonl'), title: null, cwd: null, entries: [] };
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  const seen = new Map<string, number>();
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    const row = parseRow(line);
    if (!row) continue;
    if (typeof row.sessionId === 'string') log.sessionId = row.sessionId;
    if (row.type === 'ai-title' && typeof row.aiTitle === 'string') aiTitle = row.aiTitle;
    if (row.type === 'custom-title' && typeof row.customTitle === 'string') customTitle = row.customTitle;
    const entry = toEntry(row);
    if (!entry) continue;
    if (entry.kind === 'compact') {
      log.entries.push(entry);
      continue;
    }
    if (!log.cwd && typeof row.cwd === 'string') log.cwd = row.cwd;
    // Claude Code logs one response several times while it streams. Count it once, with the
    // last copy's usage (output keeps growing) and the first copy's time.
    const at = seen.get(entry.id);
    if (at === undefined) {
      seen.set(entry.id, log.entries.length);
      log.entries.push(entry);
    } else {
      log.entries[at] = { ...entry, t: log.entries[at].t };
    }
  }
  log.title = customTitle ?? aiTitle;
  return log;
}

// One chat per session id. A subagent log carries its parent chat's session id, so it merges in.
export async function loadChats(projectsDir: string, since = 0): Promise<Chat[]> {
  const chats = new Map<string, Chat>();
  const turnAt = new Map<string, Map<string, number>>(); // per chat: response id -> index in entries
  for (const file of await findLogFiles(projectsDir, since)) {
    let log: Log;
    try {
      log = await readLog(file);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    let chat = chats.get(log.sessionId);
    if (!chat) {
      chat = { id: log.sessionId, title: null, project: '', entries: [] };
      chats.set(chat.id, chat);
      turnAt.set(chat.id, new Map());
    }
    const seen = turnAt.get(chat.id)!;
    chat.title = log.title ?? chat.title;
    if (!chat.project && log.cwd) chat.project = lastFolder(log.cwd);
    for (const entry of log.entries) {
      if (entry.kind === 'compact') {
        chat.entries.push(entry);
        continue;
      }
      // The /compact helper's log (subagents/agent-acompact-*) repeats main-chat responses.
      // Count each once, preferring the main-chat copy.
      const at = seen.get(entry.id);
      if (at === undefined) {
        seen.set(entry.id, chat.entries.length);
        chat.entries.push(entry);
      } else if ((chat.entries[at] as Turn).sidechain && !entry.sidechain) {
        chat.entries[at] = entry;
      }
    }
  }
  for (const chat of chats.values()) chat.entries.sort((a, b) => a.t - b.t);
  return [...chats.values()];
}
