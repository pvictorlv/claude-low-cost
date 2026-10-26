import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { TokenUsage } from "@lcc/core";

/** Where a transcript came from. Subagent transcripts live under `<session>/subagents/`. */
export interface TranscriptSource {
  path: string;
  project: string;
  sessionId: string;
  /** `null` for the main conversation. */
  agentId: string | null;
  /** `main`, the subagent type from its `.meta.json`, or `unknown-subagent`. */
  agentType: string;
}

/** One billed API request. */
export interface UsageEvent {
  requestId: string;
  /** Path of the transcript the request came from; one per conversation or subagent run. */
  transcript: string;
  project: string;
  sessionId: string;
  agentType: string;
  model: string;
  timestamp: string;
  speed: string | undefined;
  usage: TokenUsage;
}

/** One tool result that entered a conversation's context. */
export interface ToolOutputEvent {
  project: string;
  sessionId: string;
  agentType: string;
  tool: string;
  chars: number;
  timestamp: string;
}

export interface ParsedTranscript {
  usage: UsageEvent[];
  toolOutputs: ToolOutputEvent[];
  /** Lines that were not valid JSON. A partially flushed last line is normal. */
  badLines: number;
}

const UsageSchema = z.object({
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  cache_read_input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
  cache_creation: z
    .object({
      ephemeral_5m_input_tokens: z.number().default(0),
      ephemeral_1h_input_tokens: z.number().default(0),
    })
    .nullish(),
  speed: z.string().nullish(),
});

const ContentBlockSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    name: z.string().optional(),
    tool_use_id: z.string().optional(),
    text: z.string().optional(),
    content: z.unknown().optional(),
  })
  .passthrough();

const AssistantRecordSchema = z.object({
  type: z.literal("assistant"),
  requestId: z.string().optional(),
  timestamp: z.string(),
  isSidechain: z.boolean().optional(),
  message: z.object({
    id: z.string().optional(),
    model: z.string(),
    content: z.array(ContentBlockSchema).default([]),
    usage: UsageSchema.optional(),
  }),
});

const UserRecordSchema = z.object({
  type: z.literal("user"),
  timestamp: z.string(),
  isSidechain: z.boolean().optional(),
  message: z.object({ content: z.union([z.string(), z.array(ContentBlockSchema)]) }),
});

const SubagentMetaSchema = z.object({ agentType: z.string() }).passthrough();

/** Claude Code writes this placeholder model for locally generated messages; they cost nothing. */
const SYNTHETIC_MODEL = "<synthetic>";

function toTokenUsage(u: z.infer<typeof UsageSchema>): TokenUsage {
  const created = u.cache_creation_input_tokens ?? 0;
  const split = u.cache_creation;
  const write1h = split?.ephemeral_1h_input_tokens ?? 0;
  // Older transcripts carry only the total; without a split, bill it as the 5-minute TTL.
  const write5m = split ? split.ephemeral_5m_input_tokens : created;
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
  };
}

function textLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
      n += block.text.length;
    }
  }
  return n;
}

export function parseTranscript(source: TranscriptSource, text: string): ParsedTranscript {
  // A response with several content blocks is written as several records that
  // repeat the same usage. Keep one per request; the last one is final.
  const byRequest = new Map<string, UsageEvent>();
  const toolNames = new Map<string, string>();
  const toolOutputs: ToolOutputEvent[] = [];
  let badLines = 0;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }

    // Old Claude Code versions inlined subagent turns into the main file.
    const agentType =
      source.agentId === null && (raw as { isSidechain?: unknown })?.isSidechain === true
        ? "unknown-subagent"
        : source.agentType;

    const assistant = AssistantRecordSchema.safeParse(raw);
    if (assistant.success) {
      const rec = assistant.data;
      for (const block of rec.message.content) {
        if (block.type === "tool_use" && block.id && block.name) toolNames.set(block.id, block.name);
      }
      const key = rec.requestId ?? rec.message.id;
      if (!key || !rec.message.usage || rec.message.model === SYNTHETIC_MODEL) continue;
      byRequest.set(key, {
        requestId: key,
        transcript: source.path,
        project: source.project,
        sessionId: source.sessionId,
        agentType,
        model: rec.message.model,
        timestamp: rec.timestamp,
        speed: rec.message.usage.speed ?? undefined,
        usage: toTokenUsage(rec.message.usage),
      });
      continue;
    }

    const user = UserRecordSchema.safeParse(raw);
    if (user.success && Array.isArray(user.data.message.content)) {
      for (const block of user.data.message.content) {
        if (block.type !== "tool_result" || !block.tool_use_id) continue;
        toolOutputs.push({
          project: source.project,
          sessionId: source.sessionId,
          agentType,
          tool: toolNames.get(block.tool_use_id) ?? "unknown",
          chars: textLength(block.content),
          timestamp: user.data.timestamp,
        });
      }
    }
  }

  return { usage: [...byRequest.values()], toolOutputs, badLines };
}

function readAgentType(metaPath: string): string {
  if (!existsSync(metaPath)) return "unknown-subagent";
  try {
    const meta = SubagentMetaSchema.safeParse(JSON.parse(readFileSync(metaPath, "utf8")));
    return meta.success ? meta.data.agentType : "unknown-subagent";
  } catch {
    return "unknown-subagent";
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Finds every main and subagent transcript under `~/.claude/projects`-shaped `root`. */
export function discoverTranscripts(root: string): TranscriptSource[] {
  const out: TranscriptSource[] = [];
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project);
    if (!isDir(projectDir)) continue;

    for (const entry of readdirSync(projectDir)) {
      const full = join(projectDir, entry);
      if (entry.endsWith(".jsonl")) {
        out.push({
          path: full,
          project,
          sessionId: basename(entry, ".jsonl"),
          agentId: null,
          agentType: "main",
        });
        continue;
      }

      const subagentsDir = join(full, "subagents");
      if (!isDir(subagentsDir)) continue;
      for (const file of readdirSync(subagentsDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const stem = basename(file, ".jsonl");
        out.push({
          path: join(subagentsDir, file),
          project,
          sessionId: entry,
          agentId: stem.replace(/^agent-/, ""),
          agentType: readAgentType(join(subagentsDir, `${stem}.meta.json`)),
        });
      }
    }
  }
  return out;
}
