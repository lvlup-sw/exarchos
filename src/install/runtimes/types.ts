/**
 * Schema and types of a runtime map. A runtime map describes one target agent
 * runtime, such as `claude`, `codex` or `generic`. The loader, the renderer and
 * the install-skills CLI read it, and the runtime YAML files follow it.
 */

import { z } from 'zod';

/**
 * Lifecycle-hook profile of a runtime:
 * - `profile`: the hook renderer key. `none` means no hook system.
 * - `canInjectContext`: the session-start hook can return orientation context.
 * - `sessionStartEvent` and `sessionEndEvent`: the native event names, or
 *   `null`. For example, the session end event of Codex is `Stop`.
 *
 * A `none` profile must set `canInjectContext` to false and each event to
 * `null`. The schema rejects other `none` descriptors at load time.
 */
const HooksDescriptorSchema = z
  .object({
    profile: z.enum([
      'claude-json',
      'cursor-json',
      'copilot-json',
      'opencode-plugin',
      'none',
    ]),
    /**
     * @deprecated No rendering logic reads this field. The `none` profile rule
     * of this schema still checks it.
     */
    canInjectContext: z.boolean(),
    sessionStartEvent: z.string().nullable(),
    sessionEndEvent: z.string().nullable(),
    /**
     * The native subagent-completion event, such as `SubagentStop` for Claude
     * Code. A runtime without one omits it or sets `null`.
     */
    subagentStopEvent: z.string().nullable().optional(),
  })
  .strict()
  .refine(
    (d) =>
      d.profile !== 'none' ||
      (!d.canInjectContext &&
        d.sessionStartEvent === null &&
        d.sessionEndEvent === null &&
        (d.subagentStopEvent ?? null) === null),
    {
      message:
        'profile "none" requires canInjectContext:false and null sessionStartEvent/sessionEndEvent/subagentStopEvent',
    },
  );

/**
 * The capabilities of the target runtime. The object is strict, so a typo such
 * as `hasSubAgents` fails at load time.
 */
const CapabilitiesSchema = z
  .object({
    hasSubagents: z.boolean(),
    hasSlashCommands: z.boolean(),
    /** Lifecycle-hook profile. The hook build reads an absent value as `none`. */
    hooks: HooksDescriptorSchema.optional(),
    hasSkillChaining: z.boolean(),
    mcpPrefix: z.string(),
    /**
     * True when this runtime autoloads bare canonical-name command aliases,
     * such as `/ideate`, from a commands directory. Then the skills build
     * writes alias command files for it. The build reads this flag, not a
     * runtime name.
     */
    canonicalCommandAliases: z.boolean().optional(),
  })
  .strict();

/** Detection hints for this runtime: CLI binaries on PATH and environment variables. */
const DetectionSchema = z
  .object({
    binaries: z.array(z.string()),
    envVars: z.array(z.string()),
  })
  .strict();

/**
 * Canonical capability vocabulary, a copy of `src/runtime/agents/capabilities.ts`.
 * The copy avoids an import from the build into the MCP server source tree.
 * The two lists must stay equal, and the per-runtime YAML tests compare them.
 * The `<!-- requires:* -->` guard parser checks guard capabilities against it.
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
 * Tokens that each runtime YAML must declare in its `placeholders` map. Before
 * any render, the `buildAllSkills` preflight checks each runtime for each
 * token, and an error names the runtime and the token. Add a token only when
 * each runtime can declare a sensible value. Otherwise, put the call site in a
 * `<!-- requires:* -->` guard.
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

/** String-literal union of the `RuntimeTokenKey` entries. */
export type RuntimeTokenName = (typeof RuntimeTokenKey)[number];

/**
 * Support level of a capability, a copy of `SupportLevel` in
 * `src/runtime/agents/adapters/types.ts`. The YAML map omits `unsupported`
 * capabilities, so consumers detect them by absence. A `<!-- requires:* -->`
 * guard accepts both levels. A `<!-- requires:native:* -->` guard accepts only
 * `native`.
 */
const SupportLevel = z.enum(['native', 'advisory']);

/**
 * The runtime map schema. The top level is strict, so an unknown field in
 * hand-written YAML fails. The `placeholders` map is open, because new skills
 * add new keys.
 */
export const RuntimeMapSchema = z
  .object({
    name: z.string(),
    capabilities: CapabilitiesSchema,
    /** Preferred skill-authoring facade of this runtime. */
    preferredFacade: z.enum(['mcp', 'cli']),
    skillsInstallPath: z.string(),
    /**
     * Directory from which the runtime autoloads bare canonical-name command
     * aliases, such as `~/.config/opencode/commands`. When it is set and the
     * alias source tree for the runtime exists, `installSkills()` copies the
     * alias `*.md` files here.
     */
    commandsInstallPath: z.string().optional(),
    detection: DetectionSchema,
    placeholders: z.record(z.string(), z.string()),
    /**
     * Support level of each capability. It is a `z.partialRecord`, because a
     * Zod v4 `z.record` over an enum requires each key, and the YAML omits
     * `unsupported` capabilities.
     */
    supportedCapabilities: z
      .partialRecord(SupportedCapabilityKey, SupportLevel)
      .optional(),
  })
  .strict();

/** Type of a validated runtime map. */
export type RuntimeMap = z.infer<typeof RuntimeMapSchema>;

/** Validated lifecycle-hook profile. */
export type HooksDescriptor = z.infer<typeof HooksDescriptorSchema>;

/** The hook renderer key of a runtime. */
export type HooksProfile = HooksDescriptor['profile'];

/**
 * Preferred skill-authoring facade of a runtime:
 * - `mcp`: agents call Exarchos through MCP tools.
 * - `cli`: agents call Exarchos through the CLI.
 */
export type PreferredFacade = z.infer<typeof RuntimeMapSchema>['preferredFacade'];
