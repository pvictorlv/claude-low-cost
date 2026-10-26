#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runUsage } from "./usage/command.js";

const HELP = `lcc — Claude Low Cost

usage:
  lcc usage [--root <dir>] [--pricing <file>] [--since YYYY-MM-DD] [--project <substr>] [--top N] [--json]
      Where the API money goes, from local Claude Code transcripts (default root: ~/.claude/projects).
`;

function main(argv: string[]): number {
  const [command, ...rest] = argv;

  if (command === "usage") {
    const { values } = parseArgs({
      args: rest,
      options: {
        root: { type: "string" },
        pricing: { type: "string" },
        since: { type: "string" },
        project: { type: "string" },
        top: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const top = values.top === undefined ? undefined : Number.parseInt(values.top, 10);
    if (top !== undefined && (!Number.isInteger(top) || top <= 0)) {
      process.stderr.write("--top must be a positive integer\n");
      return 2;
    }
    if (values.since !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(values.since)) {
      process.stderr.write("--since must be YYYY-MM-DD\n");
      return 2;
    }
    process.stdout.write(runUsage({ ...values, top }));
    return 0;
  }

  process.stdout.write(HELP);
  return command === undefined || command === "help" || command === "--help" ? 0 : 2;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`[lcc] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
}
