/**
 * Runtime map schema + types for the platform-agnostic skills build system.
 *
 * A runtime map describes a single target agent runtime (e.g. `claude`,
 * `codex`, `opencode`, `copilot`, `cursor`, `generic`). It is consumed by:
 *   - the loader (Task 002)
 *   - the renderer (Task 003)
 *   - the install-skills CLI (Task 019)
 *   - the six runtime YAML files (Tasks 009-014)
 *
 * Implements: DR-1, DR-4
 */

import { z } from 'zod';

/**
 * Capability matrix describing what the target runtime supports.
 *
 * Top-level strictness is enforced by `RuntimeMapSchema.strict()`, and this
 * nested object is also strict so that typos like `hasSubAgents` are caught
 * at load time rather than silently ignored.
 */
const CapabilitiesSchema = z
  .object({
    hasSubagents: z.boolean(),
    hasSlashCommands: z.boolean(),
    hasHooks: z.boolean(),
    hasSkillChaining: z.boolean(),
    mcpPrefix: z.string(),
  })
  .strict();

/**
 * Detection hints used to determine whether this runtime is present on the
 * host system (CLI binaries in PATH, known environment variables, etc.).
 */
const DetectionSchema = z
  .object({
    binaries: z.array(z.string()),
    envVars: z.array(z.string()),
  })
  .strict();

/**
 * The runtime map schema.
 *
 * `.strict()` at the top level ensures unknown fields are rejected, which
 * catches typos in hand-authored YAML. The `placeholders` map is intentionally
 * open-ended (`Record<string, string>`) because the placeholder vocabulary
 * grows over time as new skills introduce new substitution keys.
 */
export const RuntimeMapSchema = z
  .object({
    name: z.string(),
    capabilities: CapabilitiesSchema,
    // DR-1: preferred skill-authoring facade for this runtime.
    preferredFacade: z.enum(['mcp', 'cli']),
    skillsInstallPath: z.string(),
    detection: DetectionSchema,
    placeholders: z.record(z.string(), z.string()),
  })
  .strict();

/**
 * TypeScript type for a validated runtime map. Prefer this type over the raw
 * schema when consuming already-parsed data.
 */
export type RuntimeMap = z.infer<typeof RuntimeMapSchema>;

/**
 * Preferred skill-authoring facade for a given runtime (DR-1).
 *
 * - `mcp` — runtimes whose agents invoke Exarchos via MCP tool calls.
 * - `cli` — runtimes that prefer bash-style CLI invocations.
 */
export type PreferredFacade = z.infer<typeof RuntimeMapSchema>['preferredFacade'];
