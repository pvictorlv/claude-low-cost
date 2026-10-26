import { readFileSync } from "node:fs";
import { z } from "zod";

const RatesSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
});

const ModelPriceSchema = RatesSchema.extend({
  /** Model id prefix. The longest matching prefix wins, so `claude-opus-5-5` beats `claude-opus-5`. */
  match: z.string().min(1),
  /** Absolute cache-read rate. Falls back to `defaults.cacheReadMultiplier × input`. */
  cacheRead: z.number().nonnegative().optional(),
  /** Applied to every rate when the request ran with `speed: "fast"`. */
  fastMultiplier: z.number().positive().optional(),
  /** Higher rates once the whole prompt (uncached + cache read + cache write) passes a threshold. */
  longContext: RatesSchema.extend({ abovePromptTokens: z.number().int().positive() }).optional(),
});

export const PricingTableSchema = z.object({
  asOf: z.string(),
  defaults: z.object({
    cacheWrite5mMultiplier: z.number().positive(),
    cacheWrite1hMultiplier: z.number().positive(),
    cacheReadMultiplier: z.number().positive(),
  }),
  models: z.array(ModelPriceSchema).min(1),
});

export type PricingTable = z.infer<typeof PricingTableSchema>;
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

/** Token counts for one API request, as reported in `message.usage`. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

export function addUsage(into: TokenUsage, from: TokenUsage): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite5m += from.cacheWrite5m;
  into.cacheWrite1h += from.cacheWrite1h;
}

export function loadPricing(path: string): PricingTable {
  return PricingTableSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function findModelPrice(table: PricingTable, model: string): ModelPrice | undefined {
  let best: ModelPrice | undefined;
  for (const entry of table.models) {
    if (model.startsWith(entry.match) && (!best || entry.match.length > best.match.length)) {
      best = entry;
    }
  }
  return best;
}

/** USD per token class. Same shape as `TokenUsage`, so the two can be added and compared field by field. */
export type CostBreakdown = TokenUsage;

/** Cost in USD per token class, or `undefined` when the model has no price. */
export function costBreakdown(
  table: PricingTable,
  model: string,
  usage: TokenUsage,
  speed?: string,
): CostBreakdown | undefined {
  const price = findModelPrice(table, model);
  if (!price) return undefined;

  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
  const long = price.longContext && promptTokens > price.longContext.abovePromptTokens;
  const input = long ? price.longContext!.input : price.input;
  const output = long ? price.longContext!.output : price.output;
  const cacheRead =
    price.cacheRead !== undefined && !long
      ? price.cacheRead
      : input * table.defaults.cacheReadMultiplier;

  const k = (speed === "fast" ? (price.fastMultiplier ?? 1) : 1) / 1_000_000;
  return {
    input: usage.input * input * k,
    output: usage.output * output * k,
    cacheRead: usage.cacheRead * cacheRead * k,
    cacheWrite5m: usage.cacheWrite5m * input * table.defaults.cacheWrite5mMultiplier * k,
    cacheWrite1h: usage.cacheWrite1h * input * table.defaults.cacheWrite1hMultiplier * k,
  };
}

/** Cost in USD, or `undefined` when the model has no price — callers report those as unpriced. */
export function costOf(
  table: PricingTable,
  model: string,
  usage: TokenUsage,
  speed?: string,
): number | undefined {
  const b = costBreakdown(table, model, usage, speed);
  return b && b.input + b.output + b.cacheRead + b.cacheWrite5m + b.cacheWrite1h;
}
