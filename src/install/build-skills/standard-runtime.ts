import type { RuntimeMap } from '../runtimes/types.js';

/**
 * The output subtree of the one runtime-neutral render of each procedural skill.
 * An orchestration skill keeps one subtree for each runtime.
 */
export const STANDARD_TREE_NAME = 'standard';

/**
 * Logical MCP prefix for the standard render: `{{MCP_PREFIX}}exarchos_workflow`
 * becomes `exarchos:exarchos_workflow`. This is the harness-neutral `Server:tool` form.
 * It resolves on each Tier-1 harness, because each harness keeps the raw tool name as
 * the suffix of its MCP tool name.
 */
const STANDARD_MCP_PREFIX = 'exarchos:';

/**
 * Logical command prefix for the standard render: the empty string, so
 * `{{COMMAND_PREFIX}}review` becomes the bare canonical verb `review`.
 * Tools get the `exarchos:` qualifier. Verbs do not.
 */
const STANDARD_COMMAND_PREFIX = '';

/**
 * Synthetic runtime for the single procedural render. It is not a target harness.
 * Its placeholder map resolves the two prefix tokens to their logical form.
 * It declares no `supportedCapabilities`, so the vocabulary lint treats it as a
 * non-Claude surface and a leaked Claude-only term fails the build.
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
