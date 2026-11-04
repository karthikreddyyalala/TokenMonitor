// `tokenxray setup`: adds the status line to Claude Code's settings.json. Shows the change and asks
// first, keeps a backup, and never touches a file it cannot parse.
import { copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const REFRESH_SECONDS = 30; // Claude Code re-runs the command this often, so the countdown ticks while you are idle

export type SetupPlan =
  | { kind: 'unreadable'; reason: string }
  | { kind: 'done' }
  | { kind: 'change'; before: unknown; after: Record<string, unknown>; text: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Absolute paths, so the status line needs neither npx (slow) nor node on Claude Code's PATH.
export const statusCommand = (node: string, main: string) => `${JSON.stringify(node)} ${JSON.stringify(main)} statusline`;

export function planSetup(current: string | null, command: string): SetupPlan {
  let settings: Record<string, unknown> = {};
  if (current !== null && current.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current.replace(/^\uFEFF/, '')); // Windows Notepad adds a byte-order mark
    } catch (error) {
      return { kind: 'unreadable', reason: (error as Error).message };
    }
    if (!isObject(parsed)) return { kind: 'unreadable', reason: 'it is not a JSON object' };
    settings = parsed;
  }
  const before = settings.statusLine;
  // Keep the user's other status line options, such as padding.
  const after = { ...(isObject(before) ? before : {}), type: 'command', command, refreshInterval: REFRESH_SECONDS };
  if (JSON.stringify(before) === JSON.stringify(after)) return { kind: 'done' };
  return { kind: 'change', before, after, text: `${JSON.stringify({ ...settings, statusLine: after }, null, 2)}\n` };
}

export function describeChange(file: string, plan: { before: unknown; after: unknown }): string {
  const block = (value: unknown) => `"statusLine": ${JSON.stringify(value, null, 2)}`.split('\n');
  const removed = plan.before === undefined ? [] : block(plan.before).map((line) => `- ${line}`);
  return [`Token X-ray will change ${file}:`, '', ...removed, ...block(plan.after).map((line) => `+ ${line}`), ''].join('\n');
}

export async function runSetup(
  file: string,
  command: string,
  ask: (question: string) => Promise<string>,
  log: (text: string) => void = console.log,
): Promise<number> {
  let current: string | null = null;
  try {
    current = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const plan = planSetup(current, command);
  if (plan.kind === 'unreadable') {
    log(`${file} is not valid JSON (${plan.reason}).\nFix it first; Token X-ray never overwrites a file it cannot read.`);
    return 1;
  }
  if (plan.kind === 'done') {
    log('The Token X-ray status line is already set up.');
    return 0;
  }
  log(describeChange(file, plan));
  const answer = (await ask('Apply this change? [y/N] ')).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    log('Nothing changed.');
    return 0;
  }
  await mkdir(dirname(file), { recursive: true });
  // Write through a symlink (dotfile managers), not over it.
  const target = current === null ? file : await realpath(file);
  let backup = '';
  if (current !== null) {
    backup = `${target}.backup-${Date.now()}`;
    await copyFile(target, backup);
  }
  const temp = `${target}.tokenxray-tmp`;
  await writeFile(temp, plan.text);
  try {
    await rename(temp, target); // a crash mid-write leaves the old file whole
  } catch (error) {
    await rm(temp, { force: true }); // on Windows the file can be locked by another program
    throw error;
  }
  log(`Done.${backup ? ` Backup: ${backup}` : ''}\nThe countdown appears under Claude Code's prompt after its next response.`);
  return 0;
}
