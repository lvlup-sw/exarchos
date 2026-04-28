import { z } from 'zod';

import { atomicWriteFile } from '../utils/atomic-write.js';

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
 * Atomically write a plugin manifest to disk.
 *
 * Validates `manifest` via {@link PluginManifestSchema} BEFORE any disk I/O
 * — if the manifest is malformed, no temp file is staged and the target is
 * not touched. On valid input the JSON is staged to a sibling temp file
 * (via {@link atomicWriteFile}: temp + fsync + rename), so concurrent
 * readers either see the prior contents or the new contents — never a
 * partial write. On rename failure the temp is best-effort cleaned up and
 * the original error is rethrown.
 *
 * Output formatting: `JSON.stringify(manifest, null, 2)` + trailing
 * newline. Matches the conventional shape of `.claude-plugin/plugin.json`.
 *
 * Used by T16 to rewire `updatePluginJson` in `generate-agents.ts` so the
 * plugin manifest write path goes through the same validated atomic-write
 * surface as the projection sidecar.
 */
export function writePluginManifest(filePath: string, manifest: PluginManifest): void {
  const validated = PluginManifestSchema.parse(manifest);
  const json = JSON.stringify(validated, null, 2) + '\n';
  atomicWriteFile(filePath, json);
}
