/**
 * Lifecycle substrate: the `ps` operations fold.
 *
 * A generic fold that finds the liveness instances still in flight on each registered surface.
 * `events/liveness-registry.ts` holds the whole per-surface contract: the start event, the terminal
 * events and the instance key. This module iterates each descriptor, calls the registry's
 * `computeInFlightInstances`, and shapes the result into one row type. It names no surface, so a
 * new registry entry appears in `ps` with no change here. Age comes from the envelope `timestamp`.
 */
import {
  LIVENESS_DESCRIPTORS,
  computeInFlightInstances,
  livenessStartedAt,
  type LivenessDescriptor,
  type LivenessEventLike,
  type LivenessSurface,
  type LivenessStreamScope,
} from '../../../events/liveness-registry.js';

/**
 * The event shape of this fold: a {@link LivenessEventLike} plus the envelope `timestamp`.
 * `WorkflowEvent` rows satisfy it structurally.
 */
export interface OperationEventLike extends LivenessEventLike {
  readonly timestamp?: string;
}

/** One in-flight liveness instance, in the same row shape for each surface. `ps` shows it next to the workflow fold. */
export interface InFlightOperation {
  /** Which liveness surface this instance belongs to (registry-derived, not hardcoded). */
  readonly surface: LivenessSurface;
  /** The instance's canonical key, per the descriptor's own `instanceKeyOf`. */
  readonly instanceKey: string;
  /** Which stream family this surface's pair rides on (`'feature'` | `'worktrees'`). */
  readonly streamScope: LivenessStreamScope;
  /**
   * The stream of the start event. On a `feature` surface, it separates two workflows with the
   * same `instanceKey`. On the singleton `worktrees` scope, it is the shared stream id.
   * It is `undefined` only for a keyless test fixture.
   */
  readonly streamId: string | undefined;
  /**
   * The featureId on a `feature` surface, where `streamId` is the featureId. It is `undefined`
   * on a `worktrees` surface, because launch and prune use the shared singleton stream.
   */
  readonly featureId: string | undefined;
  /** The `<surface>.executing_started` CLAIM event type that opened this instance. */
  readonly startType: string;
  /** ISO 8601 instant the instance started, from the START event's envelope `timestamp`. */
  readonly startedAt: string | undefined;
  /**
   * Age in milliseconds at fold time, or `null` when `startedAt` is `undefined`. The workflow
   * fold uses the same `number | null` contract.
   */
  readonly ageMs: number | null;
}

/** Options for {@link foldInFlightOperations}. */
export interface FoldInFlightOperationsOptions {
  /**
   * The descriptor set. Defaults to {@link LIVENESS_DESCRIPTORS}. A conformance test overrides
   * it to prove that a new surface needs no change here.
   */
  readonly registry?: readonly LivenessDescriptor[];
  /** Clock hook for `ageMs` (defaults to `Date.now`) — deterministic in tests. */
  readonly now?: () => number;
}

/**
 * Fold an ordered event list into the in-flight instances of each descriptor in `options.registry`.
 * For each descriptor, it calls {@link computeInFlightInstances} and maps each surviving start event
 * to an {@link InFlightOperation}. It has no branch on the surface and adds no pairing rule.
 */
export function foldInFlightOperations(
  events: readonly OperationEventLike[],
  options?: FoldInFlightOperationsOptions,
): readonly InFlightOperation[] {
  const registry = options?.registry ?? LIVENESS_DESCRIPTORS;
  const now = options?.now ?? Date.now;
  const nowMs = now();

  const rows: InFlightOperation[] = [];
  for (const descriptor of registry) {
    const inFlight = computeInFlightInstances(descriptor, events);
    for (const { instanceKey, streamId, startEvent } of inFlight.values()) {
      const startedAt = livenessStartedAt(startEvent as OperationEventLike);
      rows.push({
        surface: descriptor.surface,
        instanceKey,
        streamScope: descriptor.streamScope,
        streamId,
        featureId: descriptor.streamScope === 'feature' ? streamId : undefined,
        startType: descriptor.startType,
        startedAt,
        ageMs: startedAt !== undefined ? Math.max(0, nowMs - Date.parse(startedAt)) : null,
      });
    }
  }
  return rows;
}
