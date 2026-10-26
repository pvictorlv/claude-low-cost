import {
  addUsage,
  costBreakdown,
  emptyUsage,
  type CostBreakdown,
  type PricingTable,
  type TokenUsage,
} from "@lcc/core";
import type { ToolOutputEvent, UsageEvent } from "./parse.js";

export interface CostRow {
  key: string;
  requests: number;
  usd: number;
  /** Fraction of the priced total, 0..1. */
  share: number;
  usage: TokenUsage;
}

export interface ToolRow {
  /** `<agentType> / <tool>` — the same tool costs differently in the main thread and in a subagent. */
  key: string;
  calls: number;
  /** chars / 4. Rough, but the ranking is what matters here, not the exact count. */
  estTokens: number;
  maxEstTokens: number;
}

export interface UsageReport {
  pricingAsOf: string;
  totals: {
    requests: number;
    usd: number;
    /** Where the dollars go by token class — tells you whether to cut turns, context, or output. */
    usdByClass: CostBreakdown;
    unpricedRequests: number;
    unpricedModels: string[];
    usage: TokenUsage;
  };
  byAgentType: CostRow[];
  byModel: CostRow[];
  byProject: CostRow[];
  byMonth: CostRow[];
  topSessions: CostRow[];
  topTools: ToolRow[];
  contextProfile: ContextRow[];
}

/**
 * How big the prompt is per agent type, split into the part paid before any work
 * happens (baseline) and how far it grows. Medians across transcripts.
 */
export interface ContextRow {
  key: string;
  transcripts: number;
  /** First request's prompt: system prompt + tool schemas + CLAUDE.md/skills + the task. */
  baselineTokens: number;
  /** Largest prompt reached in the transcript. */
  peakTokens: number;
  requests: number;
  /** Share of this agent type's cache-read dollars spent re-reading the baseline. */
  baselineReadShare: number;
}

export interface UsageFilter {
  /** Inclusive, compared against the record's ISO timestamp. */
  since?: string;
  project?: string;
}

const CHARS_PER_TOKEN = 4;

export function matchesFilter(e: { timestamp: string; project: string }, f: UsageFilter): boolean {
  if (f.since && e.timestamp < f.since) return false;
  if (f.project && !e.project.toLowerCase().includes(f.project.toLowerCase())) return false;
  return true;
}

/** Applies the filter and drops repeats: old transcript formats can hold the same request in two files. */
export function selectEvents(events: UsageEvent[], filter: UsageFilter): UsageEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (!matchesFilter(e, filter) || seen.has(e.requestId)) return false;
    seen.add(e.requestId);
    return true;
  });
}

const promptOf = (u: TokenUsage) => u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function contextProfile(events: UsageEvent[]): ContextRow[] {
  const byTranscript = new Map<string, UsageEvent[]>();
  for (const e of events) {
    const list = byTranscript.get(e.transcript) ?? [];
    list.push(e);
    byTranscript.set(e.transcript, list);
  }

  const perAgent = new Map<
    string,
    { baseline: number[]; peak: number[]; requests: number[]; baselineReads: number; reads: number }
  >();
  for (const list of byTranscript.values()) {
    list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const baseline = promptOf(list[0]!.usage);
    const agent = list[0]!.agentType;
    const acc = perAgent.get(agent) ?? { baseline: [], peak: [], requests: [], baselineReads: 0, reads: 0 };
    acc.baseline.push(baseline);
    acc.peak.push(Math.max(...list.map((e) => promptOf(e.usage))));
    acc.requests.push(list.length);
    for (const e of list) {
      acc.reads += e.usage.cacheRead;
      // A request re-reads at most the baseline's worth of the cached prefix.
      acc.baselineReads += Math.min(e.usage.cacheRead, baseline);
    }
    perAgent.set(agent, acc);
  }

  return [...perAgent.entries()]
    .map(([key, a]) => ({
      key,
      transcripts: a.baseline.length,
      baselineTokens: median(a.baseline),
      peakTokens: median(a.peak),
      requests: median(a.requests),
      baselineReadShare: a.reads > 0 ? a.baselineReads / a.reads : 0,
    }))
    .sort((x, y) => y.transcripts - x.transcripts);
}

function group(
  events: Array<UsageEvent & { usd: number }>,
  keyOf: (e: UsageEvent) => string,
  total: number,
): CostRow[] {
  const rows = new Map<string, CostRow>();
  for (const e of events) {
    const key = keyOf(e);
    let row = rows.get(key);
    if (!row) {
      row = { key, requests: 0, usd: 0, share: 0, usage: emptyUsage() };
      rows.set(key, row);
    }
    row.requests++;
    row.usd += e.usd;
    addUsage(row.usage, e.usage);
  }
  for (const row of rows.values()) row.share = total > 0 ? row.usd / total : 0;
  return [...rows.values()].sort((a, b) => b.usd - a.usd);
}

export function buildReport(
  usageEvents: UsageEvent[],
  toolEvents: ToolOutputEvent[],
  pricing: PricingTable,
  filter: UsageFilter,
  top: number,
): UsageReport {
  const priced: Array<UsageEvent & { usd: number }> = [];
  const unpricedModels = new Set<string>();
  const totalUsage = emptyUsage();
  const usdByClass = emptyUsage();
  let unpricedRequests = 0;
  let requests = 0;

  for (const e of selectEvents(usageEvents, filter)) {
    requests++;
    addUsage(totalUsage, e.usage);
    const cost = costBreakdown(pricing, e.model, e.usage, e.speed);
    if (cost === undefined) {
      unpricedRequests++;
      unpricedModels.add(e.model);
      continue;
    }
    addUsage(usdByClass, cost);
    priced.push({ ...e, usd: cost.input + cost.output + cost.cacheRead + cost.cacheWrite5m + cost.cacheWrite1h });
  }

  const total = priced.reduce((sum, e) => sum + e.usd, 0);

  const tools = new Map<string, ToolRow>();
  for (const t of toolEvents) {
    if (!matchesFilter(t, filter)) continue;
    const key = `${t.agentType} / ${t.tool}`;
    const est = Math.ceil(t.chars / CHARS_PER_TOKEN);
    const row = tools.get(key) ?? { key, calls: 0, estTokens: 0, maxEstTokens: 0 };
    row.calls++;
    row.estTokens += est;
    row.maxEstTokens = Math.max(row.maxEstTokens, est);
    tools.set(key, row);
  }

  return {
    pricingAsOf: pricing.asOf,
    totals: {
      requests,
      usd: total,
      usdByClass,
      unpricedRequests,
      unpricedModels: [...unpricedModels].sort(),
      usage: totalUsage,
    },
    byAgentType: group(priced, (e) => e.agentType, total),
    byModel: group(priced, (e) => e.model, total),
    byProject: group(priced, (e) => e.project, total).slice(0, top),
    byMonth: group(priced, (e) => e.timestamp.slice(0, 7), total).sort((a, b) => a.key.localeCompare(b.key)),
    topSessions: group(priced, (e) => `${e.project} :: ${e.sessionId}`, total).slice(0, top),
    topTools: [...tools.values()].sort((a, b) => b.estTokens - a.estTokens).slice(0, top),
    contextProfile: contextProfile(priced).slice(0, top),
  };
}
