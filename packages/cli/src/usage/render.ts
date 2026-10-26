import type { CostRow, ToolRow, UsageReport } from "./aggregate.js";

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const mtok = (n: number) => `${(n / 1_000_000).toFixed(2)}M`;

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

const promptTokens = (r: CostRow) =>
  r.usage.input + r.usage.cacheRead + r.usage.cacheWrite5m + r.usage.cacheWrite1h;

function costTable(title: string, rows: CostRow[]): string {
  const body = rows.map((r) => [
    r.key,
    String(r.requests),
    usd(r.usd),
    pct(r.share),
    mtok(r.usage.input + r.usage.cacheWrite5m + r.usage.cacheWrite1h),
    mtok(r.usage.cacheRead),
    mtok(r.usage.output),
    // Average prompt size per request: the context every turn pays to re-read.
    `${Math.round(promptTokens(r) / Math.max(r.requests, 1) / 1000)}k`,
  ]);
  return `## ${title}\n${table(["key", "reqs", "usd", "share", "in+write", "cache read", "out", "avg ctx"], body)}`;
}

function classTable(r: UsageReport): string {
  const t = r.totals;
  const classes: Array<[string, number, number]> = [
    ["cache read (context re-read every turn)", t.usdByClass.cacheRead, t.usage.cacheRead],
    ["cache write 5m", t.usdByClass.cacheWrite5m, t.usage.cacheWrite5m],
    ["cache write 1h", t.usdByClass.cacheWrite1h, t.usage.cacheWrite1h],
    ["output", t.usdByClass.output, t.usage.output],
    ["uncached input", t.usdByClass.input, t.usage.input],
  ];
  const body = classes
    .sort((a, b) => b[1] - a[1])
    .map(([name, cost, tokens]) => [name, usd(cost), pct(t.usd > 0 ? cost / t.usd : 0), mtok(tokens)]);
  return `## By token class\n${table(["class", "usd", "share", "tokens"], body)}`;
}

function toolTable(rows: ToolRow[]): string {
  const body = rows.map((r) => [
    r.key,
    String(r.calls),
    mtok(r.estTokens),
    String(r.maxEstTokens),
    String(Math.round(r.estTokens / Math.max(r.calls, 1))),
  ]);
  return `## Tool outputs entering context (est. tokens = chars/4)\n${table(
    ["agent / tool", "calls", "est total", "max", "avg"],
    body,
  )}`;
}

export function renderReport(r: UsageReport): string {
  const parts = [
    `# Claude Code usage — API-equivalent cost (pricing as of ${r.pricingAsOf})`,
    `requests: ${r.totals.requests}   total: ${usd(r.totals.usd)}` +
      (r.totals.unpricedRequests
        ? `   UNPRICED: ${r.totals.unpricedRequests} requests (${r.totals.unpricedModels.join(", ")}) — add them to pricing.json`
        : ""),
    classTable(r),
    costTable("By month", r.byMonth),
    costTable("By agent type (main = top-level conversation)", r.byAgentType),
    costTable("By model", r.byModel),
    costTable("By project", r.byProject),
    costTable("Top sessions", r.topSessions),
    toolTable(r.topTools),
  ];
  return parts.join("\n\n") + "\n";
}
