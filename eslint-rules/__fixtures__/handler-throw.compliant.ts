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

// A compliant special-cased branch handler, dispatched from its own
// `if (action === 'onboard')` branch. No throw at all.
async function handleOnboard(args: { report?: string }): Promise<ToolResult> {
  if (!args.report) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'report is required' } };
  }
  return { success: true, data: { report: args.report } };
}

/**
 * Mirrors composite.ts's `handleOrchestrate` tail: special branches first,
 * then the ACTION_HANDLERS table dispatch through a function-local `handler`
 * const. That last `envelopeWrap` is an INDIRECTION, not a named handler — its
 * census is the map walk — so the derived special-branch census must leave it
 * alone rather than report it as an unattributed dispatch. This is the shape
 * that keeps the derivation from over-selecting.
 */
async function dispatchSpecialBranch(
  action: string,
  rest: Record<string, unknown>,
  stateDir: string,
): Promise<ToolResult> {
  const startedAt = Date.now();
  if (action === 'onboard') {
    return envelopeWrap(await handleOnboard(rest as { report?: string }), startedAt);
  }
  // The GUARDED table read, matching composite.ts's real tail. Written as the
  // conditional rather than a bare lookup so the exemption is exercised through
  // the wrapper production actually uses — a predicate that only accepted the
  // bare form would reject the one dispatcher it exists for.
  const handler: ActionHandler | undefined =
    typeof action === 'string' ? ACTION_HANDLERS[action] : undefined;
  if (!handler) {
    return { success: false, error: { code: 'UNKNOWN_ACTION', message: action } };
  }
  return envelopeWrap(await handler(rest, stateDir), startedAt);
}

// Compliant zero-arg factory shape (composite.ts's real `setup_worktree:
// adaptSetupWorktree()` shape) — the factory's returned closure converts
// its domain failure to ToolResult.error directly; no throw for the rule to
// find once it unwraps the factory's `return` statement.
function adaptZeroArgFactoryClean(): ActionHandler {
  return async (args, _stateDir, _ctx) => {
    if (!args.id) {
      return { success: false, error: { code: 'INVALID_INPUT', message: 'id is required' } };
    }
    return { success: true };
  };
}

// Compliant `as ActionHandler` cast shape (composite.ts's real
// `prune_stale_workflows: handlePruneStaleWorkflows as ActionHandler`).
async function handleAsCastClean(args: { id?: string }): Promise<ToolResult> {
  if (!args.id) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'id is required' } };
  }
  return { success: true };
}

// Compliant destructured-first-param handler — proves the fail-loud-guard
// fix's NON-exempt default for unrecognized first-param shapes doesn't
// produce a false positive when the handler genuinely has no throw.
async function handleDestructuredParamClean({ id }: { id?: string }): Promise<ToolResult> {
  if (!id) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'id is required' } };
  }
  return { success: true };
}

const ACTION_HANDLERS: Readonly<Record<string, ActionHandler>> = {
  direct_return: adapt(handleDirectReturn),
  try_catch_returns: adapt(handleTryCatchReturns),
  with_guard: adapt(handleWithGuard),
  with_abort_support: adapt(handleWithAbortSupport),
  zero_arg_factory_clean: adaptZeroArgFactoryClean(),
  as_cast_clean: handleAsCastClean as ActionHandler,
  destructured_param_clean: adapt(handleDestructuredParamClean),
};

export { ACTION_HANDLERS, dispatchSpecialBranch };
