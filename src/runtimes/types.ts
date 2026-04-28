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
 * Canonical capability vocabulary (mirror of
 * `servers/exarchos-mcp/src/agents/capabilities.ts`). Duplicated here to
 * avoid a cross-package import from the root build into the MCP server
 * source tree. The two enums must stay in sync; the alignment is asserted
 * by per-runtime YAML tests (e.g. `servers/exarchos-mcp/src/runtimes/
 * codex.test.ts`) which load both surfaces and cross-check.
 *
 * Exported so the `<!-- requires:* -->` guard parser in `build-skills.ts`
 * can validate guard capabilities against the same enum without
 * duplicating the vocabulary.
 *
 * Implements: delegation runtime parity, Task 7 (runtime YAML updates),
 * Task 8 (capability-aware prose renderer).
 */
export const SupportedCapabilityKey = z.enum([
  'fs:read',
  'fs:write',
  'shell:exec',
  'subagent:spawn',
  'subagent:completion-signal',
  'subagent:start-signal',
  'mcp:exarchos',
  'mcp:exarchos:readonly',
  'isolation:worktree',
  'team:agent-teams',
  'session:resume',
]);

/**
 * String-literal type for `SupportedCapabilityKey`. Exported so renderer
 * code can type-check guard parser outputs without invoking Zod at runtime.
 */
export type SupportedCapabilityName = z.infer<typeof SupportedCapabilityKey>;

/**
 * Canonical token vocabulary that every runtime YAML must declare in its
 * `placeholders` map. Adding an entry here is a forcing function: the
 * `buildAllSkills` pre-flight asserts every runtime declares every token
 * before any rendering happens, so a typo or missing entry fails the build
 * with an actionable diagnostic naming the runtime + token.
 *
 * Wave A (P4 prose layer) introduces `SUBAGENT_COMPLETION_HOOK` and
 * `SUBAGENT_RESULT_API` so cross-platform skill prose can describe the
 * subagent-completion handshake without hard-coding Claude's
 * `TeammateIdle` / `TaskOutput` primitives. The original five tokens
 * (`MCP_PREFIX` … `SPAWN_AGENT_CALL`) are kept here so the same
 * coverage check applies uniformly.
 *
 * Tokenize-when-fallback-exists, guard-otherwise: a token is added here
 * when every runtime can declare a sensible value for it; otherwise the
 * call site should be wrapped in a `<!-- requires:* -->` guard instead.
 */
export const RuntimeTokenKey = [
  'MCP_PREFIX',
  'COMMAND_PREFIX',
  'TASK_TOOL',
  'CHAIN',
  'SPAWN_AGENT_CALL',
  'SUBAGENT_COMPLETION_HOOK',
  'SUBAGENT_RESULT_API',
] as const;

/**
 * String-literal union of `RuntimeTokenKey` entries. The renderer uses
 * this to type-check vocabulary lookups without re-deriving the union by
 * hand.
 */
export type RuntimeTokenName = (typeof RuntimeTokenKey)[number];

/**
 * Three-state support classification. Mirror of `SupportLevel` from
 * `servers/exarchos-mcp/src/agents/adapters/types.ts` — see that file for
 * the canonical contract. `unsupported` capabilities are omitted from the
 * YAML map entirely; consumers detect non-support by absence.
 *
 * The renderer (Tasks 8/9) uses this distinction to differentiate
 * `<!-- requires:* -->` (any support) from `<!-- requires:native:* -->`
 * (native only) guards.
 */
const SupportLevel = z.enum(['native', 'advisory']);

/**
 * The runtime map schema.
 *
 * `.strict()` at the top level ensures unknown fields are rejected, which
 * catches typos in hand-authored YAML. The `placeholders` map is intentionally
 * open-ended (`Record<string, string>`) because the placeholder vocabulary
 * grows over time as new skills introduce new substitution keys.
 *
 * `supportedCapabilities` is optional during the runtime-parity rollout
 * (Task 7a–7e land in parallel); once every YAML declares it, this field
 * becomes required.
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
    // Zod v4's `z.record(enum, value)` enforces exhaustive coverage of
    // every enum key — but `unsupported` capabilities are deliberately
    // omitted from the YAML map (consumers detect by absence). Use
    // `z.partialRecord` so missing keys are accepted while present keys
    // are still constrained to the valid enum vocabulary.
    supportedCapabilities: z
      .partialRecord(SupportedCapabilityKey, SupportLevel)
      .optional(),
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
