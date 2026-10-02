/**
 * Liveness descriptor registry.
 *
 * Four liveness surfaces (merge, launch, mutation, prune) each emit a
 * `<surface>.executing_started` claim and one or more terminal events. Each
 * registry entry declares the whole contract for one surface: the start event,
 * the terminal events, the stream, and the instance key. Consumers such as `ps`
 * and `wait --operation` read this registry, so a new surface adds one entry here.
 *
 * Each `instanceKeyOf` reads `data.instanceId` first and then a legacy fallback.
 * It returns `undefined` when it cannot derive a key, and it never throws.
 * {@link livenessStartedAt} reads the envelope `timestamp`, because only `merge`
 * carries its own `data.startedAt`.
 */

import type { EventType } from './schemas.js';
import { EventTypes } from './schemas.js';

/** The four liveness surfaces that this registry describes. */
export type LivenessSurface = 'merge' | 'launch' | 'mutation' | 'prune';

/**
 * The stream family of a surface. `'feature'` is the feature stream of each
 * workflow, so the registry cannot pin a literal stream name. `'worktrees'` is
 * the one `worktrees` stream that all workflows share.
 */
export type LivenessStreamScope = 'feature' | 'worktrees';

/** The minimal event shape for pairing. `WorkflowEvent` rows and test fixtures satisfy it. */
export interface LivenessEventLike {
  readonly type: string;
  readonly data?: Record<string, unknown> | undefined;
  /**
   * The stream that holds this event. `feature`-scoped surfaces pair per stream,
   * so two workflows with the same merge `instanceKey` cannot clear each other.
   * Fixtures for `feature`-scoped surfaces need it. When it is absent, pairing
   * uses the empty stream.
   */
  readonly streamId?: string | undefined;
}

/** One registry entry: the whole liveness contract for a single surface. */
export interface LivenessDescriptor {
  /** The surface this descriptor describes. */
  readonly surface: LivenessSurface;
  /** The `<surface>.executing_started` CLAIM event type. */
  readonly startType: EventType;
  /**
   * The paired terminal event types. Merge has two: `merge.executed` for success
   * and `merge.recovered` for rollback.
   */
  readonly terminalTypes: readonly EventType[];
  /** Which stream family the pair rides on. */
  readonly streamScope: LivenessStreamScope;
  /**
   * True when the surface can derive a key from legacy rows without `instanceId`.
   * All four shipped surfaces can. A new surface has no legacy rows, so it sets
   * `false` and its start schema must require `instanceId`. The conformance test
   * enforces this rule.
   */
  readonly hasLegacyFallback: boolean;
  /**
   * Derive the per-instance liveness key from a raw event `data` payload.
   * Returns `undefined` when no key is available, and never throws.
   */
  readonly instanceKeyOf: (data: Record<string, unknown> | undefined) => string | undefined;
}

/** Read a non-empty string field off a raw event payload, or `undefined`. */
function readStringField(
  data: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!data) return undefined;
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

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
 * Fallback key for a legacy `mutation` row that has neither `instanceId` nor
 * `operationId`. Without it, the pairing fold skips such a start, and `ps` and
 * `wait` cannot see a stuck mutation. A keyless start pairs with its keyless
 * terminal on the same stream. The prefix keeps it apart from real keys.
 */
export const MUTATION_LEGACY_SINGLETON_KEY = 'mutation:legacy-singleton';

function mutationInstanceKeyOf(data: Record<string, unknown> | undefined): string | undefined {
  return (
    readStringField(data, 'instanceId') ??
    readStringField(data, 'operationId') ??
    MUTATION_LEGACY_SINGLETON_KEY
  );
}

function pruneInstanceKeyOf(data: Record<string, unknown> | undefined): string | undefined {
  return readStringField(data, 'instanceId') ?? readStringField(data, 'operationId');
}

/**
 * Derive the start instant of a liveness instance from the envelope `timestamp`,
 * which every persisted event carries. Returns `undefined` when the envelope has
 * no usable timestamp.
 */
export function livenessStartedAt(event: { readonly timestamp?: string }): string | undefined {
  return typeof event.timestamp === 'string' && event.timestamp.length > 0
    ? event.timestamp
    : undefined;
}

/**
 * One entry per liveness surface. Each `instanceKeyOf` matches the keys that the
 * real emitters write: `verbs/pure/execute-merge.ts`, `runtime/launcher/liveness.ts`,
 * `verbs/gates/mutation-adequacy.ts`, and `verbs/worktree/manager.ts`.
 */
export const LIVENESS_REGISTRY: Readonly<Record<LivenessSurface, LivenessDescriptor>> = {
  merge: {
    surface: 'merge',
    startType: 'merge.executing_started',
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

/**
 * NUL separator for the composite `(streamId, instanceKey)` pairing key. Neither
 * a stream id nor an instance key contains NUL, so the composite is unambiguous.
 */
const PAIRING_KEY_SEP = String.fromCharCode(0);

/**
 * The pairing key. `feature`-scoped surfaces pair per stream, so one `instanceKey`
 * on two feature streams is two distinct instances. A terminal on one stream never
 * clears the other. The shared `worktrees` stream pairs by `instanceKey` alone,
 * because concurrent launches and prunes on that stream are normal.
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
 * Fold an ordered event list into the instances of one surface that are still in
 * flight: a start with no paired terminal after it. Keys follow {@link pairingKey}.
 *
 * A start records its key, and a later start with the same key replaces it.
 * A terminal removes its key, and a terminal for an unknown key does nothing.
 * The fold skips events with no derivable key. The map size is the count of
 * in-flight instances, which `wait --operation` reads.
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
