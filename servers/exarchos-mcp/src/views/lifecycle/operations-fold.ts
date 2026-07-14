// ─── Lifecycle verb substrate: `ps` operations fold (DR-3, task 006) ─────────
//
// A GENERIC fold over an ordered event list that answers "which INV-10
// liveness instances are still IN FLIGHT?" across EVERY registered surface —
// merge / launch / mutation / prune today, and whatever a future task 004+N
// adds to the registry tomorrow — with ZERO surface-specific code in this
// file. The whole per-surface contract (which event starts an instance, which
// event(s) terminate it, how to derive its instance key) lives in
// `event-store/liveness-registry.ts` (task 004); this module contributes
// exactly one thing on top of that registry: iterate every descriptor,
// delegate the pairing to the registry's own `computeInFlightInstances`
// helper, and shape the survivors into a uniform row a `ps` consumer (task
// 007) can render without knowing which surface produced it.
//
// DR-3 acceptance criterion this file exists to satisfy: "adding a surface to
// the registry must add it to `ps` with no fold change." Because the loop
// below iterates `LIVENESS_DESCRIPTORS` (or a caller-supplied override, used
// only by this file's own conformance test) rather than naming `'merge'` /
// `'launch'` / `'mutation'` / `'prune'` anywhere, a fifth registry entry is
// picked up automatically — nothing here needs to change.
//
// Age: derived from the event ENVELOPE (`timestamp`, via the registry's own
// `livenessStartedAt`) rather than any surface-specific data field — the same
// uniformity discipline the registry itself documents.
// ─────────────────────────────────────────────────────────────────────────────

import {
  LIVENESS_DESCRIPTORS,
  computeInFlightInstances,
  livenessStartedAt,
  type LivenessDescriptor,
  type LivenessEventLike,
  type LivenessSurface,
  type LivenessStreamScope,
} from '../../event-store/liveness-registry.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The minimal event shape this fold operates on: a {@link LivenessEventLike}
 * (`type` + optional `data`) plus the envelope `timestamp` age is derived
 * from. Real `WorkflowEvent` rows (and `EventStore.query()` results) satisfy
 * this structurally — no adapter needed.
 */
export interface OperationEventLike extends LivenessEventLike {
  readonly timestamp?: string;
}

/**
 * One in-flight liveness instance, shaped uniformly across every surface —
 * the row shape a `ps` consumer (task 007) renders alongside task 005's
 * workflow-fold.
 */
export interface InFlightOperation {
  /** Which liveness surface this instance belongs to (registry-derived, not hardcoded). */
  readonly surface: LivenessSurface;
  /** The instance's canonical key, per the descriptor's own `instanceKeyOf`. */
  readonly instanceKey: string;
  /** Which stream family this surface's pair rides on (`'feature'` | `'worktrees'`). */
  readonly streamScope: LivenessStreamScope;
  /** The `<surface>.executing_started` CLAIM event type that opened this instance. */
  readonly startType: string;
  /** ISO 8601 instant the instance started, from the START event's envelope `timestamp`. */
  readonly startedAt: string | undefined;
  /** Age in milliseconds at fold time (`now - startedAt`), or `undefined` when `startedAt` is unresolvable. */
  readonly ageMs: number | undefined;
}

/** Options for {@link foldInFlightOperations}. */
export interface FoldInFlightOperationsOptions {
  /**
   * The descriptor set to fold over. Defaults to the REAL
   * {@link LIVENESS_DESCRIPTORS} — the whole point of the generic design. Only
   * ever overridden by this module's own conformance test, to prove that a
   * hypothetical fifth surface flows through with no code change here.
   */
  readonly registry?: readonly LivenessDescriptor[];
  /** Clock hook for `ageMs` (defaults to `Date.now`) — deterministic in tests. */
  readonly now?: () => number;
}

// ─── The fold ─────────────────────────────────────────────────────────────────

/**
 * Fold an ordered event list into every liveness instance still IN FLIGHT,
 * across every descriptor in `options.registry` (default: the real
 * registry). For each descriptor this simply delegates the START/TERMINAL
 * pairing to {@link computeInFlightInstances} — the registry's own pairing
 * helper — and maps the surviving `instanceKey -> START event` entries into
 * {@link InFlightOperation} rows. No `if (surface === '...')` branch exists
 * anywhere in this function; that is the DR-3 genericity guarantee.
 *
 * Ordering / semantics are exactly `computeInFlightInstances`'s: a START with
 * no later matching TERMINAL (by instance key, scanning `events` left to
 * right) is in flight; a re-START after a TERMINAL reopens the instance; an
 * orphan TERMINAL (no prior START) is a no-op; an unresolvable key is
 * skipped. This fold adds no additional semantics on top of that contract —
 * it is purely a shape-and-merge step across descriptors.
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
    for (const [instanceKey, startEvent] of inFlight) {
      const startedAt = livenessStartedAt(startEvent as OperationEventLike);
      rows.push({
        surface: descriptor.surface,
        instanceKey,
        streamScope: descriptor.streamScope,
        startType: descriptor.startType,
        startedAt,
        ageMs: startedAt !== undefined ? Math.max(0, nowMs - Date.parse(startedAt)) : undefined,
      });
    }
  }
  return rows;
}
