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
 *   • mutation → `data.instanceId ?? data.operationId` (legacy fallback: the
 *     older `mutation-adequacy.ts` emission path predates the instanceId
 *     retrofit and stamps neither field on some rows; the operationId fallback
 *     is defensive so a future/foreign row that carries a bare `operationId`
 *     still resolves)
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

function mutationInstanceKeyOf(data: Record<string, unknown> | undefined): string | undefined {
  // Legacy-mutation fallback: rows from the pre-retrofit `mutation-adequacy.ts`
  // liveness path carry neither `instanceId` nor `operationId` today, but the
  // fallback stays defensive against any row (present or future) that carries
  // a bare `operationId` with no `instanceId`.
  return readStringField(data, 'instanceId') ?? readStringField(data, 'operationId');
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
 * `cli-commands/run-mutation.ts`, `orchestrate/worktree/manager.ts`).
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
    instanceKeyOf: mergeInstanceKeyOf,
  },
  launch: {
    surface: 'launch',
    startType: 'launch.executing_started',
    terminalTypes: ['launch.executed'],
    streamScope: 'worktrees',
    instanceKeyOf: launchInstanceKeyOf,
  },
  mutation: {
    surface: 'mutation',
    startType: 'mutation.executing_started',
    terminalTypes: ['mutation.executed'],
    streamScope: 'feature',
    instanceKeyOf: mutationInstanceKeyOf,
  },
  prune: {
    surface: 'prune',
    startType: 'prune.executing_started',
    terminalTypes: ['prune.executed'],
    streamScope: 'worktrees',
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

/**
 * Fold an ordered event list into the set of liveness instances still IN
 * FLIGHT for one surface: a START with no paired TERMINAL (yet) after it in
 * the given order. Applies the pairing purely at the instance-key level —
 * caller supplies whichever events are relevant to the descriptor's stream
 * scope (a `ps`/`wait` consumer filters to the right stream before calling
 * this).
 *
 * Semantics, applied left-to-right over `events`:
 *   - a START event whose key resolves is recorded as in-flight (re-starting
 *     an already in-flight key overwrites — the latest START wins, matching
 *     an idempotent-retry re-emission of the same key);
 *   - a TERMINAL event (any of `descriptor.terminalTypes`) whose key resolves
 *     clears that key from the in-flight set (a terminal for an unknown/
 *     already-cleared key is a no-op, never a throw);
 *   - events whose key cannot be derived (`instanceKeyOf` returns `undefined`)
 *     are skipped — an unresolvable row can never be paired.
 *
 * Returns a map of `instanceKey -> the START event that opened it`, so a
 * caller can report `startedAt` (via {@link livenessStartedAt}) alongside the
 * surviving in-flight set.
 */
export function computeInFlightInstances(
  descriptor: LivenessDescriptor,
  events: readonly LivenessEventLike[],
): ReadonlyMap<string, LivenessEventLike> {
  const inFlight = new Map<string, LivenessEventLike>();
  const terminalTypes: readonly string[] = descriptor.terminalTypes;
  for (const event of events) {
    if (event.type === descriptor.startType) {
      const key = descriptor.instanceKeyOf(event.data);
      if (key !== undefined) inFlight.set(key, event);
      continue;
    }
    if (terminalTypes.includes(event.type)) {
      const key = descriptor.instanceKeyOf(event.data);
      if (key !== undefined) inFlight.delete(key);
    }
  }
  return inFlight;
}
