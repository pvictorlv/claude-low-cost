import { describe, expect, it } from "vitest";
import { emptyUsage, type PricingTable, type TokenUsage } from "@lcc/core";
import { buildScenarios, parseTarget } from "../src/usage/command.js";
import type { UsageEvent } from "../src/usage/parse.js";
import { simulate } from "../src/usage/whatif.js";

const pricing: PricingTable = {
  asOf: "test",
  defaults: { cacheWrite5mMultiplier: 1.25, cacheWrite1hMultiplier: 2, cacheReadMultiplier: 0.1 },
  models: [
    // Round numbers: cache read $1/M, write 5m $12.5/M, output $100/M.
    { match: "big", input: 10, output: 100, cacheRead: 1 },
    { match: "small", input: 1, output: 10, cacheRead: 0.1 },
  ],
};

const M = 1_000_000;

function ev(agentType: string, usage: Partial<TokenUsage>, model = "big"): UsageEvent {
  return {
    requestId: `${agentType}-${Math.random()}`,
    transcript: "t",
    project: "p",
    sessionId: "s",
    agentType,
    model,
    timestamp: "2026-10-01T00:00:00Z",
    speed: undefined,
    usage: { ...emptyUsage(), ...usage },
  };
}

describe("simulate", () => {
  it("cutBaseline removes re-read tokens, and written tokens when nothing was cached", () => {
    const events = [ev("main", { cacheWrite5m: M }), ev("main", { cacheRead: 3 * M })];
    const r = simulate(events, pricing, { name: "x", cutBaseline: { tokens: M / 2, agents: /.*/ } });
    expect(r.beforeUsd).toBeCloseTo(12.5 + 3);
    expect(r.afterUsd).toBeCloseTo(6.25 + 2.5);
    expect(r.affectedRequests).toBe(2);
  });

  it("cutBaseline never removes more than the transcript's first prompt", () => {
    const small = (u: Partial<TokenUsage>, ts: string) => ({ ...ev("main", u), transcript: "small", timestamp: ts });
    // Baseline is 0.2M, so a 0.5M cut only takes 0.2M off each request.
    const events = [small({ cacheWrite5m: M / 5 }, "2026-10-01T00:00:00Z"), small({ cacheRead: M }, "2026-10-01T00:01:00Z")];
    const r = simulate(events, pricing, { name: "x", cutBaseline: { tokens: M / 2, agents: /.*/ } });
    expect(r.afterUsd).toBeCloseTo(0 + 0.8);
  });

  it("capContext trims cache reads above the cap and leaves smaller prompts alone", () => {
    const events = [ev("main", { cacheRead: 3 * M }), ev("main", { cacheRead: M / 2 })];
    const r = simulate(events, pricing, { name: "x", capContext: { tokens: M, agents: /^main$/ } });
    expect(r.afterUsd).toBeCloseTo(1 + 0.5);
    expect(r.affectedRequests).toBe(1);
  });

  it("swapModel re-prices only the matching agent types", () => {
    const events = [ev("publish-1", { output: M }), ev("main", { output: M })];
    const r = simulate(events, pricing, { name: "x", swapModel: { model: "small", agents: /^publish-/ } });
    expect(r.beforeUsd).toBeCloseTo(200);
    expect(r.afterUsd).toBeCloseTo(110);
    expect(r.savedShare).toBeCloseTo(0.45);
  });
});

describe("flag parsing", () => {
  it("splits value and regex, defaulting the regex to everything", () => {
    expect(parseTarget("40k", "--x").agents.source).toBe(".*");
    const t = parseTarget("small@^(run|publish)-", "--x");
    expect(t.value).toBe("small");
    expect(t.agents.test("publish-12")).toBe(true);
  });

  it("rejects bad input with the flag name", () => {
    expect(() => parseTarget("small", "--swap-model", true)).toThrow(/--swap-model/);
    expect(() => parseTarget("1@(", "--cap-context")).toThrow(/invalid regex/);
    expect(() => buildScenarios({ cutBaseline: ["lots"] }, pricing)).toThrow(/positive token count/);
    expect(() => buildScenarios({ swapModel: ["gpt@.*"] }, pricing)).toThrow(/not in pricing/);
  });

  it("adds a combined scenario when more than one is given", () => {
    const s = buildScenarios({ cutBaseline: ["40k"], swapModel: ["small@^run-"] }, pricing);
    expect(s.map((x) => x.name)).toEqual(["cut baseline 40k", "swap model small@^run-", "combined (first of each kind)"]);
    expect(s[0]!.cutBaseline!.tokens).toBe(40_000);
  });
});
