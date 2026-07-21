// Fixture: registered handlers COMPLIANT with no-handler-throw (#1706 DR-1),
// plus every DR-3 exemption class — none of which the rule should flag:
//   1. a deep, non-registered helper that throws freely (out of scope — only
//      the registration set is walked);
//   2. a fail-loud precondition guard (a programmer-error assertion about the
//      handler's own wiring, not domain-input validation);
//   3. an AbortError/cancellation re-throw from inside an otherwise-
//      converting catch.

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

class AbortError extends Error {}

// Exemption 1 (DR-1/DR-3): a deep, non-registered helper. Throws freely —
// never referenced by ACTION_HANDLERS or a special branch, so it is out of
// the rule's registration-set scope entirely (deep helpers are expected to
// be caught and converted by the handler that calls them).
function assertValidId(id: string | undefined): asserts id is string {
  if (!id) {
    throw new Error('id must be defined'); // exempt: not in the registration set
  }
}

// Compliant handler: converts a domain failure to ToolResult.error directly,
// no throw at all.
async function handleDirectReturn(args: { id?: string }): Promise<ToolResult> {
  if (!args.id) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'id is required' } };
  }
  return { success: true };
}

// Compliant handler: a try whose catch returns a ToolResult — the deep
// helper's throw is guarded because the catch converts it, so it can never
// abnormally complete the handler.
async function handleTryCatchReturns(args: { id?: string }): Promise<ToolResult> {
  try {
    assertValidId(args.id);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

// Exemption 2 (DR-1/DR-3): a fail-loud precondition guard — a programmer-
// error assertion about the handler's OWN wiring (missing DispatchContext),
// not a domain-input validation failure. The condition never references
// `args`, distinguishing it from a validation throw that must become
// ToolResult.error (see the violating fixture's `inline_arrow_throw`, which
// carries the SAME guard alongside a real args-derived violation).
async function handleWithGuard(
  args: { id?: string },
  _stateDir: string,
  ctx?: DispatchContext,
): Promise<ToolResult> {
  if (!ctx) {
    throw new Error('DispatchContext required for this handler'); // exempt: precondition guard
  }
  return { success: true, data: { id: args.id } };
}

// Exemption 3 (DR-1/DR-3): AbortError / cancellation. The catch converts
// every OTHER failure to ToolResult.error but re-throws a cancellation so the
// caller's own abort handling still observes it — this re-throw is exempt.
async function handleWithAbortSupport(args: { id?: string }): Promise<ToolResult> {
  try {
    assertValidId(args.id);
    return { success: true };
  } catch (err) {
    if (err instanceof AbortError) {
      throw err; // exempt: cancellation, not a converted domain failure
    }
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

// A compliant special-cased branch handler (handleOnboard is one of
// composite.ts's six — see handleOrchestrate's
// `envelopeWrap(await handleXxx(...), startedAt)` shape). No throw at all.
async function handleOnboard(args: { report?: string }): Promise<ToolResult> {
  if (!args.report) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'report is required' } };
  }
  return { success: true, data: { report: args.report } };
}

async function dispatchSpecialBranch(rest: Record<string, unknown>): Promise<ToolResult> {
  const startedAt = Date.now();
  return envelopeWrap(await handleOnboard(rest as { report?: string }), startedAt);
}

const ACTION_HANDLERS: Readonly<Record<string, ActionHandler>> = {
  direct_return: adapt(handleDirectReturn),
  try_catch_returns: adapt(handleTryCatchReturns),
  with_guard: adapt(handleWithGuard),
  with_abort_support: adapt(handleWithAbortSupport),
};

export { ACTION_HANDLERS, dispatchSpecialBranch };
