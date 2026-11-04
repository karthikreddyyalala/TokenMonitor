// `tokenxray statusline`: the one line Claude Code shows under the prompt, e.g. "cache 42m · 216k ctx".
import { styleText } from 'node:util';
import { liveCache, type CacheState, type StatusInput } from '../engine/cache.ts';
import { tokens } from '../cli/report.ts';

const AMBER_BELOW = 10 * 60_000;
const RED_BELOW = 5 * 60_000;

export function renderStatus(state: CacheState | null, now: number, color: boolean): string {
  if (!state) return '';
  const paint = (format: Parameters<typeof styleText>[0], text: string) =>
    color ? styleText(format, text, { validateStream: false }) : text;
  const context = paint('dim', `${tokens(state.context)} ctx`);
  const left = state.expiresAt - now;
  if (left <= 0) return `${paint('red', 'cache expired')} · ${context}`;
  const label = `cache ${Math.ceil(left / 60_000)}m`;
  const shown = left < RED_BELOW ? paint('red', label) : left < AMBER_BELOW ? paint('yellow', label) : label;
  return `${shown} · ${context}`;
}

// Never throws: a broken status line would print an error under every prompt.
export async function runStatusline(stdin: string, now: number, color: boolean): Promise<string> {
  try {
    return renderStatus(await liveCache(JSON.parse(stdin) as StatusInput), now, color);
  } catch {
    return '';
  }
}
