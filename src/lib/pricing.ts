import type Anthropic from '@anthropic-ai/sdk';

/**
 * Anthropic API prices in USD per million tokens. Cache writes cost 1.25x the
 * input rate, cache reads 0.1x. Prices change over time — this is an estimate.
 */
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
};

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
};

/** Cost of one API response's usage for the given model, in USD. */
export function costOfUsage(usage: Anthropic.Usage, model: string): number {
  const price = PRICES_PER_MTOK[model];
  if (!price) return 0;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return (
    (input * price.input +
      cacheWrite * price.input * 1.25 +
      cacheRead * price.input * 0.1 +
      output * price.output) /
    1_000_000
  );
}

export function addUsage(totals: UsageTotals, usage: Anthropic.Usage, model: string): UsageTotals {
  return {
    inputTokens: totals.inputTokens + (usage.input_tokens ?? 0),
    outputTokens: totals.outputTokens + (usage.output_tokens ?? 0),
    cacheWriteTokens: totals.cacheWriteTokens + (usage.cache_creation_input_tokens ?? 0),
    cacheReadTokens: totals.cacheReadTokens + (usage.cache_read_input_tokens ?? 0),
    costUsd: totals.costUsd + costOfUsage(usage, model),
  };
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `<$0.01`;
  return `$${usd.toFixed(2)}`;
}
