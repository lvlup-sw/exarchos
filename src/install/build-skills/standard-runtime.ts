import type { RuntimeMap } from '../runtimes/types.js';

export const STANDARD_TREE_NAME = 'standard';

/**
 * Logical MCP prefix baked into the standard render: `{{MCP_PREFIX}}exarchos_workflow`
 * resolves to `exarchos:exarchos_workflow`. This is Anthropic's documented
 * harness-neutral qualified `Server:tool` convention — it resolves on every
 * Tier-1 harness because each keeps the raw tool name (`exarchos_workflow`) as the
 * suffix of its model-visible MCP name. It is the exact form Task 006 will bake
 * directly into the sources, so the standard tree stays byte-stable across 003→006.
 */
const STANDARD_MCP_PREFIX = 'exarchos:';

/**
 * Logical command prefix baked into the standard render: the empty string, so
 * `{{COMMAND_PREFIX}}review` resolves to the bare canonical verb `review`.
 * DR-3 frames the verb as one concept surfaced per-harness as `/exarchos:review`,
 * `$review`, or the `review` skill; the harness-neutral logical form is the bare
 * verb, matching the "canonical verbs" form Task 006 will bake into the sources
 * (tools get the `exarchos:` qualifier; verbs do not).
 */
const STANDARD_COMMAND_PREFIX = '';

/**
 * Synthetic runtime driving the single procedural render. It is NOT a target
 * harness — it is a runtime-neutral placeholder map that resolves the two prefix
 * tokens to their logical qualified form. It declares no `supportedCapabilities`,
 * so the post-render vocabulary lint treats it as a non-Claude surface and any
 * leaked Claude-only term still fails the build. Reuses the existing
 * `render()`/`substitute()` machinery unchanged — the collapse is a change of
 * *which* placeholder map and output tree, not a fork of the renderer.
 */
export const STANDARD_RUNTIME: RuntimeMap = {
  name: STANDARD_TREE_NAME,
  preferredFacade: 'mcp',
  capabilities: {
    hasSubagents: false,
    hasSlashCommands: false,
    hasSkillChaining: false,
    mcpPrefix: STANDARD_MCP_PREFIX,
  },
  skillsInstallPath: '.agents/skills',
  detection: { binaries: [], envVars: [] },
  placeholders: {
    MCP_PREFIX: STANDARD_MCP_PREFIX,
    COMMAND_PREFIX: STANDARD_COMMAND_PREFIX,
  },
};

/**
 * Validate every `{{CHAIN next="<verb>"}}` token in `body`: its `next` target
 * must name a skill that exists — a canonical workflow verb or an on-disk skill
 * directory. A CHAIN to an unknown target renders a dead `Skill(...)` chain
 * invocation that no-ops at runtime, so we fail the build instead of shipping it.
 *
 * Only the `next` arg participates — `args` is opaque chain payload. Tokens
 * without a `next` arg are skipped (a bare `{{CHAIN}}` is a placeholder-lint
 * concern, not a target concern). Runs against the raw source body so a broken
 * target is caught regardless of the skill's class.
 *
 * @param body - Raw skill source body.
 * @param sourcePath - Origin path for the diagnostic message.
 * @param validTargets - Known skill/verb names a CHAIN may point at.
 * @throws When a CHAIN `next` target is not in `validTargets`.
 */
