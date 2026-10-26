import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPricing } from "@lcc/core";
import { buildReport, type UsageFilter } from "./aggregate.js";
import { discoverTranscripts, parseTranscript, type ToolOutputEvent, type UsageEvent } from "./parse.js";
import { renderReport } from "./render.js";

export interface UsageOptions {
  root?: string | undefined;
  pricing?: string | undefined;
  since?: string | undefined;
  project?: string | undefined;
  top?: number | undefined;
  json?: boolean | undefined;
}

const DEFAULT_PRICING = fileURLToPath(new URL("../../../../config/pricing.json", import.meta.url));

export function runUsage(opts: UsageOptions): string {
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
    `[lcc usage] ${sources.length} transcripts, ${unreadable} unreadable, ${badLines} malformed lines skipped\n`,
  );

  const report = buildReport(usage, tools, pricing, filter, opts.top ?? 15);
  return opts.json ? JSON.stringify(report, null, 2) + "\n" : renderReport(report);
}
