// Cuts real Claude Code log lines into a test fixture, keeping only the fields Token X-ray reads.
// Message text is replaced, titles become fixed strings, and cwd keeps only its last folder name
// (or "home" for your home folder, whose name is your username).
// Usage: node scripts/make-fixture.ts <transcript.jsonl> <line> [<line> ...]   (line numbers start at 1)
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';

const [file, ...picks] = process.argv.slice(2);
if (!file || picks.length === 0) {
  console.error('Usage: node scripts/make-fixture.ts <transcript.jsonl> <line> [<line> ...]');
  process.exit(2);
}
const lines = readFileSync(file, 'utf8').split('\n');
const HOME = basename(homedir());
const KEEP = ['type', 'subtype', 'sessionId', 'timestamp', 'isSidechain', 'isApiErrorMessage', 'isCompactSummary', 'requestId'];

for (const pick of picks) {
  const row = JSON.parse(lines[Number(pick) - 1]);
  const out: Record<string, unknown> = {};
  for (const key of KEEP) if (key in row) out[key] = row[key];
  if (typeof row.cwd === 'string') {
    const folder = row.cwd.split(/[\\/]/).pop();
    out.cwd = folder === HOME ? 'home' : folder; // your home folder name is your username
  }
  if (row.type === 'ai-title') out.aiTitle = 'Fixture chat';
  if (row.type === 'custom-title') out.customTitle = 'Renamed fixture chat';
  if (row.compactMetadata) {
    const { trigger, preTokens, postTokens } = row.compactMetadata;
    out.compactMetadata = { trigger, preTokens, postTokens };
  }
  if (row.message) {
    const { id, model, role, usage } = row.message;
    out.message = { id, model, role, content: '[redacted]', ...(usage && { usage }) };
  }
  console.log(JSON.stringify(out));
}
