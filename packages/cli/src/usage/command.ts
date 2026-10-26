import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findModelPrice, loadPricing, type PricingTable } from "@lcc/core";
import { buildReport, selectEvents, type UsageFilter } from "./aggregate.js";
import { discoverTranscripts, parseTranscript, type ToolOutputEvent, type UsageEvent } from "./parse.js";
import { renderReport, renderWhatIf } from "./render.js";
import { simulate, type Scenario } from "./whatif.js";

export interface SourceOptions {
  root?: string | undefined;
  pricing?: string | undefined;
  since?: string | undefined;
  project?: string | undefined;
}

export interface UsageOptions extends SourceOptions {
  top?: number | undefined;
  json?: boolean | undefined;
}

export interface WhatIfOptions extends SourceOptions {
  /** Each `<tokens>[@<agent regex>]`. */
  cutBaseline?: string[] | undefined;
  /** Each `<tokens>[@<agent regex>]`. */
  capContext?: string[] | undefined;
  /** Each `<model id>@<agent regex>`. */
  swapModel?: string[] | undefined;
  json?: boolean | undefined;
}

const DEFAULT_PRICING = fileURLToPath(new URL("../../../../config/pricing.json", import.meta.url));

interface Loaded {
  pricing: PricingTable;
  filter: UsageFilter;
  usage: UsageEvent[];
  tools: ToolOutputEvent[];
}

function load(opts: SourceOptions, label: string): Loaded {
  const root = opts.root ?? join(homedir(), ".claude", "projects");
  const pricing = loadPricing(opts.pricing ?? DEFAULT_PRICING);
  const filter: UsageFilter = {};
  if (opts.since) filter.since = opts.since;
  if (opts.project) filter.project = opts.project;

  const usage: UsageEvent[] = [];
  const tools: ToolOutputEvent[] = [];
  let badLines = 0;
  let unreadable = 0;

  const sources = discoverTranscripts(root);
  for (const source of sources) {
    let text: string;
    try {
      text = readFileSync(source.path, "utf8");
    } catch {
      unreadable++;
      continue;
    }
    const parsed = parseTranscript(source, text);
    usage.push(...parsed.usage);
    tools.push(...parsed.toolOutputs);
    badLines += parsed.badLines;
  }

  // Diagnostics go to stderr so `--json` output stays machine-readable.
  process.stderr.write(
    `[lcc ${label}] ${sources.length} transcripts, ${unreadable} unreadable, ${badLines} malformed lines skipped\n`,
  );
  return { pricing, filter, usage, tools };
}

export function runUsage(opts: UsageOptions): string {
  const { pricing, filter, usage, tools } = load(opts, "usage");
  const report = buildReport(usage, tools, pricing, filter, opts.top ?? 15);
  return opts.json ? JSON.stringify(report, null, 2) + "\n" : renderReport(report);
}

/** Splits `<value>@<regex>`; the regex is optional unless `requireRegex`. */
export function parseTarget(raw: string, flag: string, requireRegex = false): { value: string; agents: RegExp } {
  const at = raw.indexOf("@");
  if (at === -1 && requireRegex) throw new Error(`${flag} expects <value>@<agent regex>, got "${raw}"`);
  const value = at === -1 ? raw : raw.slice(0, at);
  const pattern = at === -1 ? ".*" : raw.slice(at + 1);
  try {
    return { value, agents: new RegExp(pattern) };
  } catch {
    throw new Error(`${flag}: invalid regex "${pattern}"`);
  }
}

function parseTokens(value: string, flag: string): number {
  const n = Number.parseInt(value.replace(/k$/i, "000"), 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag}: "${value}" is not a positive token count`);
  return n;
}

export function buildScenarios(opts: WhatIfOptions, pricing: PricingTable): Scenario[] {
  const scenarios: Scenario[] = [];
  for (const raw of opts.cutBaseline ?? []) {
    const t = parseTarget(raw, "--cut-baseline");
    scenarios.push({ name: `cut baseline ${raw}`, cutBaseline: { tokens: parseTokens(t.value, "--cut-baseline"), agents: t.agents } });
  }
  for (const raw of opts.capContext ?? []) {
    const t = parseTarget(raw, "--cap-context");
    scenarios.push({ name: `cap context ${raw}`, capContext: { tokens: parseTokens(t.value, "--cap-context"), agents: t.agents } });
  }
  for (const raw of opts.swapModel ?? []) {
    const t = parseTarget(raw, "--swap-model", true);
    if (!findModelPrice(pricing, t.value)) throw new Error(`--swap-model: "${t.value}" is not in pricing.json`);
    scenarios.push({ name: `swap model ${raw}`, swapModel: { model: t.value, agents: t.agents } });
  }
  if (scenarios.length > 1) {
    // One of each kind, so the combined line stays well defined.
    const combined: Scenario = { name: "combined (first of each kind)" };
    const cut = scenarios.find((s) => s.cutBaseline)?.cutBaseline;
    const cap = scenarios.find((s) => s.capContext)?.capContext;
    const swap = scenarios.find((s) => s.swapModel)?.swapModel;
    if (cut) combined.cutBaseline = cut;
    if (cap) combined.capContext = cap;
    if (swap) combined.swapModel = swap;
    scenarios.push(combined);
  }
  return scenarios;
}

export function runWhatIf(opts: WhatIfOptions): string {
  const { pricing, filter, usage } = load(opts, "whatif");
  const scenarios = buildScenarios(opts, pricing);
  if (scenarios.length === 0) throw new Error("whatif needs at least one of --cut-baseline, --cap-context, --swap-model");
  const events = selectEvents(usage, filter);
  const results = scenarios.map((s) => simulate(events, pricing, s));
  return opts.json ? JSON.stringify(results, null, 2) + "\n" : renderWhatIf(results);
}
