#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runUsage, runWhatIf } from "./usage/command.js";

const HELP = `lcc — Claude Low Cost

usage:
  lcc usage [source options] [--top N] [--json]
      Where the API money goes, from local Claude Code transcripts.

  lcc whatif [source options] [--cut-baseline <tokens>[@<agent regex>]]...
                              [--cap-context <tokens>[@<agent regex>]]...
                              [--swap-model <model id>@<agent regex>]... [--json]
      Re-prices the recorded requests under a change. Tokens accept a k suffix (40k).
      Examples:
        lcc whatif --cut-baseline 40k
        lcc whatif --cap-context 120k@^main$
        lcc whatif --swap-model "claude-haiku-5-5@^(publish|run|prep)-"

source options:
  --root <dir>         transcripts root (default: ~/.claude/projects)
  --pricing <file>     pricing table (default: config/pricing.json)
  --since YYYY-MM-DD   only requests from this day on
  --project <substr>   only projects whose folder name contains this
`;

const SOURCE_OPTIONS = {
  root: { type: "string" },
  pricing: { type: "string" },
  since: { type: "string" },
  project: { type: "string" },
  json: { type: "boolean" },
} as const;

function checkSince(since: string | undefined): void {
  if (since !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(since)) throw new UsageError("--since must be YYYY-MM-DD");
}

class UsageError extends Error {}

function main(argv: string[]): number {
  const [command, ...rest] = argv;

  if (command === "usage") {
    const { values } = parseArgs({ args: rest, options: { ...SOURCE_OPTIONS, top: { type: "string" } } });
    checkSince(values.since);
    const top = values.top === undefined ? undefined : Number.parseInt(values.top, 10);
    if (top !== undefined && (!Number.isInteger(top) || top <= 0)) throw new UsageError("--top must be a positive integer");
    process.stdout.write(runUsage({ ...values, top }));
    return 0;
  }

  if (command === "whatif") {
    const { values } = parseArgs({
      args: rest,
      options: {
        ...SOURCE_OPTIONS,
        "cut-baseline": { type: "string", multiple: true },
        "cap-context": { type: "string", multiple: true },
        "swap-model": { type: "string", multiple: true },
      },
    });
    checkSince(values.since);
    process.stdout.write(
      runWhatIf({
        ...values,
        cutBaseline: values["cut-baseline"],
        capContext: values["cap-context"],
        swapModel: values["swap-model"],
      }),
    );
    return 0;
  }

  process.stdout.write(HELP);
  return command === undefined || command === "help" || command === "--help" ? 0 : 2;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  // Bad flags get a one-line message; anything else is a bug and keeps its stack.
  const usageError = err instanceof UsageError || (err instanceof Error && /^--|^whatif|ERR_PARSE_ARGS/.test(`${err.message}${(err as NodeJS.ErrnoException).code ?? ""}`));
  process.stderr.write(
    `[lcc] ${err instanceof Error ? (usageError ? err.message : (err.stack ?? err.message)) : String(err)}\n`,
  );
  process.exitCode = usageError ? 2 : 1;
}
