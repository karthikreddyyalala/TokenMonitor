// Finds Claude Code's JSONL logs and turns them into chats: billed turns plus /compact markers.
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

export interface Turn {
  kind: 'turn';
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
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
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

export interface Log { sessionId: string; title: string | null; cwd: string | null; entries: Entry[] }

export async function readLog(file: string): Promise<Log> {
  const log: Log = { sessionId: basename(file, '.jsonl'), title: null, cwd: null, entries: [] };
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  const seen = new Map<string, number>();
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    // Logs run to hundreds of MB; only these lines matter, so skip the rest before parsing.
    if (!line.includes('"usage"') && !line.includes('compact_boundary') && !line.includes('isCompactSummary') && !line.includes('Title"')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // the last line can be half-written while Claude Code is running
    }
    if (typeof row.sessionId === 'string') log.sessionId = row.sessionId;
    if (row.type === 'ai-title' && typeof row.aiTitle === 'string') aiTitle = row.aiTitle;
    if (row.type === 'custom-title' && typeof row.customTitle === 'string') customTitle = row.customTitle;
    const t = Date.parse(row.timestamp);
    if (!Number.isFinite(t)) continue;
    if ((row.subtype === 'compact_boundary' || row.isCompactSummary === true) && row.isSidechain !== true) {
      log.entries.push({ kind: 'compact', t });
      continue;
    }
    const usage = row.message?.usage;
    if (row.type !== 'assistant' || !usage || row.isApiErrorMessage === true || row.message.model === '<synthetic>') continue;
    if (!log.cwd && typeof row.cwd === 'string') log.cwd = row.cwd;
    const write = count(usage.cache_creation_input_tokens);
    const write1h = Math.min(count(usage.cache_creation?.ephemeral_1h_input_tokens), write);
    const turn: Turn = {
      kind: 'turn',
      t,
      model: String(row.message.model ?? ''),
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      write5m: write - write1h,
      write1h,
      sidechain: row.isSidechain === true,
    };
    // Claude Code logs one response several times while it streams. Count it once, with the
    // last copy's usage (output keeps growing) and the first copy's time.
    const id = `${row.message.id}|${row.requestId}`;
    const at = seen.get(id);
    if (at === undefined) {
      seen.set(id, log.entries.length);
      log.entries.push(turn);
    } else {
      log.entries[at] = { ...turn, t: log.entries[at].t };
    }
  }
  log.title = customTitle ?? aiTitle;
  return log;
}

// One chat per session id. A subagent log carries its parent chat's session id, so it merges in.
export async function loadChats(projectsDir: string, since = 0): Promise<Chat[]> {
  const chats = new Map<string, Chat>();
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
    }
    chat.title = log.title ?? chat.title;
    if (!chat.project && log.cwd) chat.project = lastFolder(log.cwd);
    for (const entry of log.entries) chat.entries.push(entry);
  }
  for (const chat of chats.values()) chat.entries.sort((a, b) => a.t - b.t);
  return [...chats.values()];
}
