// Turns an engine Report into the terminal screen. Pure function: same report in, same text out.
import { styleText } from 'node:util';
import type { Report } from '../engine/xray.ts';
import type { ReloadKind } from '../engine/reloads.ts';

export interface RenderOptions { color: boolean; days: number; timeZone?: string }

const BAR_WIDTH = 48;
const LABEL_WIDTH = 34;
const PARTS = [
  { key: 'cacheRead', label: 'Re-reading', char: '█', note: 're-sending the whole chat every turn' },
  { key: 'cacheWrite', label: 'Cache writes', char: '▓', note: 'saving new context to the cache' },
  { key: 'output', label: 'Output', char: '▒', note: 'what Claude wrote' },
  { key: 'input', label: 'New input', char: '░', note: 'uncached input' },
] as const;
const KINDS: { kind: ReloadKind; label: string; note: string }[] = [
  { kind: 'expired', label: 'Expired', note: 'chat sat idle past its cache lifetime' },
  { kind: 'modelSwitch', label: 'Model switch', note: 'a new model starts a new cache' },
  { kind: 'unexplained', label: 'Unexplained', note: 'rebuilt with no visible cause' },
];

export const money = (usd: number) =>
  usd > 0 && usd < 0.01 ? '<$0.01' : usd.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
export const tokens = (n: number) =>
  n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`;
const percent = (part: number, whole: number) => `${whole > 0 ? Math.round((100 * part) / whole) : 0}%`;
export const duration = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.round(minutes / (24 * 60))}d`;
};
const clip = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text);

// Splits `width` cells between the parts so they always add up exactly (largest remainder first).
export function barCells(values: number[], width = BAR_WIDTH): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((v) => (v / total) * width);
  const cells = exact.map(Math.floor);
  const byRemainder = exact.map((v, i) => [v - cells[i], i]).sort((a, b) => b[0] - a[0]);
  const missing = width - cells.reduce((a, b) => a + b, 0);
  for (let i = 0; i < missing; i++) cells[byRemainder[i][1]] += 1;
  return cells;
}

export function renderReport(report: Report, { color, days, timeZone }: RenderOptions): string {
  const paint = (format: Parameters<typeof styleText>[0], text: string) =>
    color ? styleText(format, text, { validateStream: false }) : text;
  const accent = (text: string) => paint(['bold', 'yellow'], text);
  const dim = (text: string) => paint('dim', text);
  const when = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
  const chatLabel = (row: { title: string | null; project: string }) =>
    clip([row.title ?? 'untitled chat', row.project].filter(Boolean).join(' · '), LABEL_WIDTH);
  const total = report.totalCost;
  const out: string[] = [];

  out.push('', `  ${paint('bold', 'TOKEN X-RAY')}  ${dim(`last ${days} days · ${report.turns.toLocaleString('en-US')} turns in ${report.chats} chats`)}`, '');
  out.push(`  ${accent(percent(report.cost.cacheRead, total))} ${paint('bold', 'of your spend went to re-reading old context.')}`);
  out.push(`  ${money(total)} ${dim('at API prices')}`, '');

  const cells = barCells(PARTS.map((p) => report.cost[p.key]));
  out.push(`  ${PARTS.map((p, i) => (i === 0 ? accent : dim)(p.char.repeat(cells[i]))).join('')}`);
  for (const p of PARTS) {
    const value = report.cost[p.key];
    out.push(`  ${p.char} ${p.label.padEnd(13)}${percent(value, total).padStart(4)}  ${money(value).padStart(10)}   ${dim(p.note)}`);
  }

  const reloads = report.reloads;
  out.push('', `  ${paint('bold', 'Cache reloads')}  ${accent(String(reloads.count))} ${dim('·')} ${money(reloads.cost)} ${dim(`· ${percent(reloads.cost, total)} of spend`)}`);
  for (const k of KINDS) {
    const { count, cost } = reloads.byKind[k.kind];
    out.push(`    ${k.label.padEnd(13)}${String(count).padStart(4)}  ${money(cost).padStart(10)}   ${dim(k.note)}`);
  }
  if (reloads.worst.length > 0) {
    out.push('', `    ${dim('Worst reloads')}`);
    for (const r of reloads.worst) {
      const why = r.kind === 'expired' && r.gapMs !== null ? `idle ${duration(r.gapMs)}` : KINDS.find((k) => k.kind === r.kind)!.label.toLowerCase();
      out.push(`    ${dim(when.format(r.t).padEnd(14))}${tokens(r.tokens).padStart(6)}  ${money(r.cost).padStart(9)}  ${why.padEnd(14)} ${chatLabel(r)}`);
    }
  }

  out.push('', `  ${paint('bold', 'Heaviest chats')}`);
  for (const c of report.heaviest) {
    const turns = `${c.turns.toLocaleString('en-US')} ${c.turns === 1 ? 'turn' : 'turns'}`;
    const peak = `peak ${c.peakContext > 0 ? tokens(c.peakContext) : '-'}`;
    out.push(`    ${money(c.cost).padStart(10)}  ${turns.padStart(10)}  ${dim(peak.padEnd(11))} ${chatLabel(c)}`);
  }

  if (report.unpricedTurns > 0) {
    out.push('', `  ${dim(`${report.unpricedTurns} turns on models without a known price were left out: ${report.unpricedModels.join(', ')}`)}`);
  }
  out.push('', `  ${dim('Dollar figures use Anthropic API list prices. On a Pro or Max plan you pay a flat fee;')}`);
  out.push(`  ${dim('the shares still show where your usage goes.')}`, '');
  return out.join('\n');
}
