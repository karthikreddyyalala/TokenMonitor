// The one place every number comes from. The report, the status line and the dashboard all read this.
import { join } from 'node:path';
import { claudeDir, loadChats, type Chat } from './logs.ts';
import { findReloads, type ReloadKind } from './reloads.ts';
import { addSplit, emptySplit, splitTotal, turnCost, turnTokens, type Split } from './spend.ts';

export interface ReloadRow {
  chatId: string; title: string | null; project: string;
  t: number; kind: ReloadKind; model: string; tokens: number; cost: number; gapMs: number | null;
}
export interface ChatRow {
  chatId: string; title: string | null; project: string;
  cost: number; turns: number; peakContext: number; reloads: number;
}
export interface Report {
  since: number;
  until: number;
  chats: number;
  turns: number;
  unpricedTurns: number;
  unpricedModels: string[];
  tokens: Split;
  cost: Split;
  totalCost: number;
  reloads: {
    count: number;
    cost: number;
    byKind: Record<ReloadKind, { count: number; cost: number }>;
    worst: ReloadRow[];
  };
  heaviest: ChatRow[];
}

const DAY = 86_400_000;
const TOP = 5;

export function analyze(chats: Chat[], since: number, until: number): Report {
  const report: Report = {
    since, until, chats: 0, turns: 0, unpricedTurns: 0, unpricedModels: [],
    tokens: emptySplit(), cost: emptySplit(), totalCost: 0,
    reloads: {
      count: 0, cost: 0, worst: [],
      byKind: { expired: { count: 0, cost: 0 }, modelSwitch: { count: 0, cost: 0 }, unexplained: { count: 0, cost: 0 } },
    },
    heaviest: [],
  };
  const unpriced = new Set<string>();
  const allReloads: ReloadRow[] = [];
  const inRange = (t: number) => t >= since && t <= until;

  for (const chat of chats) {
    const row: ChatRow = { chatId: chat.id, title: chat.title, project: chat.project, cost: 0, turns: 0, peakContext: 0, reloads: 0 };
    for (const entry of chat.entries) {
      if (entry.kind !== 'turn' || !inRange(entry.t)) continue;
      row.turns += 1;
      addSplit(report.tokens, turnTokens(entry));
      const cost = turnCost(entry);
      if (cost) {
        addSplit(report.cost, cost);
        row.cost += splitTotal(cost);
      } else {
        report.unpricedTurns += 1;
        unpriced.add(entry.model);
      }
      if (!entry.sidechain) row.peakContext = Math.max(row.peakContext, entry.input + entry.write5m + entry.write1h + entry.cacheRead);
    }
    // Reloads look at the whole chat, so a turn just inside the range is compared with the one before it.
    for (const reload of findReloads(chat.entries)) {
      if (!inRange(reload.turn.t)) continue;
      const cost = turnCost(reload.turn)?.cacheWrite ?? 0;
      allReloads.push({
        chatId: chat.id, title: chat.title, project: chat.project,
        t: reload.turn.t, kind: reload.kind, model: reload.turn.model, tokens: reload.tokens, cost, gapMs: reload.gapMs,
      });
      row.reloads += 1;
    }
    if (row.turns === 0) continue;
    report.chats += 1;
    report.turns += row.turns;
    report.heaviest.push(row);
  }

  report.totalCost = splitTotal(report.cost);
  report.unpricedModels = [...unpriced].sort();
  for (const reload of allReloads) {
    report.reloads.count += 1;
    report.reloads.cost += reload.cost;
    report.reloads.byKind[reload.kind].count += 1;
    report.reloads.byKind[reload.kind].cost += reload.cost;
  }
  report.reloads.worst = allReloads.sort((a, b) => b.cost - a.cost).slice(0, TOP);
  report.heaviest = report.heaviest.sort((a, b) => b.cost - a.cost).slice(0, TOP);
  return report;
}

export async function xray({ days, now = Date.now(), dir = claudeDir() }: { days: number; now?: number; dir?: string }): Promise<Report> {
  const since = now - days * DAY;
  return analyze(await loadChats(join(dir, 'projects'), since), since, now);
}
