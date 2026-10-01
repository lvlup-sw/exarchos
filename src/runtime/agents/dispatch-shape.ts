/**
 * The table from agent posture to dispatch shape. A provisioning verb reads it, so the orchestrator does not improvise the harness invocation.
 * For a `read-only` posture, the natural improvisation is a `name` without isolation. That spawns an idle mailbox teammate that never runs the prompt.
 *
 *   read-only       → anonymous async subagent (a `name` is forbidden)
 *   task-isolated   → named subagent plus worktree isolation
 *   shared-mutating → main worktree, never a subagent
 *
 * Rules for an edit:
 *   - Each `AgentPosture` value must have exactly one entry. The totality test enumerates `AgentPosture.options` and fails on a missing entry.
 *   - A fallback must still run the prompt. With `fallback: null`, an unmet capability gives a typed error, not a silent no-op.
 *   - `deepFreezeTable` must reach each nested object or array of an entry.
 *   - The posture type comes from `types.ts`, not from the Zod enum in `spec.ts`. Thus the totality test compares two independent authorities.
 */

import type { AgentPosture } from './types.js';
import type { Capability } from './capabilities.js';
import type { SupportLevel } from './adapters/types.js';

/**
 * How the harness spawn is addressed.
 *
 * `'anonymous'` is a PROHIBITION, not a default: the `name` field must be
 * OMITTED. Supplying one converts an async subagent into a named teammate that
 * sits in a mailbox waiting for a message it will never be sent.
 */
export type DispatchNaming = 'anonymous' | 'named';

/**
 * The workspace that the dispatched work must run in.
 *   - `inherited` — the checkout of the caller, with no isolation.
 *   - `worktree` — a dedicated worktree that the harness creates for the spawn.
 *   - `main-worktree` — the main worktree of the repository, not a subagent workspace.
 */
export type DispatchWorkspace =
  | 'inherited'
  | 'worktree'
  | 'main-worktree';

/**
 * The mechanical launch parameters of a dispatch — the part an orchestrator
 * must reproduce verbatim when it calls the harness.
 */
export interface DispatchLaunch {
  /** Hand the work to a subagent at all? `false` ⇒ the caller runs it itself. */
  readonly subagent: boolean;
  /** Whether the spawn can carry a `name`. */
  readonly naming: DispatchNaming;
  /** Workspace the work must run in. */
  readonly workspace: DispatchWorkspace;
}

/**
 * A posture's bound dispatch shape: the launch parameters plus the harness
 * capabilities required to honour them and the declared degradation path.
 */
export interface DispatchShape extends DispatchLaunch {
  /** The posture this shape binds to — self-identifying once detached. */
  readonly posture: AgentPosture;
  /**
   * Harness capabilities that must be declared `native` by the target runtime
   * before this shape can be honoured.
   */
  readonly requires: readonly Capability[];
  /**
   * The shape to use when `requires` is not met. `null` ⇒ terminal: the
   * dispatch cannot be honoured and resolution yields a typed error.
   * A fallback's own `fallback` is always `null` (one hop, no chains).
   */
  readonly fallback: DispatchShape | null;
  /** Operator-facing statement of what this shape prevents. */
  readonly rationale: string;
}

const READ_ONLY_FALLBACK: DispatchShape = {
  posture: 'read-only',
  subagent: false,
  naming: 'anonymous',
  workspace: 'inherited',
  requires: ['fs:read'],
  fallback: null,
  rationale:
    'The runtime declares no native subagent spawn, so the caller performs the ' +
    'read-only pass inline in its own context. Degraded: the pass is no longer ' +
    'fresh-context, which the caller must surface. Still runs the prompt — the ' +
    'one property a fallback may never trade away.',
};

const TASK_ISOLATED_FALLBACK: DispatchShape = {
  posture: 'task-isolated',
  subagent: true,
  naming: 'anonymous',
  workspace: 'inherited',
  requires: ['subagent:spawn', 'fs:write'],
  fallback: null,
  rationale:
    'The runtime declares no native worktree isolation or named-teammate ' +
    'addressing, so the work is dispatched ANONYMOUSLY into the shared ' +
    'checkout and the wave must be serialized by the caller. Deliberately NOT ' +
    'named-without-isolation: that is the shape that spawns an idle mailbox ' +
    'teammate which never runs the prompt (the 2026-08-07 incident).',
};

const RAW_DISPATCH_MAP: Readonly<Record<AgentPosture, DispatchShape>> = {
  /**
   * Read-only reviewers, researchers, and the plan-review panel. They mutate nothing, so worktree isolation has no use.
   * The `name` field is forbidden. A named spawn produced three phantom teammates and zero verdicts on 2026-08-07.
   */
  'read-only': {
    posture: 'read-only',
    subagent: true,
    naming: 'anonymous',
    workspace: 'inherited',
    requires: ['subagent:spawn', 'fs:read'],
    fallback: READ_ONLY_FALLBACK,
    rationale:
      'Anonymous async subagent. A `name` MUST be omitted: a named spawn ' +
      'without isolation becomes an idle mailbox teammate that acknowledges ' +
      'the spawn, emits idle pings that read like progress, and never runs the ' +
      'prompt.',
  },

  /**
   * Implementers, fixers, and scaffolders across a wave. The worktree contains the blast radius.
   * The name lets the orchestrator address and merge each one.
   */
  'task-isolated': {
    posture: 'task-isolated',
    subagent: true,
    naming: 'named',
    workspace: 'worktree',
    requires: ['subagent:spawn', 'isolation:worktree', 'team:agent-teams', 'fs:write'],
    fallback: TASK_ISOLATED_FALLBACK,
    rationale:
      'Named subagent PLUS worktree isolation. The name and the worktree are ' +
      'one shape: a name without a worktree is an unrunnable mailbox teammate, ' +
      'and a worktree without a name is unaddressable for merge.',
  },

  /**
   * Orchestrators and migration runners that mutate shared state. They run in the main worktree, in the process of the caller.
   * There is no fallback, because no other shape can honor a dispatch that cannot write.
   */
  'shared-mutating': {
    posture: 'shared-mutating',
    subagent: false,
    naming: 'anonymous',
    workspace: 'main-worktree',
    requires: ['fs:write'],
    fallback: null,
    rationale:
      'Main worktree, never a subagent. Handing shared-state mutation to an ' +
      'isolated subagent silently splits the single-writer path; handing it to ' +
      'a named teammate loses the writes entirely.',
  },
};

/** Freeze a shape, its `requires` array, and its `fallback`, recursively. The freeze is in place, so the return value is the input reference. */
function deepFreezeShape(shape: DispatchShape): DispatchShape {
  Object.freeze(shape.requires);
  if (shape.fallback !== null) deepFreezeShape(shape.fallback);
  return Object.freeze(shape);
}

/**
 * Freeze the table, each entry, and each object that an entry reaches.
 * It iterates the own values of the table, so a new posture entry is frozen with no change here.
 */
function deepFreezeTable(
  table: Readonly<Record<AgentPosture, DispatchShape>>,
): Readonly<Record<AgentPosture, DispatchShape>> {
  for (const shape of Object.values(table)) deepFreezeShape(shape);
  return Object.freeze(table);
}

/**
 * The posture to dispatch-shape map, frozen transitively: the map, each entry, each `requires` array, and each `fallback`.
 * `dispatchShapeFor` and `resolveDispatchShape` hand out shared references. Without a runtime freeze, one mutation corrupts each later dispatch.
 * `DispatchShape_FallbackMutationAttempt_LeavesTheSharedShapeIntact` attempts real mutations to prove the freeze.
 */
export const POSTURE_DISPATCH_MAP: Readonly<Record<AgentPosture, DispatchShape>> =
  deepFreezeTable(RAW_DISPATCH_MAP);

/**
 * The postures that this table binds: its own key set, read from the frozen object at runtime.
 * It does not read the posture declaration, because the totality test compares this key set with that declaration.
 */
export function posturesWithDispatchShape(): readonly AgentPosture[] {
  return Object.keys(POSTURE_DISPATCH_MAP).filter(isDispatchablePosture);
}

/** Does the table bind a dispatch shape for this value? */
function isDispatchablePosture(value: unknown): value is AgentPosture {
  return typeof value === 'string' && Object.hasOwn(POSTURE_DISPATCH_MAP, value);
}

/** Resolve a posture's canonical dispatch shape. Total over `AgentPosture`. */
export function dispatchShapeFor(posture: AgentPosture): DispatchShape {
  return POSTURE_DISPATCH_MAP[posture];
}

/**
 * The subset of a `RuntimeAdapter` this module needs: the runtime's own
 * declaration of which capabilities it supports natively. Structural, so any
 * adapter satisfies it without this module importing the adapter graph.
 */
export interface RuntimeCapabilityDeclaration {
  readonly runtime: string;
  readonly supportLevels: Readonly<Record<Capability, SupportLevel>>;
}

/** Stable error code for a dispatch shape no runtime shape can honour. */
export const DISPATCH_SHAPE_UNSUPPORTED = 'DISPATCH_SHAPE_UNSUPPORTED';

/** A dispatch that cannot be honoured. Typed — never a silent no-op. */
export interface DispatchShapeError {
  readonly code: typeof DISPATCH_SHAPE_UNSUPPORTED;
  readonly message: string;
  readonly posture: AgentPosture;
  readonly runtime: string;
  /** Capabilities the runtime does not declare `native`. */
  readonly unmet: readonly Capability[];
}

/**
 * The result of a resolution of the shape of a posture against the declaration of a runtime.
 * `degraded: true` carries the declared fallback, the replaced shape, and the capabilities that forced the swap. Thus a caller can report the degradation.
 */
export type DispatchResolution =
  | { readonly honoured: true; readonly degraded: false; readonly shape: DispatchShape }
  | {
      readonly honoured: true;
      readonly degraded: true;
      readonly shape: DispatchShape;
      readonly declaredShape: DispatchShape;
      readonly unmet: readonly Capability[];
      readonly reason: string;
    }
  | { readonly honoured: false; readonly error: DispatchShapeError };

/**
 * Capabilities the runtime does NOT declare `native`.
 *
 * `advisory` counts as unmet on purpose: the adapter contract defines it as
 * "accepted without error, but the runtime has no primitive to enforce or
 * expose it" — which is precisely the silent-degradation surface. A shape whose
 * isolation is merely tolerated is a shape whose isolation does not exist.
 */
function unmetCapabilities(
  shape: DispatchShape,
  runtime: RuntimeCapabilityDeclaration,
): readonly Capability[] {
  return shape.requires.filter((cap) => runtime.supportLevels[cap] !== 'native');
}

/**
 * Resolve the dispatch shape for `posture` against the declared capabilities of a runtime.
 * Without `runtime`, the result is the canonical shape. The provisioning verbs omit it, because they do not know the harness of the orchestrator.
 * The shape carries its `requires` and `fallback`, so the host can do the same resolution against its own declaration.
 *
 * When a required capability is not `native`, the result is the declared fallback with `degraded: true`.
 * With no fallback, or with an unmet fallback, the result is a typed {@link DISPATCH_SHAPE_UNSUPPORTED} error.
 */
export function resolveDispatchShape(
  posture: AgentPosture,
  runtime?: RuntimeCapabilityDeclaration,
): DispatchResolution {
  const shape = dispatchShapeFor(posture);
  if (!runtime) return { honoured: true, degraded: false, shape };

  const unmet = unmetCapabilities(shape, runtime);
  if (unmet.length === 0) return { honoured: true, degraded: false, shape };

  const fallback = shape.fallback;
  if (fallback === null) {
    return {
      honoured: false,
      error: {
        code: DISPATCH_SHAPE_UNSUPPORTED,
        message:
          `runtime "${runtime.runtime}" does not natively declare ${unmet.join(', ')}, ` +
          `and posture "${posture}" declares no fallback dispatch shape — the dispatch ` +
          `cannot be honoured`,
        posture,
        runtime: runtime.runtime,
        unmet,
      },
    };
  }

  const fallbackUnmet = unmetCapabilities(fallback, runtime);
  if (fallbackUnmet.length > 0) {
    return {
      honoured: false,
      error: {
        code: DISPATCH_SHAPE_UNSUPPORTED,
        message:
          `runtime "${runtime.runtime}" does not natively declare ${fallbackUnmet.join(', ')}, ` +
          `which posture "${posture}"'s fallback dispatch shape also requires — the dispatch ` +
          `cannot be honoured`,
        posture,
        runtime: runtime.runtime,
        unmet: fallbackUnmet,
      },
    };
  }

  return {
    honoured: true,
    degraded: true,
    shape: fallback,
    declaredShape: shape,
    unmet,
    reason: fallback.rationale,
  };
}

/** Outcome of validating an emitted dispatch shape against its posture. */
export type DispatchValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * The launch shapes a posture admits: its canonical shape and, when declared,
 * its fallback. Derived from the table — there is no second list to drift.
 */
export function admissibleLaunches(posture: AgentPosture): readonly DispatchLaunch[] {
  const shape = dispatchShapeFor(posture);
  return shape.fallback === null ? [shape] : [shape, shape.fallback];
}

function sameLaunch(a: DispatchLaunch, b: DispatchLaunch): boolean {
  return a.subagent === b.subagent && a.naming === b.naming && a.workspace === b.workspace;
}

function describeLaunch(launch: DispatchLaunch): string {
  return `{ subagent: ${launch.subagent}, naming: "${launch.naming}", workspace: "${launch.workspace}" }`;
}

/**
 * Validate that the posture admits a launch shape. This check makes the contract binding, not only descriptive.
 * For example, a `read-only` provisioning with a named, worktree-isolated launch fails, because the `read-only` entry admits no named launch.
 */
export function validateDispatchShape(
  posture: AgentPosture,
  launch: DispatchLaunch,
): DispatchValidation {
  const admissible = admissibleLaunches(posture);
  if (admissible.some((candidate) => sameLaunch(candidate, launch))) return { ok: true };
  return {
    ok: false,
    reason:
      `dispatch shape ${describeLaunch(launch)} contradicts posture "${posture}": ` +
      `admissible shapes are ${admissible.map(describeLaunch).join(' | ')}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const NAMINGS: readonly DispatchNaming[] = ['anonymous', 'named'];
const WORKSPACES: readonly DispatchWorkspace[] = ['inherited', 'worktree', 'main-worktree'];

function isNaming(value: unknown): value is DispatchNaming {
  return NAMINGS.some((n) => n === value);
}

function isWorkspace(value: unknown): value is DispatchWorkspace {
  return WORKSPACES.some((w) => w === value);
}

function isDispatchLaunch(value: unknown): value is DispatchLaunch {
  if (!isRecord(value)) return false;
  return (
    typeof value.subagent === 'boolean' && isNaming(value.naming) && isWorkspace(value.workspace)
  );
}

/**
 * Validate an emitted provisioning payload. It must declare a known `posture` and a `dispatch` launch shape that the posture admits.
 * It takes `unknown`, so a serialized result, such as a fixture or an MCP response, gets a check without trust.
 * Each failure mode has its own reason, because each means a different thing:
 *   - no known `posture` — the payload is not a provisioning contract.
 *   - no `dispatch` — the payload declares a posture that it does not bind.
 *   - a malformed `dispatch` — the field is not a valid launch shape.
 *   - a contradictory `dispatch` — the payload binds a shape that the posture forbids.
 */
export function validateProvisionedDispatch(value: unknown): DispatchValidation {
  if (!isRecord(value)) {
    return { ok: false, reason: 'provisioning payload is not an object' };
  }
  if (!isDispatchablePosture(value.posture)) {
    return {
      ok: false,
      reason:
        `provisioning payload declares no posture this table binds (got ${JSON.stringify(value.posture)}); ` +
        `bound postures are ${posturesWithDispatchShape().join(', ')}`,
    };
  }
  if (value.dispatch === undefined) {
    return {
      ok: false,
      reason:
        `provisioning payload declares posture "${value.posture}" but carries no \`dispatch\` ` +
        `field — the launch shape is unbound, so the orchestrator must improvise it (DR-25)`,
    };
  }
  if (!isDispatchLaunch(value.dispatch)) {
    return {
      ok: false,
      reason:
        `provisioning payload for posture "${value.posture}" carries a malformed \`dispatch\` ` +
        `field: expected { subagent: boolean, naming: ${NAMINGS.join('|')}, ` +
        `workspace: ${WORKSPACES.join('|')} }`,
    };
  }
  return validateDispatchShape(value.posture, value.dispatch);
}
