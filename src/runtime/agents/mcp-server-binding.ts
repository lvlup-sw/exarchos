/**
 * The two Exarchos MCP server entries that a runtime config and an agent file can name.
 * The orchestrator entry starts `exarchos mcp --operator`, so its sessions hold the operator grant.
 * The read-only entry starts `exarchos mcp`, so its sessions hold only the read-only posture.
 * A runtime shares one server connection among all agents that name the entry.
 * Thus a read-only agent must name only the read-only entry.
 */

/** The orchestrator entry. Skills address its tools by this name. */
export const ORCHESTRATOR_MCP_SERVER_NAME = 'exarchos';

/** The read-only entry. Only agents with the `mcp:exarchos:readonly` tier name it. */
export const READONLY_MCP_SERVER_NAME = 'exarchos-readonly';

/** The launch arguments of the orchestrator entry. */
export const OPERATOR_MCP_ARGS: readonly string[] = Object.freeze(['mcp', '--operator']);

/** The launch arguments of the read-only entry. A server without `--operator` gives no session a write grant. */
export const READONLY_MCP_ARGS: readonly string[] = Object.freeze(['mcp']);

/**
 * Returns the server entry that an agent with `capabilities` names.
 * The full tier wins over the readonly tier. The result is `undefined` when the agent holds no Exarchos MCP tier.
 */
export function exarchosMcpServerFor(
  capabilities: ReadonlySet<string>,
): typeof ORCHESTRATOR_MCP_SERVER_NAME | typeof READONLY_MCP_SERVER_NAME | undefined {
  if (capabilities.has('mcp:exarchos')) return ORCHESTRATOR_MCP_SERVER_NAME;
  if (capabilities.has('mcp:exarchos:readonly')) return READONLY_MCP_SERVER_NAME;
  return undefined;
}
