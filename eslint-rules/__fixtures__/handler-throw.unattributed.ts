// Fixture: an envelope-wrapped dispatch to a NAMED handler that sits in no
// dispatch branch — so the derived special-branch census cannot attribute it
// to an action. Proves the `unattributedDispatch` fail-loud path reports it
// instead of returning silently.
//
// This is the second of the two silent returns the old rule had. Before the
// derivation, an `envelopeWrap(await handleXxx(...))` whose handler name was
// absent from the hand-written roster was skipped with `if (!actionName)
// return;` — indistinguishable, from CI's point of view, from "there is
// nothing here to check". That is precisely how `invariants_amend` shipped
// unscanned, so an un-nameable dispatch is now a reported hole.
//
// Kept as its OWN file (not folded into handler-throw.violating.ts) so this
// dedicated report doesn't perturb that fixture's exact-count assertion.

type ToolResult =
  | { success: true; data?: unknown }
  | { success: false; error: { code: string; message: string; [key: string]: unknown } };

function envelopeWrap(result: ToolResult, _startedAt: number): ToolResult {
  return result;
}

// A perfectly compliant handler — the report below is about the CENSUS being
// unable to name this dispatch, not about anything wrong inside the handler.
async function handleUnbranched(args: { id?: string }): Promise<ToolResult> {
  if (!args.id) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'id is required' } };
  }
  return { success: true };
}

// No `if (action === '...')` / `case '...':` selects this call, so there is no
// action name to attribute it to.
async function dispatchWithoutABranch(rest: Record<string, unknown>): Promise<ToolResult> {
  const startedAt = Date.now();
  return envelopeWrap(await handleUnbranched(rest as { id?: string }), startedAt);
}

export { dispatchWithoutABranch };
