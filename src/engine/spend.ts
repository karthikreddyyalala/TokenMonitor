// What one turn cost, split into the four things you pay for.
import type { Turn } from './logs.ts';
import { priceFor } from './pricing.ts';

export interface Split { cacheRead: number; cacheWrite: number; output: number; input: number }

export const emptySplit = (): Split => ({ cacheRead: 0, cacheWrite: 0, output: 0, input: 0 });

export function addSplit(into: Split, add: Split): void {
  into.cacheRead += add.cacheRead;
  into.cacheWrite += add.cacheWrite;
  into.output += add.output;
  into.input += add.input;
}

export const splitTotal = (s: Split) => s.cacheRead + s.cacheWrite + s.output + s.input;

export const turnTokens = (turn: Turn): Split =>
  ({ cacheRead: turn.cacheRead, cacheWrite: turn.write5m + turn.write1h, output: turn.output, input: turn.input });

// Dollars at API list prices, or null when the model has no known price.
export function turnCost(turn: Turn): Split | null {
  const prompt = turn.input + turn.write5m + turn.write1h + turn.cacheRead;
  const p = priceFor(turn.model, prompt);
  if (!p) return null;
  const perToken = 1e-6;
  return {
    cacheRead: turn.cacheRead * p.read * perToken,
    cacheWrite: (turn.write5m * p.write5m + turn.write1h * p.write1h) * perToken,
    output: turn.output * p.output * perToken,
    input: turn.input * p.input * perToken,
  };
}
