// Fixture: registered handlers that violate no-handler-throw.
//
// It copies the registration shapes of composite.ts in miniature. The
// `ACTION_HANDLERS` map holds `adapt(handleX)` values and a raw inline arrow.
// The special actions use the branch
// `if (action === '<verb>') return envelopeWrap(await handleX(...), startedAt);`. The rule derives the special-branch census from
// the literal of each branch, so the dispatcher keeps that branch shape.

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

/** Case 1: an unguarded top-level throw for domain input. The dispatch safety net flattens it to a generic `INTERNAL_ERROR`. */
async function handleTopLevelThrow(args: { id?: string }): Promise<ToolResult> {
  if (!args.id) {
    throw new Error('id is required');
  }
  return { success: true };
}

/**
 * Case 2: the catch re-throws instead of a conversion. The catch returns no
 * `ToolResult`, so the exclusion for a converting catch does not apply to the
 * inner throw either. The rule reports both throws.
 */
async function handleCatchRethrow(args: { id?: string }): Promise<ToolResult> {
  try {
    if (!args.id) {
      throw new Error('id is required');
    }
    return { success: true };
  } catch (err) {
    throw err;
  }
}

/** Case 3: a special-branch handler, dispatched from an `if (action === 'doctor')` branch and absent from `ACTION_HANDLERS`. */
async function handleDoctor(args: { report?: string }): Promise<ToolResult> {
  if (!args.report) {
    throw new Error('report is required');
  }
  return { success: true, data: { report: args.report } };
}

/**
 * Case 8, the kill fixture for the derived census: a special-branch handler in no
 * hand-written roster. Only a census derived from the dispatch branch finds its throw.
 */
async function handleAmend(args: { id?: string }): Promise<ToolResult> {
  if (!args.id) {
    throw new Error('id is required');
  }
  return { success: true };
}

async function dispatchSpecialBranch(
  action: string,
  rest: Record<string, unknown>,
): Promise<ToolResult> {
  const startedAt = Date.now();
  if (action === 'doctor') {
    return envelopeWrap(await handleDoctor(rest as { report?: string }), startedAt);
  }
  if (action === 'invariants_amend') {
    return envelopeWrap(await handleAmend(rest as { id?: string }), startedAt);
  }
  return { success: false, error: { code: 'UNKNOWN_ACTION', message: action } };
}

/**
 * Case 5: the zero-arg factory shape of `setup_worktree: adaptSetupWorktree()`.
 * The map value is a call with no arguments. The rule must resolve the callee and
 * unwrap the closure that its `return` statement gives.
 */
function adaptZeroArgFactory(): ActionHandler {
  return async (args, _stateDir, _ctx) => {
    if (!args.id) {
      throw new Error('id is required');
    }
    return { success: true };
  };
}

/** Case 6: the `handleX as ActionHandler` cast shape of `prune_stale_workflows`. The cast must resolve to a scannable function. */
async function handleAsCastThrow(
  args: { id?: string },
  _stateDir: string,
  _ctx?: DispatchContext,
): Promise<ToolResult> {
  if (!args.id) {
    throw new Error('id is required');
  }
  return { success: true };
}

/**
 * Case 7: a destructured first parameter. `firstParamName` cannot name an `args`
 * identifier, so the fail-loud guard exemption defaults to not exempt. The rule
 * must report this domain-input throw.
 */
async function handleDestructuredParamThrow({ id }: { id?: string }): Promise<ToolResult> {
  if (!id) {
    throw new Error('id is required');
  }
  return { success: true };
}

const ACTION_HANDLERS: Readonly<Record<string, ActionHandler>> = {
  top_level_throw: adapt(handleTopLevelThrow),
  catch_rethrow: adapt(handleCatchRethrow),
  /**
   * Case 4: an inline arrow value in the map, the `create_issue` shape. Its `ctx`
   * guard is exempt, and its throw on `args` is a violation. The rule must tell them apart.
   */
  inline_arrow_throw: async (args, _stateDir, ctx) => {
    if (!ctx) {
      throw new Error('DispatchContext required for this handler');
    }
    if (!args.id) {
      throw new Error('id is required');
    }
    return { success: true };
  },
  zero_arg_factory_throw: adaptZeroArgFactory(),
  as_cast_throw: handleAsCastThrow as ActionHandler,
  destructured_param_throw: adapt(handleDestructuredParamThrow),
};

export { ACTION_HANDLERS, dispatchSpecialBranch };
