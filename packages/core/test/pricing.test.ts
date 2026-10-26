import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { costOf, emptyUsage, findModelPrice, loadPricing, type PricingTable } from "../src/pricing.js";

const table: PricingTable = {
  asOf: "test",
  defaults: { cacheWrite5mMultiplier: 1.25, cacheWrite1hMultiplier: 2, cacheReadMultiplier: 0.1 },
  models: [
    { match: "claude-opus-5", input: 5, output: 25, fastMultiplier: 2 },
    { match: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.2, fastMultiplier: 2 },
    {
      match: "claude-haiku-5-5",
      input: 0.1,
      output: 0.5,
      longContext: { abovePromptTokens: 100_000, input: 0.5, output: 2.5 },
    },
  ],
};

const M = 1_000_000;

describe("findModelPrice", () => {
  it("prefers the longest matching prefix", () => {
    expect(findModelPrice(table, "claude-opus-5-5")?.input).toBe(4);
    expect(findModelPrice(table, "claude-opus-5")?.input).toBe(5);
  });

  it("matches dated ids by prefix and returns undefined for unknown models", () => {
    expect(findModelPrice(table, "claude-opus-5-20260101")?.input).toBe(5);
    expect(findModelPrice(table, "gpt-4")).toBeUndefined();
  });
});

describe("costOf", () => {
  it("bills each token class at its own rate", () => {
    const usage = { input: M, output: M, cacheRead: M, cacheWrite5m: M, cacheWrite1h: M };
    // 4 + 20 + 0.2 + 4*1.25 + 4*2
    expect(costOf(table, "claude-opus-5-5", usage)).toBeCloseTo(37.2);
  });

  it("falls back to the default cache-read multiplier", () => {
    expect(costOf(table, "claude-opus-5", { ...emptyUsage(), cacheRead: M })).toBeCloseTo(0.5);
  });

  it("applies the fast multiplier only for fast requests", () => {
    const usage = { ...emptyUsage(), output: M };
    expect(costOf(table, "claude-opus-5-5", usage, "standard")).toBeCloseTo(20);
    expect(costOf(table, "claude-opus-5-5", usage, "fast")).toBeCloseTo(40);
  });

  it("switches to long-context rates above the prompt threshold", () => {
    const short = { ...emptyUsage(), input: 50_000, output: M };
    const long = { ...emptyUsage(), input: 50_000, cacheRead: 60_000, output: M };
    expect(costOf(table, "claude-haiku-5-5", short)).toBeCloseTo(0.005 + 0.5);
    expect(costOf(table, "claude-haiku-5-5", long)).toBeCloseTo(0.025 + 0.003 + 2.5);
  });

  it("returns undefined for unpriced models", () => {
    expect(costOf(table, "mystery", emptyUsage())).toBeUndefined();
  });
});

describe("config/pricing.json", () => {
  it("passes the schema", () => {
    const path = fileURLToPath(new URL("../../../config/pricing.json", import.meta.url));
    expect(loadPricing(path).models.length).toBeGreaterThan(0);
  });
});
