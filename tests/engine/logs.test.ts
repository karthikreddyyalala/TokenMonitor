import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeDir, findLogFiles, loadChats, parseRow, readLog, type Turn } from '../../src/engine/logs.ts';
import { COMPACT_CHAT, FIXTURES, HOME_CHAT, PROJECTS, RENAMED_CHAT, SUBAGENT_LOG, SWITCH_CHAT } from '../helpers.ts';

const turns = (entries: { kind: string }[]) => entries.filter((e): e is Turn => e.kind === 'turn');

test('claudeDir honours CLAUDE_CONFIG_DIR', () => {
  assert.equal(claudeDir({ CLAUDE_CONFIG_DIR: '/tmp/work-claude' }), '/tmp/work-claude');
  assert.match(claudeDir({}), /\.claude$/);
});

test('findLogFiles walks into subagent folders and tolerates a missing folder', async () => {
  const files = await findLogFiles(PROJECTS);
  assert.equal(files.length, 5);
  assert.ok(files.includes(SUBAGENT_LOG));
  assert.deepEqual(await findLogFiles(join(PROJECTS, 'nope')), []);
  assert.deepEqual(await findLogFiles(PROJECTS, Date.now() + 60_000), []);
});

test('a response logged twice counts once, with the last copy usage and the first copy time', async () => {
  const log = await readLog(HOME_CHAT);
  const all = turns(log.entries);
  assert.equal(all.length, 3); // 4 lines, 2 of them the same response
  assert.equal(all[0].output, 410); // the first copy said 5 while still streaming
  assert.equal(all[0].t, Date.parse('2026-10-20T03:50:13.386Z'));
  assert.deepEqual([all[0].write5m, all[0].write1h], [0, 30828]);
});

test('API error placeholders are skipped and /compact is kept as a marker', async () => {
  const log = await readLog(COMPACT_CHAT);
  assert.deepEqual(log.entries.map((e) => e.kind), ['turn', 'compact', 'turn']);
  assert.ok(turns(log.entries).every((t) => t.model !== '<synthetic>'));
});

test('titles: a renamed chat uses its custom title, otherwise the AI title, otherwise none', async () => {
  assert.equal((await readLog(RENAMED_CHAT)).title, 'Renamed fixture chat');
  assert.equal((await readLog(SWITCH_CHAT)).title, 'Fixture chat');
  assert.equal((await readLog(HOME_CHAT)).title, null);
});

test('a response repeated in the /compact helper log counts once, as the main-chat turn', async () => {
  const chats = await loadChats(join(FIXTURES, 'compact-agent', 'projects'));
  assert.equal(chats.length, 1);
  const all = turns(chats[0].entries);
  assert.equal(all.length, 1);
  assert.equal(all[0].sidechain, false);
});

test('loadChats merges a subagent log into its parent chat and names the project', async () => {
  const chats = await loadChats(PROJECTS);
  assert.equal(chats.length, 5);
  const parent = chats.find((c) => c.id === '9139fb89-aedd-4bdd-bdc4-5e59a7a0b134');
  assert.ok(parent);
  assert.equal(parent.project, 'Crucible');
  assert.deepEqual(turns(parent.entries).map((t) => t.sidechain), [true]);
  const home = chats.find((c) => c.id === '1eb4e9bd-6da2-4752-a65b-579a033add88');
  assert.equal(home?.project, 'home');
});

test('parseRow skips lines that do not matter and half-written ones', () => {
  assert.equal(parseRow('{"type":"user","message":{"content":"hi"}}'), null);
  assert.equal(parseRow('{"type":"assistant","message":{"usage":{"input_tok'), null);
  assert.equal(parseRow('{"type":"ai-title","aiTitle":"Fixture chat"}')?.aiTitle, 'Fixture chat');
});
