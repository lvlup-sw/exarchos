// ─── Posture → dispatch-shape table (DR-25) ────────────────────────────────
//
// A provisioning verb that declares a `posture` but not the LAUNCH SHAPE the
// orchestrator must use has declared a posture it does not bind. The
// orchestrator then improvises the harness invocation, and for a `read-only`
// posture the natural improvisation — a `name` without `isolation` — spawns an
// idle mailbox teammate that never runs the prompt. The spawn returns success,
// the agent emits idle pings that read like progress, and the review never
// happens.
//
// Live incident (2026-08-07): the plan-review panel was provisioned
// `posture: 'read-only'`, dispatched with `name` and no isolation, and produced
// three phantom teammates and zero verdicts. `ListAgents` omitted them
// entirely; recovery via a follow-up message also failed. Only a fresh
// anonymous dispatch worked.
//
// This module makes the launch shape DATA the verb reads, not prose in a skill:
//
//   read-only       → anonymous async subagent (a `name` is FORBIDDEN)
//   task-isolated   → named subagent PLUS worktree isolation
//   shared-mutating → main worktree, never a subagent
//
// Editing rules:
//   - Every value of the declared `AgentPosture` enum must have EXACTLY ONE
//     entry. The totality test enumerates `AgentPosture.options` (the Zod
//     declaration), so a posture added there without an entry here fails the
//     suite. The mapping cannot be partial.
//   - Each entry declares the harness capabilities it REQUIRES and, when a
//     runtime cannot honour them, the FALLBACK shape to use instead. A fallback
//     must still RUN THE PROMPT — degrading to a shape that spawns something
//     which never executes is the exact defect this table exists to remove.
//   - An entry with `fallback: null` is terminal: on an undeclared capability
//     the resolution is a TYPED ERROR, never a silent no-op (INV-4).
//
// The posture TYPE is taken from `types.ts` (the interface declaration), NOT
// from `spec.ts` (the Zod declaration). The two are deliberate twins that
// `spec.ts` requires be kept in sync, and keeping this module off the Zod
// module makes them two INDEPENDENT authorities: the totality test enumerates
// `spec.ts`'s runtime enum and checks it against this table, which is typed off
// `types.ts`. Neither reaches the other in the import graph, so the census
// cannot pass by comparing one authority with itself (DR-30).
//
// Implements: DR-25.

import type { AgentPosture } from './types.js';
import type { Capability } from './capabilities.js';
import type { SupportLevel } from './adapters/types.js';

// ─── Launch mechanics ───────────────────────────────────────────────────────

/**
 * How the harness spawn is addressed.
 *
 * `'anonymous'` is a PROHIBITION, not a default: the `name` field must be
 * OMITTED. Supplying one converts an async subagent into a named teammate that
 * sits in a mailbox waiting for a message it will never be sent.
 */
export type DispatchNaming = 'anonymous' | 'named';

/** The workspace the dispatched work must run in. */
export type DispatchWorkspace =
  /** The caller's own checkout — no isolation is materialized. */
  | 'inherited'
  /** A dedicated worktree the harness materializes for the spawn. */
  | 'worktree'
  /** The repository's main worktree, explicitly NOT a subagent workspace. */
  | 'main-worktree';

/**
 * The mechanical launch parameters of a dispatch — the part an orchestrator
 * must reproduce verbatim when it calls the harness.
 */
export interface DispatchLaunch {
  /** Hand the work to a subagent at all? `false` ⇒ the caller runs it itself. */
  readonly subagent: boolean;
  /** Whether the spawn may carry a `name`. */
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

// ─── The table ──────────────────────────────────────────────────────────────

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
  // Read-only reviewers, researchers, and the plan-review panel. Worktree
  // isolation is genuinely pointless here — the agent mutates nothing — so the
  // shape is a plain anonymous async subagent. The `name` field is FORBIDDEN,
  // not merely unnecessary: naming the spawn is what produced three phantom
  // teammates and zero verdicts on 2026-08-07.
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

  // Implementers, fixers, and scaffolders dispatched across a wave. These
  // mutate, so the worktree boundary is what contains the blast radius, and the
  // name is what lets the orchestrator address and merge each one. Named WITH
  // isolation — the two travel together or not at all.
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

  // Orchestrators and migration runners that mutate shared state. This posture
  // is NOT a subagent shape at all — it runs in the main worktree, in the
  // caller's own process. There is no degradation path: a dispatch that cannot
  // write cannot be honoured by any other shape.
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

/** Frozen posture → dispatch-shape map. Direct lookups are O(1). */
export const POSTURE_DISPATCH_MAP: Readonly<Record<AgentPosture, DispatchShape>> =
  Object.freeze({
    'read-only': Object.freeze(RAW_DISPATCH_MAP['read-only']),
    'task-isolated': Object.freeze(RAW_DISPATCH_MAP['task-isolated']),
    'shared-mutating': Object.freeze(RAW_DISPATCH_MAP['shared-mutating']),
  });

/**
 * The postures this table actually binds — its OWN key set, read off the frozen
 * object at runtime.
 *
 * Deliberately NOT a read of the posture declaration: the totality test's job is
 * to check this key set AGAINST that declaration, and a helper that returned the
 * declaration would make the comparison a tautology.
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

// ─── Runtime resolution (INV-4 platform agnosticity) ────────────────────────

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
 * Outcome of resolving a posture's shape against a runtime's declaration.
 *
 * `degraded: true` is the DECLARED fallback, carried alongside the shape it
 * replaced and the capabilities that forced the swap — a caller can see it
 * degraded and say so. It is never a quiet substitution.
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
 * Resolve the dispatch shape for `posture` against a runtime's declared
 * capabilities.
 *
 * Omit `runtime` to get the canonical shape unresolved — the provisioning verbs
 * do this, because the verb does not know which harness the orchestrator will
 * launch on. The emitted shape carries its own `requires` and `fallback`, so
 * the host can run this same resolution against its own declaration.
 *
 * When the runtime does not declare a required capability `native`, the DECLARED
 * fallback is returned with `degraded: true`. When there is no fallback — or the
 * fallback is itself unmet — the result is a typed
 * {@link DISPATCH_SHAPE_UNSUPPORTED} error (INV-4).
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

// ─── Validation (the self-test surface) ─────────────────────────────────────

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
 * Validate that a launch shape is one the posture actually admits.
 *
 * This is what makes the contract binding rather than descriptive: a
 * `read-only` provisioning carrying a named, worktree-isolated launch is
 * REJECTED, because the `read-only` entry admits no named launch. The set is
 * derived from the table, so it cannot drift from the policy it enforces.
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

// ─── Structural guards over unknown payloads ────────────────────────────────

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
 * Validate an emitted provisioning payload: it must declare a known `posture`
 * AND a `dispatch` launch shape that posture admits.
 *
 * Takes `unknown` so a serialized result (a frozen fixture, an MCP response
 * read back off the wire) can be checked without being trusted. The three
 * failure modes are named separately because they mean different things:
 *
 *   - no `posture`  — the payload is not a provisioning contract at all.
 *   - no `dispatch` — the payload declares a posture it does not BIND. This is
 *     the pre-DR-25 shape, and the reason task 047's kill fixture exists.
 *   - contradictory `dispatch` — the payload binds a shape the posture forbids.
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
