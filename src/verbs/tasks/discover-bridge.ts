/**
 * Handler for the `discover_bridge` action. It links PLAN authoring on the `deep` rung to a `discover` research workflow.
 * The bridge is opt-in. `next_actions` publishes the affordance, and only a call with `confirm: true` performs the escalation.
 *
 * On confirmation it records the link as a `state.patched` event on the feature stream, with a shared `correlationId`.
 * A provenance query can then span the spec stream and the discover stream.
 * The author starts the discover workflow with the same `correlationId`, which this handler returns.
 */

import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { buildValidatedEvent } from '../../events/event-factory.js';
import { workflowLogger } from '../../logger.js';

export interface DiscoverBridgeArgs {
  readonly featureId: string;
  /** The unified `docs/specs/` artifact the discover report will be cited in. */
  readonly artifact?: string;
  /** Author confirmation. Only `confirm: true` performs the escalation. Otherwise the handler only describes the affordance and emits no event. */
  readonly confirm?: boolean;
  /** The discover report path to cite in the spec's design section (when known). */
  readonly reportPath?: string;
  /** Override the derived discover stream id (defaults to `<featureId>-discover`). */
  readonly discoverFeatureId?: string;
  /** Override the derived stitch correlationId (defaults to `discover-bridge:<featureId>`). */
  readonly correlationId?: string;
}

/** Derives the correlationId that links the feature spec to its discover pre-pass. It uses no time or random input, so a replay derives the same link. */
export function deriveBridgeCorrelationId(featureId: string, override?: string): string {
  return override ?? `discover-bridge:${featureId}`;
}

/**
 * Without `confirm: true`, it returns the affordance and spawns nothing.
 * With confirmation, it appends the link event when an event store exists. An append failure only logs a warning.
 * Without an event store, it still returns the linkage, and the author can adopt the derived correlationId.
 */
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

  const specCitation = { artifact: args.artifact, reportPath, correlationId };

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
