// Fixture: registered handlers that VIOLATE no-handler-throw (#1706 DR-1).
//
// Mirrors composite.ts's real registration-set shapes in miniature — the
// ACTION_HANDLERS map (adaptXxx(handleYyy) wrapping AND a raw inline-arrow
// value, composite.ts's `create_issue` shape), and the
// `envelopeWrap(await handleXxx(...), startedAt)` call shape the six
// special-cased branches use (composite.ts:639-715, dispatched at :748) — so
// the rule's registration-set resolution + throw classification is exercised
// the same way it runs over the real orchestrate/** tree, without this
// fixture depending on that tree.

type ToolResult =
  | { success: true; data?: unknown }
  | { success: false; error: { code: string; message: string; [key: string]: unknown } };

interface DispatchContext {
  eventStore?: unknown;
}

type ActionHandler = (
  args: Record<string, unknown>,
  stateDir: string,
  ctx?: DispatchContext,
) => Promise<ToolResult>;

function adapt<T>(
  handler: (args: T, stateDir: string, ctx?: DispatchContext) => Promise<ToolResult>,
): ActionHandler {
  return (args, stateDir, ctx) => handler(args as unknown as T, stateDir, ctx);
}

function envelopeWrap(result: ToolResult, _startedAt: number): ToolResult {
  return result;
}

// Case 1: a top-level throw — nothing guards it. A domain-validation failure
// (`args.id` missing) is raised as a raw Error instead of ToolResult.error;
// core/dispatch.ts's safety net would flatten it to a generic INTERNAL_ERROR.
async function handleTopLevelThrow(args: { id?: string }): Promise<ToolResult> {
  if (!args.id) {
    throw new Error('id is required');
  }
  return { success: true };
}

// Case 2: a catch-clause throw that is NOT re-caught — the handler DOES try/
// catch, but the catch re-throws instead of converting, so the failure still
// escapes to dispatch.ts's safety net. Because this catch never returns a
// ToolResult, the "try whose catch returns a ToolResult" exclusion does not
// apply to the INNER try-block throw either — both throws below are reported
// (fixing the catch to `return {success:false, ...}` would silence both).
async function handleCatchRethrow(args: { id?: string }): Promise<ToolResult> {
  try {
    if (!args.id) {
      throw new Error('id is required');
    }
    return { success: true };
  } catch (err) {
    throw err; // VIOLATION: re-thrown, not converted to ToolResult.error
  }
}

// Case 3: one of composite.ts's six special-cased branch handlers — matched
// by name (handleDoctor), invoked directly via the
// `envelopeWrap(await handleXxx(...), startedAt)` shape, never registered
// through ACTION_HANDLERS. Stand-in name/body; only the call shape matters
// to the rule's resolution.
async function handleDoctor(args: { report?: string }): Promise<ToolResult> {
  if (!args.report) {
    throw new Error('report is required'); // VIOLATION: top-level throw
  }
  return { success: true, data: { report: args.report } };
}

async function dispatchSpecialBranch(rest: Record<string, unknown>): Promise<ToolResult> {
  const startedAt = Date.now();
  return envelopeWrap(await handleDoctor(rest as { report?: string }), startedAt);
}

const ACTION_HANDLERS: Readonly<Record<string, ActionHandler>> = {
  top_level_throw: adapt(handleTopLevelThrow),
  catch_rethrow: adapt(handleCatchRethrow),
  // Case 4: an inline arrow VALUE assigned directly in the map (composite.ts's
  // `create_issue` shape) — never wrapped by an adaptXxx() call. Carries both
  // an EXEMPT fail-loud guard (condition never references `args`) and a
  // genuine (args-derived) VIOLATION, to prove the two are told apart within
  // the same handler.
  inline_arrow_throw: async (args, _stateDir, ctx) => {
    if (!ctx) {
      throw new Error('DispatchContext required for this handler'); // exempt: precondition guard
    }
    if (!args.id) {
      throw new Error('id is required'); // VIOLATION: args-derived, not a wiring guard
    }
    return { success: true };
  },
};

export { ACTION_HANDLERS, dispatchSpecialBranch };
