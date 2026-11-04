// Anthropic API list prices in $ per million tokens.
// Source: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-03).
// Cache reads are NOT always 0.1x input: Fable 5.1 is 0.025x, Opus 5.5 and Sonnet 5.5 are 0.05x.
export interface Price { input: number; write5m: number; write1h: number; read: number; output: number }

const price = (input: number, write5m: number, write1h: number, read: number, output: number): Price =>
  ({ input, write5m, write1h, read, output });

const OPUS_4_5_TO_5 = price(5, 6.25, 10, 0.5, 25);
const OPUS_4_EARLY = price(15, 18.75, 30, 1.5, 75);
const SONNET_4 = price(3, 3.75, 6, 0.3, 15);

export const PRICES: Readonly<Record<string, Price>> = {
  'claude-fable-5-1': price(10, 12.5, 20, 0.25, 50),
  'claude-fable-5': price(10, 12.5, 20, 1, 50),
  'claude-opus-5-5': price(4, 5, 8, 0.2, 20),
  'claude-opus-5': OPUS_4_5_TO_5,
  'claude-opus-4-8': OPUS_4_5_TO_5,
  'claude-opus-4-7': OPUS_4_5_TO_5,
  'claude-opus-4-6': OPUS_4_5_TO_5,
  'claude-opus-4-5': OPUS_4_5_TO_5,
  'claude-opus-4-1': OPUS_4_EARLY,
  'claude-opus-4': OPUS_4_EARLY,
  'claude-sonnet-5-5': price(2, 2.5, 4, 0.1, 10),
  'claude-sonnet-5': price(2, 2.5, 4, 0.2, 10),
  'claude-sonnet-4-6': SONNET_4,
  'claude-sonnet-4-5': SONNET_4,
  'claude-sonnet-4': SONNET_4,
  'claude-haiku-5-5': price(0.1, 0.125, 0.2, 0.01, 0.5),
  'claude-haiku-4-5': price(1, 1.25, 2, 0.1, 5),
};

// Haiku 5.5 charges the whole request at higher rates once its prompt passes 100k tokens.
const HAIKU_5_5_LONG = price(0.5, 0.625, 1, 0.05, 2.5);
const HAIKU_5_5_LONG_ABOVE = 100_000;

// "claude-haiku-4-5-20251001" -> "claude-haiku-4-5"
export const modelKey = (model: string) => model.replace(/-\d{8}$/, '');

export function priceFor(model: string, promptTokens: number): Price | undefined {
  const key = modelKey(model);
  if (key === 'claude-haiku-5-5' && promptTokens > HAIKU_5_5_LONG_ABOVE) return HAIKU_5_5_LONG;
  return PRICES[key];
}
