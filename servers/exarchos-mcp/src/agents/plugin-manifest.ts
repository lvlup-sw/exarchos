import * as fs from 'node:fs';
import { z } from 'zod';

/**
 * Zod schema for `.claude-plugin/plugin.json`.
 *
 * Source of truth for plugin manifest validation across the MCP server.
 * Mirrors the live shape of the manifest. `.passthrough()` is applied so
 * forward-compat fields the generator does not manage are preserved when
 * we round-trip the file (T15 will write through this schema).
 *
 * Required fields are tightly typed; the rest are optional/passthrough so
 * we tolerate evolving Claude Code plugin manifests without churning the
 * schema.
 *
 * Consumers:
 *   - T14: `readPluginManifest` (typed read helper)
 *   - T15: `writePluginManifest` (atomic write helper)
 *   - T16: `generate-agents.ts` rewires preflight + update via these helpers
 */

/** Canonical agent path: `./agents/<kebab-id>.md`. */
const AgentPathSchema = z.string().regex(/^\.\/agents\/[a-z0-9-]+\.md$/);

const AuthorSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const McpServerSchema = z
  .object({
    type: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export const PluginManifestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    version: z.string().optional(),
    author: AuthorSchema.optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    agents: z.array(AgentPathSchema),
    commands: z.string().optional(),
    skills: z.string().optional(),
    mcpServers: z.record(z.string(), McpServerSchema).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/**
 * Reads `.claude-plugin/plugin.json` (or any file matching the schema)
 * from disk, parses JSON, and validates against {@link PluginManifestSchema}.
 *
 * Throws a descriptive `Error` (always including the file path) for:
 *   - read failures (missing file, permissions, etc.)
 *   - JSON syntax errors (preserves parse-position info from `JSON.parse`)
 *   - schema violations (full Zod issue list, JSON-formatted)
 *
 * Single-shot synchronous read by design — manifest is small, callers
 * are CLI/preflight paths, and sync I/O keeps error semantics simple.
 */
export function readPluginManifest(path: string): PluginManifest {
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(
      `readPluginManifest: failed to read ${path}: ${(e as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `readPluginManifest: invalid JSON in ${path}: ${(e as Error).message}`,
    );
  }
  const result = PluginManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `readPluginManifest: schema violation in ${path}:\n${JSON.stringify(result.error.issues, null, 2)}`,
    );
  }
  return result.data;
}
