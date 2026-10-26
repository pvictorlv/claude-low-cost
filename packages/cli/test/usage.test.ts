import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PricingTable } from "@lcc/core";
import { buildReport } from "../src/usage/aggregate.js";
import { discoverTranscripts, parseTranscript, type TranscriptSource } from "../src/usage/parse.js";

const pricing: PricingTable = {
  asOf: "test",
  defaults: { cacheWrite5mMultiplier: 1.25, cacheWrite1hMultiplier: 2, cacheReadMultiplier: 0.1 },
  models: [
    { match: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.2 },
    { match: "claude-haiku-5-5", input: 0.1, output: 0.5 },
  ],
};

const main: TranscriptSource = { path: "x", project: "proj", sessionId: "s1", agentId: null, agentType: "main" };

function assistant(requestId: string, model: string, content: unknown[], usage: object, ts = "2026-10-01T10:00:00Z") {
  return JSON.stringify({ type: "assistant", requestId, timestamp: ts, message: { id: `m-${requestId}`, model, content, usage } });
}

function toolResult(id: string, content: unknown, ts = "2026-10-01T10:00:01Z") {
  return JSON.stringify({
    type: "user",
    timestamp: ts,
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  });
}

const U = (output: number) => ({
  input_tokens: 10,
  output_tokens: output,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 500,
  cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 },
});

describe("parseTranscript", () => {
  it("keeps one usage per request even when the response spans several records", () => {
    const text = [
      assistant("r1", "claude-opus-5-5", [{ type: "thinking" }], U(5)),
      assistant("r1", "claude-opus-5-5", [{ type: "tool_use", id: "t1", name: "Read", input: {} }], U(42)),
      "",
    ].join("\n");
    const { usage } = parseTranscript(main, text);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usage).toEqual({ input: 10, output: 42, cacheRead: 1000, cacheWrite5m: 200, cacheWrite1h: 300 });
  });

  it("bills an unsplit cache write as 5-minute TTL", () => {
    const { usage } = parseTranscript(
      main,
      assistant("r1", "claude-opus-5-5", [], { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 700 }),
    );
    expect(usage[0]!.usage.cacheWrite5m).toBe(700);
    expect(usage[0]!.usage.cacheWrite1h).toBe(0);
  });

  it("attributes tool results to the tool that produced them", () => {
    const text = [
      assistant("r1", "claude-opus-5-5", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }], U(1)),
      toolResult("t1", "x".repeat(400)),
      toolResult("t-missing", [{ type: "text", text: "abcd" }, { type: "image" }]),
    ].join("\n");
    const { toolOutputs } = parseTranscript(main, text);
    expect(toolOutputs.map((t) => [t.tool, t.chars])).toEqual([
      ["Bash", 400],
      ["unknown", 4],
    ]);
  });

  it("skips synthetic messages, counts malformed lines, and labels inlined sidechains", () => {
    const sidechain = JSON.parse(assistant("r2", "claude-haiku-5-5", [], U(1)));
    sidechain.isSidechain = true;
    const text = [
      assistant("r0", "<synthetic>", [], U(1)),
      JSON.stringify(sidechain),
      '{"type":"assistant", truncated',
    ].join("\n");
    const parsed = parseTranscript(main, text);
    expect(parsed.badLines).toBe(1);
    expect(parsed.usage.map((u) => u.agentType)).toEqual(["unknown-subagent"]);
  });
});

describe("discoverTranscripts", () => {
  it("finds main and subagent transcripts and reads the subagent type", () => {
    const root = mkdtempSync(join(tmpdir(), "lcc-"));
    const sub = join(root, "projA", "sess1", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, "projA", "sess1.jsonl"), "");
    writeFileSync(join(sub, "agent-abc.jsonl"), "");
    writeFileSync(join(sub, "agent-abc.meta.json"), JSON.stringify({ agentType: "Explore" }));
    writeFileSync(join(sub, "agent-def.jsonl"), "");

    const found = discoverTranscripts(root)
      .map((s) => `${s.sessionId}|${s.agentId}|${s.agentType}`)
      .sort();
    expect(found).toEqual(["sess1|abc|Explore", "sess1|def|unknown-subagent", "sess1|null|main"]);
  });
});

describe("buildReport", () => {
  const mainText = [
    assistant("r1", "claude-opus-5-5", [], { input_tokens: 1_000_000, output_tokens: 0 }, "2026-09-30T00:00:00Z"),
    assistant("r2", "claude-opus-5-5", [], { input_tokens: 0, output_tokens: 1_000_000 }, "2026-10-02T00:00:00Z"),
    assistant("r9", "gpt-x", [], { input_tokens: 5, output_tokens: 5 }, "2026-10-02T00:00:00Z"),
  ].join("\n");
  const subText = assistant("r3", "claude-haiku-5-5", [], { input_tokens: 0, output_tokens: 1_000_000 }, "2026-10-03T00:00:00Z");

  const a = parseTranscript(main, mainText);
  const b = parseTranscript({ ...main, agentId: "x", agentType: "Explore" }, subText);
  // The same request seen twice (old format duplicates) must count once.
  const events = [...a.usage, ...b.usage, ...b.usage];

  it("totals, splits by agent type and reports unpriced models", () => {
    const r = buildReport(events, [], pricing, {}, 10);
    expect(r.totals.requests).toBe(4);
    expect(r.totals.usd).toBeCloseTo(4 + 20 + 0.5);
    expect(r.totals.unpricedModels).toEqual(["gpt-x"]);
    expect(r.totals.usdByClass.input).toBeCloseTo(4);
    expect(r.totals.usdByClass.output).toBeCloseTo(20.5);
    expect(r.totals.usdByClass.cacheRead).toBe(0);
    expect(r.byAgentType.map((x) => [x.key, Number(x.usd.toFixed(2))])).toEqual([
      ["main", 24],
      ["Explore", 0.5],
    ]);
    expect(r.byMonth.map((x) => x.key)).toEqual(["2026-09", "2026-10"]);
  });

  it("profiles baseline and growth of the prompt per transcript", () => {
    const req = (id: string, ts: string, cacheRead: number, write: number) =>
      assistant(id, "claude-opus-5-5", [], { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: write }, ts);
    // Baseline 60k on the first request, growing to 100k.
    const text = [
      req("p1", "2026-10-01T00:00:00Z", 0, 60_000),
      req("p2", "2026-10-01T00:01:00Z", 60_000, 20_000),
      req("p3", "2026-10-01T00:02:00Z", 80_000, 20_000),
    ].join("\n");
    const parsed = parseTranscript({ ...main, path: "t1" }, text);
    const r = buildReport(parsed.usage, [], pricing, {}, 10);
    expect(r.contextProfile).toEqual([
      {
        key: "main",
        transcripts: 1,
        baselineTokens: 60_000,
        peakTokens: 100_000,
        requests: 3,
        // 60k of the 140k cache-read tokens re-read the baseline.
        baselineReadShare: 120_000 / 140_000,
      },
    ]);
  });

  it("applies --since and --project filters", () => {
    expect(buildReport(events, [], pricing, { since: "2026-10-01" }, 10).totals.usd).toBeCloseTo(20.5);
    expect(buildReport(events, [], pricing, { project: "other" }, 10).totals.requests).toBe(0);
  });
});
