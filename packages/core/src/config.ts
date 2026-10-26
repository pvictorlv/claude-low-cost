import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

/**
 * NDA guard: every endpoint this project talks to must resolve to this machine.
 * Hostnames are not resolved — only literal loopback names and addresses pass,
 * so a DNS entry pointing `localhost.corp` outward cannot slip through.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return LOOPBACK_HOSTS.has(url.hostname) || /^127(\.\d{1,3}){3}$/.test(url.hostname);
}

const LoopbackUrl = z
  .string()
  .refine(isLoopbackUrl, { message: "endpoint must be loopback (127.0.0.0/8, localhost or ::1)" });

const ModelEndpointSchema = z.object({
  baseUrl: LoopbackUrl,
  model: z.string().min(1),
  timeoutMs: z.number().int().positive(),
});

export const ConfigSchema = z.object({
  /** Short-answer model: judging and triage. */
  judge: ModelEndpointSchema,
  /** Larger code model: preliminary review. Optional until Phase 5. */
  review: ModelEndpointSchema.optional(),
  /** Embedding model for code_search. Optional until Phase 4. */
  embed: ModelEndpointSchema.optional(),
  dataDir: z.string().min(1),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = {
  judge: { baseUrl: "http://127.0.0.1:8081", model: "judge", timeoutMs: 15_000 },
  dataDir: ".lcc",
};

export function loadConfig(path: string | undefined): Config {
  if (!path || !existsSync(path)) return DEFAULT_CONFIG;
  return ConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
