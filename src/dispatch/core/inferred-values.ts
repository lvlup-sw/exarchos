/**
 * The values that dispatch infers for a caller, and the one gate that they share. An MCP client
 * that declares the `roots` capability names its workspace, so dispatch can infer `featureId`.
 *
 * The inferred value goes into the payload that per-action validation sees, because many actions
 * require `featureId`. A merge into a strict schema that does not declare the field makes the call
 * fail on a parameter that the caller did not send. So each inferrable value is declared in
 * {@link INFERRABLE_FIELDS} and merged through the one gated path in {@link applyInferredValues}.
 */

import { logger } from '../../logger.js';
import type { ToolAction } from '../../registry.js';
import type { CapabilityResolver } from '../../workflow/capabilities/resolver.js';
import type { EventStore } from '../../events/store.js';
import type { StorageBackend } from '../../storage/backend.js';
import type { RootsClient } from '../../runtime/workspace/discovery.js';

/** The part of the dispatch context that an inference resolver can read. */
export interface InferenceContext {
  readonly capabilityResolver?: CapabilityResolver | undefined;
  readonly rootsClient?: RootsClient | undefined;
  readonly eventStore: EventStore;
  readonly storage?: StorageBackend | undefined;
  readonly cwd?: string | undefined;
}

/**
 * What a resolver concluded. `ambiguous` is an outcome and not an error, because the operator can
 * pick one of the candidates. `unavailable` covers no match and a resolver failure. Dispatch then
 * falls through to the validation of the action, so the caller sees the usual missing-parameter
 * envelope.
 */
export type InferenceOutcome =
  | { readonly kind: 'resolved'; readonly value: unknown }
  | {
      readonly kind: 'ambiguous';
      readonly code: string;
      readonly message: string;
      readonly validTargets?: readonly string[];
    }
  | { readonly kind: 'unavailable' };

/** One value dispatch knows how to work out when the caller omits it. */
export interface InferrableField {
  /** Parameter name. Must match the schema field it is merged into. */
  readonly field: string;
  /**
   * Actions that skip resolution for latency, not for correctness. {@link actionAcceptsInferredValue}
   * already refuses an action that does not declare the field. So a name missing from this set costs
   * only a resolver call, not a rejected call.
   */
  readonly skipActions: ReadonlySet<string>;
  /** Cheap precondition — skip the resolver entirely when the channel is absent. */
  readonly isAvailable: (ctx: InferenceContext) => boolean;
  readonly resolve: (
    ctx: InferenceContext,
    tool: string,
    actionName: string,
  ) => Promise<InferenceOutcome>;
}

/**
 * Returns true when the schema of the action declares `field`. The wire accepts the union of the
 * fields of all actions of a tool, but routing hands the payload to one strict action schema.
 * `undeclared-parameters.ts` reads the same `schema.shape` to build the refusal, so the two agree.
 */
export function actionAcceptsInferredValue(action: ToolAction, field: string): boolean {
  return action.schema.shape[field] !== undefined;
}

const workspaceLogger = logger.child({ subsystem: 'workspace-discovery' });

/**
 * `featureId`, resolved from the MCP roots list with a cwd-walk fallback. It runs only when a
 * `rootsClient` is present, which is the MCP path. The CLI has no roots channel, and there the cwd
 * walk only adds filesystem latency.
 */
const FEATURE_ID_INFERENCE: InferrableField = {
  field: 'featureId',
  /** Pure introspection over the registry and catalogs. These actions have no workspace scope. */
  skipActions: new Set(['describe', 'runbook', 'agent_spec']),
  isAvailable: (ctx) => ctx.capabilityResolver !== undefined && ctx.rootsClient !== undefined,
  /**
   * Checks its preconditions again and does not rely on `isAvailable`. `storage` lets discovery list
   * workflows from the projected `workflow_state` table. `validTargets` carries the candidate
   * featureIds, because the error contract types it as strings. A resolver failure is logged and
   * returns `unavailable`, so the caller still gets the usual "featureId is required" envelope.
   */
  resolve: async (ctx, tool, actionName) => {
    const { capabilityResolver, rootsClient } = ctx;
    if (capabilityResolver === undefined || rootsClient === undefined) {
      return { kind: 'unavailable' };
    }
    try {
      const { resolveWorkspace } = await import('../../runtime/workspace/discovery.js');
      const resolution = await resolveWorkspace({
        resolver: capabilityResolver,
        rootsClient,
        cwd: ctx.cwd ?? process.cwd(),
        eventStore: ctx.eventStore,
        storage: ctx.storage,
      });
      if (resolution === undefined) return { kind: 'unavailable' };
      if (resolution.success) return { kind: 'resolved', value: resolution.featureId };
      return {
        kind: 'ambiguous',
        code: resolution.code,
        message:
          `${tool}/${actionName}: multiple workspaces matched MCP roots; ` +
          'supply an explicit featureId to disambiguate.',
        ...(resolution.validTargets !== undefined
          ? { validTargets: resolution.validTargets.map((t) => t.featureId) }
          : {}),
      };
    } catch (err) {
      workspaceLogger.warn(
        { tool, action: actionName, error: err instanceof Error ? err.message : String(err) },
        'workspace inference failed; falling back to legacy featureId validation',
      );
      return { kind: 'unavailable' };
    }
  },
};

/**
 * Each value that dispatch can infer. To add an inference, add an entry. The entry gets the schema
 * gate, the caller-wins rule, and the ambiguity envelope from {@link applyInferredValues}.
 */
export const INFERRABLE_FIELDS: readonly InferrableField[] = Object.freeze([
  FEATURE_ID_INFERENCE,
]);

/** Result of running the table over one dispatch payload. */
export type InferenceApplication =
  | { readonly kind: 'merged'; readonly args: Record<string, unknown> }
  | {
      readonly kind: 'refused';
      readonly code: string;
      readonly message: string;
      readonly validTargets?: readonly string[];
    };

/**
 * Fills in the values that the caller omitted, for the fields that this action accepts. For each
 * entry:
 * 1. An explicit value always wins. Inference never overwrites a caller value.
 * 2. An action whose schema omits the field is left alone. This is the gate.
 * 3. The skip list and `isAvailable` stop resolution early.
 * An `ambiguous` outcome refuses the call.
 */
export async function applyInferredValues(
  args: Readonly<Record<string, unknown>>,
  action: ToolAction,
  tool: string,
  actionName: string,
  ctx: InferenceContext,
  table: readonly InferrableField[] = INFERRABLE_FIELDS,
): Promise<InferenceApplication> {
  let merged: Record<string, unknown> = { ...args };

  for (const entry of table) {
    if (merged[entry.field] !== undefined) continue;
    if (!actionAcceptsInferredValue(action, entry.field)) continue;
    if (entry.skipActions.has(actionName)) continue;
    if (!entry.isAvailable(ctx)) continue;

    const outcome = await entry.resolve(ctx, tool, actionName);
    if (outcome.kind === 'resolved') {
      merged = { ...merged, [entry.field]: outcome.value };
    } else if (outcome.kind === 'ambiguous') {
      return {
        kind: 'refused',
        code: outcome.code,
        message: outcome.message,
        ...(outcome.validTargets !== undefined ? { validTargets: outcome.validTargets } : {}),
      };
    }
  }

  return { kind: 'merged', args: merged };
}
