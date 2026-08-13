// ─── Discover Bridge Orchestrate Handler (DR-7, #1581 task 018) ──────────────
//
// The `deep` planning rung's first-class, event-linked escalation from PLAN
// authoring to the existing `discover` research workflow — replacing the old
// manual "go start a new workflow" handoff. It is **opt-in** (INV-12): the
// affordance is surfaced via `next_actions` (see `next-actions-computer.ts`) and
// only this handler, called with explicit author confirmation (`confirm: true`),
// performs the escalation. Without confirmation it spawns nothing and emits
// nothing — a published affordance must never auto-run.
//
// On confirmation the bridge stitches the discover report to the unified spec by
// a shared `correlationId`: the link is recorded as a `state.patched` event on
// the feature stream (the report path + discover featureId + correlationId), so
// a later provenance query spans BOTH the spec's stream and the discover
// workflow's stream. The discover workflow is started by the author with the
// SAME correlationId; this handler establishes and returns it.
// ─────────────────────────────────────────────────────────────────────────────

import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { buildValidatedEvent } from '../../events/event-factory.js';
import { workflowLogger } from '../../logger.js';

export interface DiscoverBridgeArgs {
  readonly featureId: string;
  /** The unified `docs/specs/` artifact the discover report will be cited in. */
  readonly artifact?: string;
  /**
   * Author confirmation. The bridge is opt-in (DR-7): only `confirm: true`
   * performs the escalation. Absent / false ⇒ the affordance is described but
   * nothing is spawned and no event is emitted.
   */
  readonly confirm?: boolean;
  /** The discover report path to cite in the spec's design section (when known). */
  readonly reportPath?: string;
  /** Override the derived discover stream id (defaults to `<featureId>-discover`). */
  readonly discoverFeatureId?: string;
  /** Override the derived stitch correlationId (defaults to `discover-bridge:<featureId>`). */
  readonly correlationId?: string;
}

/**
 * Derive the deterministic correlationId that stitches the feature spec to its
 * discover research pre-pass. Deterministic (not time/random based) so a replay
 * or a re-invocation re-derives the SAME stitch — the link is idempotent.
 */
export function deriveBridgeCorrelationId(featureId: string, override?: string): string {
  return override ?? `discover-bridge:${featureId}`;
}

export async function handleDiscoverBridge(
  args: DiscoverBridgeArgs,
  _stateDir: string,
  eventStore?: EventStore,
): Promise<ToolResult> {
  if (!args.featureId) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'featureId is required' } };
  }
  if (!args.artifact) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'artifact (the unified docs/specs/ path the report is cited in) is required',
      },
    };
  }

  const correlationId = deriveBridgeCorrelationId(args.featureId, args.correlationId);
  const discoverFeatureId = args.discoverFeatureId ?? `${args.featureId}-discover`;
  const reportPath = args.reportPath ?? null;

  // OPT-IN GUARD (DR-7 / INV-12). Without explicit author confirmation the
  // bridge is a described affordance only — it spawns NO discover workflow and
  // emits NO event. This is the no-silent-spawn contract.
  if (args.confirm !== true) {
    return {
      success: true,
      data: {
        bridged: false,
        spawned: false,
        correlationId,
        affordance: {
          verb: 'discover_bridge',
          optIn: true,
          reason:
            'Opt-in: escalate to a /exarchos:discover research pre-pass (deep rung). ' +
            'Re-invoke with confirm:true to bridge; never auto-runs.',
          discoverFeatureId,
        },
      },
    };
  }

  // CONFIRMED — stitch the discover report to the spec by a shared correlationId.
  // The citation and the discover linkage carry the SAME correlationId so a
  // provenance query spans both documents/streams.
  const specCitation = { artifact: args.artifact, reportPath, correlationId };

  // EVENT-LINKED: record the bridge durably on the feature stream. Best-effort —
  // a file-based dispatch with no event store degrades to the returned linkage
  // (the correlationId is deterministic, so the author's discover `init` can
  // still adopt it) rather than failing the escalation.
  let eventLinked = false;
  if (eventStore) {
    try {
      const validatedEvent = buildValidatedEvent(args.featureId, 1, {
        type: 'state.patched',
        correlationId,
        source: 'workflow',
        data: {
          patch: {
            discoverBridge: { discoverFeatureId, reportPath, specPath: args.artifact, correlationId },
          },
        },
      });
      await eventStore.appendValidated(args.featureId, validatedEvent);
      eventLinked = true;
    } catch (err) {
      workflowLogger.warn(
        { featureId: args.featureId, correlationId, err: err instanceof Error ? err.message : String(err) },
        'discover_bridge: link event append failed — returning linkage without persisted event',
      );
    }
  }

  return {
    success: true,
    data: {
      bridged: true,
      spawned: true,
      eventLinked,
      correlationId,
      discoverFeatureId,
      reportPath,
      specCitation,
    },
  };
}
