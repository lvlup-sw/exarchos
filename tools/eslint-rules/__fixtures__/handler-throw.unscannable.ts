// Fixture: two dispatch shapes that reach a real handler. The census attributes
// neither to an action, so the gate cannot see a throw inside either handler.
// The rule must report each through `unattributedDispatch`.
//
// It has its own file, so these reports do not change the exact count of another fixture.

type ToolResult =
  | { success: true; data?: unknown }
  | { success: false; error: { code: string; message: string; [key: string]: unknown } };

function envelopeWrap(result: ToolResult, _startedAt: number): ToolResult {
  return result;
}

async function handleAliased(args: { id?: string }): Promise<ToolResult> {
  if (!args.id) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'id is required' } };
  }
  return { success: true };
}

const handlers = {
  handleNamespaced: async (args: { id?: string }): Promise<ToolResult> => {
    if (!args.id) {
      return { success: false, error: { code: 'INVALID_INPUT', message: 'id is required' } };
    }
    return { success: true };
  },
};

/** Shape 1: a member-expression callee, which `dispatchedCalleeIdentifier` cannot name. */
async function dispatchThroughNamespace(rest: Record<string, unknown>): Promise<ToolResult> {
  const startedAt = Date.now();
  return envelopeWrap(await handlers.handleNamespaced(rest as { id?: string }), startedAt);
}

/** Shape 2: a plain local alias. It does not come from `ACTION_HANDLERS[action]`, so no census covers it. */
async function dispatchThroughAlias(rest: Record<string, unknown>): Promise<ToolResult> {
  const startedAt = Date.now();
  const handler = handleAliased;
  return envelopeWrap(await handler(rest as { id?: string }), startedAt);
}

export { dispatchThroughNamespace, dispatchThroughAlias };
