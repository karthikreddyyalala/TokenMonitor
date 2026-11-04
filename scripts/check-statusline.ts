// Checks the status line against your real logs: reading only the end of each chat log must give
// the same answer as reading the whole file. Usage: node scripts/check-statusline.ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cacheFromEntries, cacheFromLog } from '../src/engine/cache.ts';
import { claudeDir, parseRow, toEntry, type Entry } from '../src/engine/logs.ts';

const root = join(claudeDir(), 'projects');
let same = 0;
let different = 0;
for (const name of await readdir(root, { recursive: true })) {
  if (!name.endsWith('.jsonl') || name.includes('subagents')) continue;
  const file = join(root, name);
  const entries: Entry[] = [];
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    const row = parseRow(line);
    const entry = row && toEntry(row);
    if (entry) entries.push(entry);
  }
  const whole = JSON.stringify(cacheFromEntries(entries, true));
  const tail = JSON.stringify(await cacheFromLog(file));
  if (whole === tail) same += 1;
  else {
    different += 1;
    console.log(`${name}\n  whole file: ${whole}\n  end only:   ${tail}`);
  }
}
console.log(`${same} chats match, ${different} differ`);
process.exitCode = different > 0 ? 1 : 0;
