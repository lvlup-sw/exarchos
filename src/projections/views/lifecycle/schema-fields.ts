/**
 * Shared field shapes of the lifecycle verbs `ps`, `wait`, `inspect` and `export`.
 *
 * Each verb imports its field shapes from here, so the verbs cannot drift apart.
 * `buildRegistrationSchema` flattens the actions of `exarchos_view` into one strict object.
 * It throws at module load when two actions give one field name a different contract: a
 * different base kind, enum value set or default. Optionality and refinements such as `.min()`
 * do not count, because the handler schema checks them again through dispatch.
 *
 * Where a name also exists on another `exarchos_view` action, the shape here matches that
 * contract exactly. `registry.construction.test.ts` pins this.
 */
import { z } from 'zod';
import { coercedPositiveInt } from '../../../coerce.js';

/**
 * Shared `scope` selector: the union of the scope values of each action. `pipeline` acts on
 * `repo` and `all`. `ps` accepts `workflow`, `worktree` and `all`, and rejects `repo`. Each
 * handler checks its own subset. The registration guard needs only the same value set on each action that declares `scope`.
 */
export const scopeField = z.enum(['repo', 'all', 'workflow', 'worktree']);

/**
 * Workflow status filter for `ps`, and terminal status for `wait`. It is a string, not an enum,
 * because the two verbs accept different sets. Each verb checks its own set at the handler.
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

/** `export` destination file path, by default `./<featureId>-export.zip`. It is a path, not a format enum. */
export const outputField = z.string();

/**
 * Liveness surface for `wait --operation <surface>`. It is a string, not an enum, because the
 * liveness-descriptor registry defines the valid surfaces. `wait` checks the surface and its
 * feature-scope eligibility against that registry at the handler.
 */
export const operationField = z.string();

/**
 * Map from field name to shape, for programmatic composition such as the registration guard
 * test. Verb handlers import the single `*Field` constants.
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

/** The lifecycle field names that this module defines. */
export type LifecycleFieldName = keyof typeof LIFECYCLE_FIELD_SHAPES;
