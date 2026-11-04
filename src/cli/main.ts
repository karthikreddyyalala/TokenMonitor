#!/usr/bin/env node
import { join, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { claudeDir } from '../engine/logs.ts';
import { xray } from '../engine/xray.ts';
import { runSetup, statusCommand } from '../statusline/setup.ts';
import { runStatusline } from '../statusline/statusline.ts';
import { renderReport } from './report.ts';

const HELP = `Token X-ray: see where your Claude Code spend goes.

Usage
  npx tokenxray [--days N] [--json]   the report
  tokenxray setup                     add the cache countdown to Claude Code's status line
  tokenxray statusline                print the countdown (Claude Code runs this itself)

Options
  --days N     how many days back to look (default 30)
  --json       print the numbers as JSON instead
  -h, --help   show this help

Reads Claude Code's logs in ~/.claude (or $CLAUDE_CONFIG_DIR). Nothing leaves your computer.`;

async function statusline(): Promise<number> {
  if (process.stdin.isTTY) {
    console.error('Claude Code runs this itself and sends it the chat on stdin. To turn it on: tokenxray setup');
    return 2;
  }
  console.log(await runStatusline(await text(process.stdin), Date.now(), !process.env.NO_COLOR));
  return 0;
}

async function setup(): Promise<number> {
  const main = fileURLToPath(import.meta.url);
  if (main.includes(`${sep}_npx${sep}`)) {
    console.error('Install Token X-ray first, so the status line does not depend on npx:\n  npm install -g tokenxray\n  tokenxray setup');
    return 2;
  }
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise<string>((resolve) => lines.once('close', () => resolve(''))); // stdin ended: no answer means no
  try {
    const ask = (question: string) => Promise.race([lines.question(question), closed]);
    return await runSetup(join(claudeDir(), 'settings.json'), statusCommand(process.execPath, main), ask);
  } finally {
    lines.close();
  }
}

async function main(): Promise<number> {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        days: { type: 'string', default: '30' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const [command] = positionals;
  if (command === 'statusline') return statusline();
  if (command === 'setup') return setup();
  if (command !== undefined) {
    console.error(`Unknown command "${command}".\n\n${HELP}`);
    return 2;
  }
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1) {
    console.error(`--days needs a whole number of days, like --days 30 (got "${values.days}")`);
    return 2;
  }
  const dir = claudeDir();
  const report = await xray({ days, dir });
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.turns === 0) {
    console.log(`No Claude Code usage in the last ${days} days under ${join(dir, 'projects')}.\nUse Claude Code for a while, then run this again.`);
  } else {
    console.log(renderReport(report, { color: process.stdout.hasColors?.() ?? false, days }));
  }
  return 0;
}

process.exitCode = await main();
