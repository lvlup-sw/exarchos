/**
 * Liveness descriptor registry (DR-2, task 004).
 *
 * The four INV-10 liveness surfaces — merge / launch / mutation / prune — each
 * emit a `<surface>.executing_started` CLAIM paired with one or more TERMINAL
 * event types. Tasks 003 (this task's prerequisite, merged) retrofitted a
 * canonical `instanceId` onto every payload so a uniform liveness view can
 * correlate a START with its TERMINAL without per-surface field knowledge.
 * This module is that uniform view: ONE registry entry per surface, declaring
 * the whole contract a consumer needs — which event starts the instance, which
 * event(s) terminate it, which stream it lives on, and how to derive its
 * instance key from a raw event payload.
 *
 * Downstream consumers (`ps`, `wait --operation` — tasks 006/010) read this
 * registry rather than re-deriving per-surface knowledge, so a fifth liveness
 * surface only has to add ONE entry here (and the conformance test below
 * fails loudly if it doesn't).
 *
 * ## Canonical keys (mirrors task 003's real emitters exactly)
 *
 *   • merge    → `data.instanceId ?? data.taskId ?? \`${sourceBranch}→${targetBranch}\``
 *   • launch   → `data.instanceId ?? data.worktreeId`
 *   • mutation → `data.instanceId ?? data.operationId ?? MUTATION_LEGACY_SINGLETON_KEY`
 *     (the live emitter — `orchestrate/mutation-adequacy.ts` — stamps
 *     `instanceId`; the `operationId` fallback is defensive, and a truly
 *     keyless legacy row resolves to the DR-2 singleton instance so it still
 *     pairs rather than being dropped)
 *   • prune    → `data.instanceId ?? data.operationId`
 *
 * `instanceKeyOf` is intentionally permissive about its input: any pre-
 * retrofit row (no `instanceId`) or partially-shaped row still resolves via
 * the fallback chain when possible, and returns `undefined` (never throws)
 * when no key can be derived at all — an unresolvable row cannot be paired,
 * but it must not crash a `ps`/`wait` scan.
 *
 * ## `startedAt`
 *
 * Rather than reading a surface-specific data field (only `merge` carries its
 * own `data.startedAt`; the other three do not), {@link livenessStartedAt}
 * derives the instant uniformly from the event ENVELOPE's `timestamp` — the
 * one field every persisted event carries regardless of surface.
 */

import type { EventType } from './schemas.js';
import { EventTypes } from './schemas.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** The four INV-10 liveness surfaces this registry describes. */
export type LivenessSurface = 'merge' | 'launch' | 'mutation' | 'prune';

/**
 * Which stream family a surface's liveness pair rides on. `'feature'` means
 * the workflow's own feature stream (a different stream id per workflow, so
 * the registry does not — and cannot — pin a literal stream name); `'worktrees'`
 * means the fixed singleton `worktrees` stream shared across every workflow.
 */
export type LivenessStreamScope = 'feature' | 'worktrees';

/** A minimal event shape the pairing helper operates on — real `WorkflowEvent`
 * rows satisfy this, as do hand-built fixtures in tests. */
export interface LivenessEventLike {
  readonly type: string;
  readonly data?: Record<string, unknown> | undefined;
  /**
   * The stream this event was persisted on. Load-bearing for the DR-2 "same
   * stream" pairing relation: two `feature`-scoped workflows whose merge
   * `instanceKey` collides (recurring `taskId`s, a shared branch pair) must NOT
   * cross-contaminate — a terminal on workflow B's stream may only clear an
   * in-flight START on B's stream, never A's. Real `WorkflowEvent` rows carry it;
   * fixtures should set it for `feature`-scoped surfaces. Absent → treated as the
   * empty stream (the degenerate single-namespace fallback).
   */
  readonly streamId?: string | undefined;
}

/** One registry entry: the whole liveness contract for a single surface. */
export interface LivenessDescriptor {
  /** The surface this descriptor describes. */
  readonly surface: LivenessSurface;
  /** The `<surface>.executing_started` CLAIM event type. */
  readonly startType: EventType;
  /** The paired TERMINAL event type(s) — one or more; e.g. merge has two
   * (`merge.executed` success path, `merge.recovered` rollback path). */
  readonly terminalTypes: readonly EventType[];
  /** Which stream family the pair rides on. */
  readonly streamScope: LivenessStreamScope;
  /**
   * Whether this surface has a LEGACY key fallback — a way to derive an instance
   * key from rows emitted BEFORE the canonical `instanceId` retrofit (task 003).
   * All four shipped surfaces do (merge → `taskId`/branch-pair, launch →
   * `worktreeId`, mutation → `operationId`/singleton, prune → `operationId`), so
   * their start schemas may leave `instanceId` optional and still pair legacy
   * rows. A NEW surface has no legacy rows to accommodate, so it carries
   * `hasLegacyFallback: false` and MUST require a non-optional `instanceId` in
   * its start schema — the DR-2 new-surface rule the conformance test enforces.
   */
  readonly hasLegacyFallback: boolean;
  /**
   * Derive the canonical per-instance liveness key from a raw event `data`
   * payload. Returns `undefined` when no key can be derived (e.g. `data` is
   * absent or missing every fallback field) — never throws.
   */
  readonly instanceKeyOf: (data: Record<string, unknown> | undefined) => string | undefined;
}

// ─── Field-reading helpers ───────────────────────────────────────────────────

/** Read a non-empty string field off a raw event payload, or `undefined`. */
function readStringField(
  data: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!data) return undefined;
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ─── Per-surface instanceKeyOf derivations ──────────────────────────────────

function mergeInstanceKeyOf(data: Record<string, unknown> | undefined): string | undefined {
  const instanceId = readStringField(data, 'instanceId');
  if (instanceId !== undefined) return instanceId;
  const taskId = readStringField(data, 'taskId');
  if (taskId !== undefined) return taskId;
  const sourceBranch = readStringField(data, 'sourceBranch');
  const targetBranch = readStringField(data, 'targetBranch');
  if (sourceBranch !== undefined && targetBranch !== undefined) {
    return `${sourceBranch}→${targetBranch}`;
  }
  return undefined;
}

function launchInstanceKeyOf(data: Record<string, unknown> | undefined): string | undefined {
  return readStringField(data, 'instanceId') ?? readStringField(data, 'worktreeId');
}

/**
 * DR-2 singleton fallback key for a keyless legacy `mutation` row. The
 * pre-retrofit `orchestrate/mutation-adequacy.ts` liveness path stamped neither
 * `instanceId` nor `operationId`, so such a start would resolve to `undefined`
 * and be SKIPPED by the pairing fold — leaving a stuck mutation invisible to
 * `ps` / un-waitable, which contradicts DR-2's "keyless mutation → singleton
 * instance" AC. Resolving a constant key instead lets a keyless START pair with
 * its keyless TERMINAL (per stream, since `mutation` is `feature`-scoped). The
 * value is namespaced so it can never collide with a real emitter-minted key.
 */
export const MUTATION_LEGACY_SINGLETON_KEY = 'mutation:legacy-singleton';

function mutationInstanceKeyOf(data: Record<string, unknown> | undefined): string | undefined {
  // Canonical key (post-retrofit) → the emitter-minted `instanceId`. Defensive
  // fallback for any row carrying a bare `operationId`. A truly keyless legacy
  // row (neither field) resolves to the DR-2 singleton so it still pairs rather
  // than being silently dropped.
  return (
    readStringField(data, 'instanceId') ??
    readStringField(data, 'operationId') ??
    MUTATION_LEGACY_SINGLETON_KEY
  );
}

function pruneInstanceKeyOf(data: Record<string, unknown> | undefined): string | undefined {
  return readStringField(data, 'instanceId') ?? readStringField(data, 'operationId');
}

// ─── Envelope-derived startedAt ──────────────────────────────────────────────

/**
 * Derive the instant a liveness instance started from the event ENVELOPE
 * (`timestamp`) rather than a surface-specific data field — the one field
 * every persisted event carries uniformly, regardless of surface. Returns
 * `undefined` when the envelope carries no usable timestamp (defensive; real
 * `WorkflowEvent` rows always have one via the schema's default).
 */
export function livenessStartedAt(event: { readonly timestamp?: string }): string | undefined {
  return typeof event.timestamp === 'string' && event.timestamp.length > 0
    ? event.timestamp
    : undefined;
}

// ─── The registry ────────────────────────────────────────────────────────────

/**
 * One entry per INV-10 liveness surface. See the module doc for the full
 * canonical-key contract each `instanceKeyOf` mirrors from task 003's real
 * emitters (`orchestrate/execute-merge.ts`, `launcher/liveness.ts`,
 * `orchestrate/mutation-adequacy.ts`, `orchestrate/worktree/manager.ts`).
 */
export const LIVENESS_REGISTRY: Readonly<Record<LivenessSurface, LivenessDescriptor>> = {
  merge: {
    surface: 'merge',
    startType: 'merge.executing_started',
    // The INV-10 `<surface>.executing_started` + paired terminal pattern for
    // merge: `merge.executed` (success path) / `merge.recovered` (INV-14
    // recovery-ladder path) — per the `merge.executing_started` schema doc and
    // the `workflow-state-projection.ts` fold comment ("the terminal
    // merge.executed / merge.recovered events drive the phase").
    terminalTypes: ['merge.executed', 'merge.recovered'],
    streamScope: 'feature',
    hasLegacyFallback: true,
    instanceKeyOf: mergeInstanceKeyOf,
  },
  launch: {
    surface: 'launch',
    startType: 'launch.executing_started',
    terminalTypes: ['launch.executed'],
    streamScope: 'worktrees',
    hasLegacyFallback: true,
    instanceKeyOf: launchInstanceKeyOf,
  },
  mutation: {
    surface: 'mutation',
    startType: 'mutation.executing_started',
    terminalTypes: ['mutation.executed'],
    streamScope: 'feature',
    hasLegacyFallback: true,
    instanceKeyOf: mutationInstanceKeyOf,
  },
  prune: {
    surface: 'prune',
    startType: 'prune.executing_started',
    terminalTypes: ['prune.executed'],
    streamScope: 'worktrees',
    hasLegacyFallback: true,
    instanceKeyOf: pruneInstanceKeyOf,
  },
};

/** All registered descriptors, in declaration order. */
export const LIVENESS_DESCRIPTORS: readonly LivenessDescriptor[] =
  Object.values(LIVENESS_REGISTRY);

/** Look up a descriptor by surface. */
export function getLivenessDescriptor(surface: LivenessSurface): LivenessDescriptor {
  return LIVENESS_REGISTRY[surface];
}

/**
 * Look up a descriptor by its `startType` (the `<surface>.executing_started`
 * event type) — the reverse lookup a generic event-driven scanner uses.
 * Returns `undefined` for any type not registered as a liveness START.
 */
export function getLivenessDescriptorByStartType(
  startType: string,
): LivenessDescriptor | undefined {
  return LIVENESS_DESCRIPTORS.find((d) => d.startType === startType);
}

/** Every `<surface>.executing_started` type in the real event catalog. */
export function everyExecutingStartedType(): readonly string[] {
  return EventTypes.filter((t): t is EventType => t.endsWith('.executing_started'));
}

// ─── Pairing helper ──────────────────────────────────────────────────────────

/** One surviving in-flight instance: its resolved key, the stream it rides, and
 *  the START event that opened it (for envelope-derived `startedAt`). */
export interface InFlightInstance {
  /** The descriptor's own resolved `instanceKeyOf(startEvent.data)`. */
  readonly instanceKey: string;
  /** The stream the START event was persisted on (`undefined` for keyless
   *  fixtures). For `feature`-scoped surfaces this is the workflow's featureId. */
  readonly streamId: string | undefined;
  /** The `<surface>.executing_started` event that opened this instance. */
  readonly startEvent: LivenessEventLike;
}

/** NUL separator for the composite `(streamId, instanceKey)` pairing key — a
 *  byte neither a stream id nor an instance key ever contains, so the composite
 *  is unambiguous (`(streamId='a', key='b→c')` never collides with
 *  `(streamId='a→b', key='c')`). */
const PAIRING_KEY_SEP = String.fromCharCode(0);

/**
 * The DR-2 pairing key. `feature`-scoped surfaces pair PER STREAM — the same
 * `instanceKey` on two different feature streams is two DISTINCT instances, so a
 * terminal on one stream can never clear the other (the S-6 cross-stream
 * mis-pairing this feature exists to prevent). The singleton `worktrees` stream
 * pairs by `instanceKey` alone: concurrent launches/prunes on that one shared
 * stream are the NORMAL case, so cross-instance concurrency there is expected.
 */
function pairingKey(
  descriptor: LivenessDescriptor,
  instanceKey: string,
  streamId: string | undefined,
): string {
  return descriptor.streamScope === 'feature'
    ? `${streamId ?? ''}${PAIRING_KEY_SEP}${instanceKey}`
    : instanceKey;
}

/**
 * Fold an ordered event list into the set of liveness instances still IN
 * FLIGHT for one surface: a START with no paired TERMINAL (yet) after it in
 * the given order. For `feature`-scoped surfaces the pairing is keyed by
 * `(streamId, instanceKey)` so events from different workflow streams never
 * cross-contaminate; for the singleton `worktrees` scope it is keyed by
 * `instanceKey` alone (see {@link pairingKey}).
 *
 * Semantics, applied left-to-right over `events`:
 *   - a START event whose key resolves is recorded as in-flight (re-starting
 *     an already in-flight `(stream,key)` overwrites — the latest START wins,
 *     matching an idempotent-retry re-emission of the same key);
 *   - a TERMINAL event (any of `descriptor.terminalTypes`) whose key resolves
 *     clears that `(stream,key)` from the in-flight set (a terminal for an
 *     unknown/already-cleared key is a no-op, never a throw);
 *   - events whose key cannot be derived (`instanceKeyOf` returns `undefined`)
 *     are skipped — an unresolvable row can never be paired.
 *
 * Returns a map keyed by the internal pairing key; each value is the surviving
 * {@link InFlightInstance} (resolved `instanceKey`, `streamId`, and the START
 * event) so a caller can report the true key, "which workflow is stuck?", and
 * `startedAt` (via {@link livenessStartedAt}). `.size` is the count of distinct
 * in-flight instances — the `wait --operation` predicate reads exactly this.
 */
export function computeInFlightInstances(
  descriptor: LivenessDescriptor,
  events: readonly LivenessEventLike[],
): ReadonlyMap<string, InFlightInstance> {
  const inFlight = new Map<string, InFlightInstance>();
  const terminalTypes: readonly string[] = descriptor.terminalTypes;
  for (const event of events) {
    if (event.type === descriptor.startType) {
      const instanceKey = descriptor.instanceKeyOf(event.data);
      if (instanceKey === undefined) continue;
      inFlight.set(pairingKey(descriptor, instanceKey, event.streamId), {
        instanceKey,
        streamId: event.streamId,
        startEvent: event,
      });
      continue;
    }
    if (terminalTypes.includes(event.type)) {
      const instanceKey = descriptor.instanceKeyOf(event.data);
      if (instanceKey === undefined) continue;
      inFlight.delete(pairingKey(descriptor, instanceKey, event.streamId));
    }
  }
  return inFlight;
}
