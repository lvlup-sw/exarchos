import * as fs from 'node:fs';
import { z } from 'zod';

import { atomicWriteFile } from '../../utils/atomic-write.js';

/** Canonical agent path: `./rendered/agents/<kebab-id>.md`. */
const AgentPathSchema = z.string().regex(/^\.\/rendered\/agents\/[a-z0-9-]+\.md$/);

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

/**
 * Zod schema for `.claude-plugin/plugin.json`.
 * Only `name` and `agents` are required. `.passthrough()` keeps the fields that the generator does not manage when the file is written back.
 */
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
 * Read a plugin manifest from disk, parse the JSON, and validate it against {@link PluginManifestSchema}.
 * It throws an `Error` that names the path for a read failure, a JSON syntax error, or a schema violation.
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

/**
 * Validate `manifest` against {@link PluginManifestSchema}, then write it with {@link atomicWriteFile}.
 * The validation occurs before any disk I/O. A concurrent reader sees the old or the new contents, never a partial write.
 */
export function writePluginManifest(filePath: string, manifest: PluginManifest): void {
  const validated = PluginManifestSchema.parse(manifest);
  const json = JSON.stringify(validated, null, 2) + '\n';
  atomicWriteFile(filePath, json);
}
