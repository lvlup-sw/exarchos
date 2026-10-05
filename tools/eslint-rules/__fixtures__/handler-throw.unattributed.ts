// Fixture: an envelope-wrapped dispatch to a named handler in no dispatch branch.
// The derived special-branch census cannot attribute it to an action, so the rule
// must report it through `unattributedDispatch`.
//
// It has its own file, so this report does not change the exact count of the violating fixture.

type ToolResult =
  | { success: true; data?: unknown }
  | { success: false; error: { code: string; message: string; [key: string]: unknown } };

function envelopeWrap(result: ToolResult, _startedAt: number): ToolResult {
  return result;
}

/** A compliant handler. The report is about the census, which cannot name this dispatch. */
async function handleUnbranched(args: { id?: string }): Promise<ToolResult> {
  if (!args.id) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'id is required' } };
  }
  return { success: true };
}

/** No `if (action === '...')` or `case '...':` selects this call, so it has no action name. */
async function dispatchWithoutABranch(rest: Record<string, unknown>): Promise<ToolResult> {
  const startedAt = Date.now();
  return envelopeWrap(await handleUnbranched(rest as { id?: string }), startedAt);
}

export { dispatchWithoutABranch };
