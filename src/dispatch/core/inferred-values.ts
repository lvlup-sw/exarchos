// ─── Values dispatch infers on the caller's behalf, and the one gate they share ─
//
// Some parameters a caller omits can be worked out from context rather than
// refused. `featureId` is the case that exists today: an MCP client that
// declared the `roots` capability has already told the server which workspace
// it is in, so asking the operator to retype the workflow id is ceremony.
//
// The inferred value has to go INTO the payload that per-action validation
// sees. 43 of the 60 actions that take a `featureId` declare it REQUIRED, so
// inference exists precisely to satisfy that requirement — a channel that kept
// the value out of validation would fail the very callers it is meant to serve.
// That constraint is what makes the gate below load-bearing rather than
// cosmetic: the value is merged into a strict schema's input, so merging it
// into a schema that does not declare it manufactures a rejection.
//
// The failure this module exists to prevent: dispatch used to merge the
// resolved `featureId` into the payload of any action not on a three-name
// latency list. An action whose own schema omits the field then refused the
// call — naming a parameter the caller never sent and the server itself added.
// It hit 59 of 125 actions, including `doctor`, and only where resolution
// SUCCEEDS, so a suite that never resolves a workspace stayed green throughout.
// (The bounded action executor's `execute_intent` moved the DENOMINATOR by one
// and left the numerator alone: it declares an optional `featureId` alongside
// `streamId` — the same subject-identity spelling `task_claim`/`task_complete`/
// `task_fail` already carry — so it joins the 60 actions that declare the field
// rather than the 65 that omit it.)
//
// The repair was to consult the receiving action's schema first. This module is
// what stops that repair from being a fact about `featureId`: every inferrable
// value is declared in ONE table and merged through ONE gated path, so a second
// inference — a `taskId`, a `workflowType` — inherits the gate instead of
// re-deriving it, and cannot reopen the class by forgetting to.

import { logger } from '../../logger.js';
import type { ToolAction } from '../../registry.js';
import type { CapabilityResolver } from '../../workflow/capabilities/resolver.js';
import type { EventStore } from '../../events/store.js';
import type { StorageBackend } from '../../storage/backend.js';
import type { RootsClient } from '../../runtime/workspace/discovery.js';

/** The slice of the dispatch context an inference resolver may read. */
export interface InferenceContext {
  readonly capabilityResolver?: CapabilityResolver | undefined;
  readonly rootsClient?: RootsClient | undefined;
  readonly eventStore: EventStore;
  readonly storage?: StorageBackend | undefined;
  readonly cwd?: string | undefined;
}

/**
 * What a resolver concluded.
 *
 * `ambiguous` is a first-class outcome rather than an error because the caller
 * can act on it: the resolution found several candidates and the operator picks
 * one. `unavailable` covers both "nothing matched" and "the resolver failed",
 * which are the same to dispatch — fall through to the action's own validation
 * so the caller sees the ordinary missing-parameter envelope.
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
   * Actions that skip resolution for LATENCY, not correctness.
   *
   * Deliberately not load-bearing: {@link actionAcceptsInferredValue} already
   * refuses to merge into an action that does not declare the field, so a name
   * missing from this set costs a filesystem walk and can no longer cost a
   * rejected call.
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
 * May this action receive an inferred value for `field`?
 *
 * Only when its OWN schema declares the field. Every composite tool flattens
 * its actions into one registration schema, so the wire accepts the union of
 * every action's fields — but routing hands the payload to a single strict
 * schema that knows only its own. This reads the same `schema.shape` that
 * `undeclared-parameters.ts` reads to build the refusal, so the injector and
 * the refuser cannot disagree, and a newly declared action is classified the
 * moment it exists with no list to update.
 */
export function actionAcceptsInferredValue(action: ToolAction, field: string): boolean {
  return action.schema.shape[field] !== undefined;
}

const workspaceLogger = logger.child({ subsystem: 'workspace-discovery' });

/**
 * `featureId`, resolved from the MCP roots list with a cwd-walk fallback.
 *
 * Gated on `rootsClient` being present: that is the MCP path. The CLI has no
 * roots channel and no useful inference target, and the synchronous cwd walk
 * would otherwise add filesystem latency to every CLI dispatch that happens to
 * omit the field.
 */
const FEATURE_ID_INFERENCE: InferrableField = {
  field: 'featureId',
  // Pure introspection over the registry and catalogs — never workspace-scoped.
  skipActions: new Set(['describe', 'runbook', 'agent_spec']),
  isAvailable: (ctx) => ctx.capabilityResolver !== undefined && ctx.rootsClient !== undefined,
  resolve: async (ctx, tool, actionName) => {
    // Re-checked here rather than assumed from `isAvailable`. A resolver that
    // depends on its own precondition having been called elsewhere is one
    // refactor away from a non-null assertion that is no longer true.
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
        // Authoritative workflow enumeration via the projected
        // `workflow_state` table when probing this server's own workspace.
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
        // `validTargets` is typed as plain strings on the error contract, while
        // resolution returns `{ featureId, path }` records. Surface the
        // featureIds — the disambiguator the caller actually supplies on retry.
        ...(resolution.validTargets !== undefined
          ? { validTargets: resolution.validTargets.map((t) => t.featureId) }
          : {}),
      };
    } catch (err) {
      // Inference is a convenience, so a resolver failure must not mask the
      // ordinary validation contract — the caller still gets the standard
      // "featureId is required" envelope. Logged rather than swallowed: a
      // silent catch would hide a broken roots channel indefinitely.
      workspaceLogger.warn(
        { tool, action: actionName, error: err instanceof Error ? err.message : String(err) },
        'workspace inference failed; falling back to legacy featureId validation',
      );
      return { kind: 'unavailable' };
    }
  },
};

/**
 * Every value dispatch may infer.
 *
 * Adding an entry is the whole extension point. It inherits the schema gate,
 * the caller-wins rule and the ambiguity envelope from
 * {@link applyInferredValues}, so a new inference cannot reintroduce the
 * inject-into-a-forbidding-schema fault by omitting a check.
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
 * Fill in the values the caller omitted, for the fields this action accepts.
 *
 * The three skips are the contract, and they are applied to every entry rather
 * than per field:
 *
 *   1. An explicit value always wins — inference never overwrites a caller.
 *   2. An action whose schema omits the field is left alone. This is the gate.
 *   3. The latency list short-circuits resolution for pure introspection.
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
