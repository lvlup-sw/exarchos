// Fixture: registered handlers that comply with no-handler-throw. The rule must
// flag none of them. The fixture also holds each exemption class:
//   1. A deep helper outside the registration set, which throws freely.
//   2. A fail-loud precondition guard on the wiring of the handler, not on domain input.
//   3. An AbortError re-throw from a catch that converts each other failure.

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

/** Exemption 1: a deep helper that throws freely. No registration references it, so the rule does not scan it. */
function assertValidId(id: string | undefined): asserts id is string {
  if (!id) {
    throw new Error('id must be defined');
  }
}

/** Returns a domain failure as `ToolResult.error`, with no throw. */
async function handleDirectReturn(args: { id?: string }): Promise<ToolResult> {
  if (!args.id) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'id is required' } };
  }
  return { success: true };
}

/** Its catch returns a `ToolResult`, so the throw of the deep helper cannot complete the handler abnormally. */
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

/**
 * Exemption 2: a fail-loud precondition guard on a missing `DispatchContext`.
 * The condition does not reference `args`, so it is not domain-input validation.
 * `inline_arrow_throw` in the violating fixture holds the same guard.
 */
async function handleWithGuard(
  args: { id?: string },
  _stateDir: string,
  ctx?: DispatchContext,
): Promise<ToolResult> {
  if (!ctx) {
    throw new Error('DispatchContext required for this handler');
  }
  return { success: true, data: { id: args.id } };
}

/** Exemption 3: the catch converts each other failure, but re-throws an `AbortError` for the abort handling of the caller. */
async function handleWithAbortSupport(args: { id?: string }): Promise<ToolResult> {
  try {
    assertValidId(args.id);
    return { success: true };
  } catch (err) {
    if (err instanceof AbortError) {
      throw err;
    }
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/** A compliant special-branch handler, dispatched from an `if (action === 'onboard')` branch. */
async function handleOnboard(args: { report?: string }): Promise<ToolResult> {
  if (!args.report) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'report is required' } };
  }
  return { success: true, data: { report: args.report } };
}

/**
 * Copies the tail of `handleOrchestrate` in composite.ts: special branches, then the
 * `ACTION_HANDLERS` table dispatch through a local `handler` const. The map walk
 * covers that indirection, so the derived census must not report it.
 * The guarded table read matches the real tail, so the exemption works for the
 * wrapper that production uses.
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
  const handler: ActionHandler | undefined =
    typeof action === 'string' ? ACTION_HANDLERS[action] : undefined;
  if (!handler) {
    return { success: false, error: { code: 'UNKNOWN_ACTION', message: action } };
  }
  return envelopeWrap(await handler(rest, stateDir), startedAt);
}

/** The zero-arg factory shape of `setup_worktree: adaptSetupWorktree()` in composite.ts. Its closure returns the failure with no throw. */
function adaptZeroArgFactoryClean(): ActionHandler {
  return async (args, _stateDir, _ctx) => {
    if (!args.id) {
      return { success: false, error: { code: 'INVALID_INPUT', message: 'id is required' } };
    }
    return { success: true };
  };
}

/** The cast shape of `prune_stale_workflows: handlePruneStaleWorkflows as ActionHandler` in composite.ts. */
async function handleAsCastClean(args: { id?: string }): Promise<ToolResult> {
  if (!args.id) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'id is required' } };
  }
  return { success: true };
}

/** A destructured first parameter is not exempt by default. This handler has no throw, so the rule must not report it. */
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
