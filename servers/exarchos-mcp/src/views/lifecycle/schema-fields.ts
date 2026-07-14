// ─── Shared lifecycle-verb field shapes (DR-8) ──────────────────────────────
//
// One canonical Zod definition per lifecycle field name. Every lifecycle verb
// (`ps` / `wait` / `inspect` / `export`) imports the SAME shape from here
// instead of redefining it inline, so the four verb schemas cannot drift a
// shared field's base type apart from one another.
//
// WHY THIS MODULE EXISTS — the registry-THROW footgun
// `buildRegistrationSchema` (registry.ts) flattens every action of a composite
// tool (`exarchos_view`) into ONE strict object. Its field-contract guard
// THROWS if two actions declare the same field name with a divergent
// *contract*: a different base kind (enum/string/number/boolean/...), a
// different enum value set, or a different default. (Optionality and
// refinements like `.min()`/`.positive()` are contract-neutral — the per-action
// handler schema re-validates those via dispatch.) So two view actions that
// declare `scope` with DIFFERENT enum value sets would crash MCP registration
// at module load — which is exactly why `scope` is defined ONCE here and every
// action that carries a scope axis imports THIS shape.
//
// BASE-TYPE ALIGNMENT (where a name ALSO exists on an existing view action)
// The four names below already appear on shipped `exarchos_view` actions; the
// canonical shape here is aligned to the EXISTING contract EXACTLY so the
// composed registration never throws. `registry.construction.test.ts` pins this
// (both the "does not throw" guard and the base-type-match assertions):
//   • scope        → z.enum(['repo','all','workflow','worktree'])  (the UNION —
//                     `pipeline` uses the ['repo','all'] members, `ps` uses the
//                     ['workflow','worktree','all'] members; both import THIS shape)
//   • phase        → z.string()               (matches `invariants_effective.phase`)
//   • workflowType → z.string()               (matches `invariants_effective.workflowType`)
//   • limit        → coercedPositiveInt()      (matches the shared `limit` on
//                                               pipeline/tasks/stack_status/etc.)
//
// SCOPE — the UNION resolution (DR-3, task 007)
// `ps` needs a `workflow|worktree|all` axis; `pipeline` (GA) uses `repo|all`.
// Two actions declaring `scope` with divergent enum value sets on the SAME tool
// make `buildRegistrationSchema` THROW. Task 007 resolved this by WIDENING this
// shared shape to the additive UNION of both value sets and migrating
// `pipeline.scope` onto it — so the tool carries ONE `scope` definition (no
// collision). Every existing `pipeline` value (`repo`/`all`) is still valid, and
// each action validates its OWN subset at the handler: `pipeline` acts on
// `repo`/`all` (and ignores `workflow`/`worktree`); `ps` accepts
// `workflow`/`worktree`/`all` and REJECTS `repo`. The registration-flattener
// only cares that the enum value SET matches across actions — it does; per-action
// subset enforcement is a handler concern, re-validated via dispatch.
//
// The remaining names are new to `exarchos_view`, so their base type is a free
// (but deliberate) choice; each is documented at its declaration.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { coercedPositiveInt } from '../../coerce.js';

/**
 * `scope` — the shared scoping selector across `exarchos_view` (DR-3, task 007).
 * The UNION of every action's scope members so ONE definition serves both
 * `pipeline` (`repo`/`all`) and `ps` (`workflow`/`worktree`/`all`) without a
 * flattener collision. Each action validates its own subset at the handler
 * (`pipeline` acts on `repo`/`all`; `ps` accepts `workflow`/`worktree`/`all` and
 * rejects `repo`) — the registration guard only requires the enum value SET to
 * match across the actions that declare it, which this single shape guarantees.
 */
export const scopeField = z.enum(['repo', 'all', 'workflow', 'worktree']);

/**
 * `status` — workflow status filter (`ps`) / terminal-status predicate
 * (`wait`). Base type `z.string()`, not an enum: the two consumers accept
 * different valid sets — `ps` filters any workflow status (active + terminal),
 * `wait` resolves only on a terminal status (`completed`/`failed`/`cancelled`)
 * — so a single shared enum would be wrong for one of them. Each verb validates
 * its own valid set at the handler. No existing `exarchos_view` field collision.
 */
export const statusField = z.string();

/**
 * `phase` — SDLC phase name. COLLIDES with `invariants_effective.phase`, so the
 * base type is pinned to that action's `z.string()` contract.
 */
export const phaseField = z.string();

/**
 * `workflowType` — workflow-kind filter. COLLIDES with
 * `invariants_effective.workflowType`, so the base type is pinned to that
 * action's `z.string()` contract.
 */
export const workflowTypeField = z.string();

/**
 * `all` — boolean "include completed/cancelled" (unfiltered) flag. Base type
 * `z.boolean()`. No existing `exarchos_view` field collision.
 */
export const allField = z.boolean();

/**
 * `follow` — boolean `--follow` streaming flag (`inspect`). Base type
 * `z.boolean()`. No existing `exarchos_view` field collision.
 */
export const followField = z.boolean();

/**
 * `limit` — bounded-output item cap. COLLIDES with the shared `limit` declared
 * across `pipeline`/`tasks`/`stack_status`/… so the base type is pinned to the
 * exact `coercedPositiveInt()` (number, coerces numeric strings) those actions
 * use. Reusing the same factory keeps the flattened contract identical.
 */
export const limitField = coercedPositiveInt();

/**
 * `output` — `export` destination FILE PATH (DR-6: default
 * `./<featureId>-export.zip`). Base type `z.string()` — it is a path, NOT a
 * `table|json` format enum. No existing `exarchos_view` field collision.
 */
export const outputField = z.string();

/**
 * `operation` — `wait --operation <surface>` liveness surface selector (the S-6
 * predicate). Base type `z.string()`, not an enum: the valid surface set is the
 * live liveness-descriptor registry (extensible — new surfaces land as one
 * registry entry), so `wait` validates the surface (and its feature-scope
 * eligibility) against that registry at the handler rather than freezing a
 * hardcoded enum here. No existing `exarchos_view` field collision.
 */
export const operationField = z.string();

/**
 * Name → canonical shape map, for programmatic composition (e.g. the
 * registration-construction guard test) and to keep the field roster in one
 * place. Verb handlers normally import the individual `*Field` consts.
 */
export const LIFECYCLE_FIELD_SHAPES = {
  scope: scopeField,
  status: statusField,
  phase: phaseField,
  workflowType: workflowTypeField,
  all: allField,
  follow: followField,
  limit: limitField,
  output: outputField,
  operation: operationField,
} as const;

/** The canonical lifecycle field names this module defines (DR-8). */
export type LifecycleFieldName = keyof typeof LIFECYCLE_FIELD_SHAPES;
