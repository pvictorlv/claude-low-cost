import { costOf, type PricingTable, type TokenUsage } from "@lcc/core";
import type { UsageEvent } from "./parse.js";

/**
 * Re-prices recorded requests under a change, without running anything. The
 * models are deliberately simple, so read the results as orders of magnitude:
 *
 * - cutBaseline: every request re-reads N fewer prefix tokens (smaller tool
 *   schemas, CLAUDE.md, skills). The first request, which has nothing cached
 *   yet, writes N fewer instead. N is capped at the transcript's own baseline
 *   (its first prompt), since a cut can't remove more than was there.
 * - capContext: no prompt exceeds N tokens, as if compaction or /clear kept it
 *   there. Ignores the cost of the compaction call and the re-reads it causes,
 *   so it is optimistic.
 * - swapModel: requests from matching agent types are billed at another model's
 *   rates with the same token counts. Says nothing about whether the cheaper
 *   model can do the job; that needs a quality check.
 */
export interface Scenario {
  name: string;
  cutBaseline?: { tokens: number; agents: RegExp };
  capContext?: { tokens: number; agents: RegExp };
  swapModel?: { model: string; agents: RegExp };
}

export interface ScenarioResult {
  name: string;
  beforeUsd: number;
  afterUsd: number;
  savedUsd: number;
  savedShare: number;
  affectedRequests: number;
}

const promptOf = (u: TokenUsage) => u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;

function cutBaseline(u: TokenUsage, tokens: number): TokenUsage {
  const out = { ...u };
  const fromRead = Math.min(out.cacheRead, tokens);
  out.cacheRead -= fromRead;
  let rest = tokens - fromRead;
  // Nothing (or not enough) cached yet: the prefix was being written instead.
  const from1h = Math.min(out.cacheWrite1h, rest);
  out.cacheWrite1h -= from1h;
  rest -= from1h;
  out.cacheWrite5m -= Math.min(out.cacheWrite5m, rest);
  return out;
}

function capContext(u: TokenUsage, tokens: number): TokenUsage {
  const excess = promptOf(u) - tokens;
  if (excess <= 0) return u;
  return { ...u, cacheRead: Math.max(0, u.cacheRead - excess) };
}

/** Prompt size of each transcript's first request — the most a baseline cut can remove there. */
function baselines(events: UsageEvent[]): Map<string, number> {
  const first = new Map<string, UsageEvent>();
  for (const e of events) {
    const seen = first.get(e.transcript);
    if (!seen || e.timestamp < seen.timestamp) first.set(e.transcript, e);
  }
  return new Map([...first].map(([t, e]) => [t, promptOf(e.usage)]));
}

export function simulate(events: UsageEvent[], pricing: PricingTable, scenario: Scenario): ScenarioResult {
  const baselineOf = scenario.cutBaseline ? baselines(events) : new Map<string, number>();
  let before = 0;
  let after = 0;
  let affected = 0;

  for (const e of events) {
    const base = costOf(pricing, e.model, e.usage, e.speed);
    if (base === undefined) continue;
    before += base;

    let usage = e.usage;
    let model = e.model;
    let touched = false;
    if (scenario.cutBaseline?.agents.test(e.agentType)) {
      const cap = baselineOf.get(e.transcript) ?? scenario.cutBaseline.tokens;
      usage = cutBaseline(usage, Math.min(scenario.cutBaseline.tokens, cap));
      touched = true;
    }
    if (scenario.capContext?.agents.test(e.agentType)) {
      const capped = capContext(usage, scenario.capContext.tokens);
      touched ||= capped !== usage;
      usage = capped;
    }
    if (scenario.swapModel?.agents.test(e.agentType)) {
      model = scenario.swapModel.model;
      touched = true;
    }
    if (touched) affected++;
    after += costOf(pricing, model, usage, e.speed) ?? base;
  }

  return {
    name: scenario.name,
    beforeUsd: before,
    afterUsd: after,
    savedUsd: before - after,
    savedShare: before > 0 ? (before - after) / before : 0,
    affectedRequests: affected,
  };
}
