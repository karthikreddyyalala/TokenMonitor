#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { claudeDir } from '../engine/logs.ts';
import { xray } from '../engine/xray.ts';
import { renderReport } from './report.ts';

const HELP = `Token X-ray: see where your Claude Code spend goes.

Usage
  npx tokenxray [--days N] [--json]

Options
  --days N     how many days back to look (default 30)
  --json       print the numbers as JSON instead
  -h, --help   show this help

Reads Claude Code's logs in ~/.claude (or $CLAUDE_CONFIG_DIR). Nothing leaves your computer.`;

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
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
