import { z } from 'zod';

// ─── Next-actions discriminator schema (DR-8 / Preview-4 §4.4 / #1440 Op 4) ─
//
// `NextAction` is a Zod union keyed on `verb`. Most verbs (HSM transition
// names, `merge_orchestrate`, future control verbs) share the open base
// shape — verb-specific payload fields are not required. The
// `retry_with_task` verb (Preview-4 §4.4) carries a required
// `ttl_suggestion_ms: number` field so callers know what Tasks-augmented
// dispatch TTL to use when re-invoking. INV-5b requires that a new verb
// like `retry_with_task` lands as a first-class entry in this schema
// rather than as free-form prose.
//
// The union is *ordered*: the verb-specific branch (`retry_with_task`)
// must be tried before the catch-all `BaseNextActionSchema`, because the
// catch-all accepts any string verb and would otherwise short-circuit on
// the first member. Zod's `z.union` walks members in order, so listing the
// specific branch first preserves the discriminator contract.
//
// Adding a new verb-specific branch (T11+/future): append a new
// `z.object({ verb: z.literal('your_verb'), ...payload }).strict()` to the
// `verbBranches` list. The catch-all stays last.

/**
 * Shared fields every `NextAction` carries regardless of verb. Verb-specific
 * branches extend this base.
 *
 * - `verb`: control-verb name, snake_case (`merge_orchestrate`,
 *   `retry_with_task`, HSM target phase names like `plan`).
 * - `reason`: free-form, human-readable rationale.
 * - `validTargets`: optional list of canonical target identifiers.
 * - `hint`: optional free-form prose for the caller.
 * - `idempotencyKey`: empty strings rejected — empty keys would collapse
 *   unrelated invocations onto the same de-dup slot (DR-MO-1).
 */
const baseFields = {
  verb: z.string().min(1),
  reason: z.string(),
  validTargets: z.array(z.string()).optional(),
  hint: z.string().optional(),
  idempotencyKey: z.string().min(1).optional(),
} as const;

/**
 * Verbs that have a dedicated, verb-specific branch with required-payload
 * fields. The catch-all branch below explicitly excludes these so that a
 * malformed verb-specific payload (e.g. `retry_with_task` without
 * `ttl_suggestion_ms`) cannot quietly fall through to the open shape.
 *
 * When you add a new verb-specific branch, list its literal here too.
 */
const VERB_SPECIFIC_LITERALS = ['retry_with_task'] as const;

/**
 * Catch-all branch. Validates any verb whose payload is just the base
 * shape — HSM transition names, `merge_orchestrate`, `checkpoint`, etc.
 *
 * The `verb` refinement explicitly rejects any literal that has a
 * verb-specific branch above; otherwise Zod's `z.union` walks members in
 * order, and a malformed `{ verb: 'retry_with_task', reason: '...' }` (no
 * `ttl_suggestion_ms`) would fail the verb-specific branch and then
 * silently parse against this catch-all, defeating the discriminator
 * contract.
 *
 * Order matters: this MUST be the last member of the union so
 * verb-specific branches above are matched first.
 */
const BaseNextActionSchema = z.object({
  ...baseFields,
  verb: baseFields.verb.refine(
    (v) => !(VERB_SPECIFIC_LITERALS as readonly string[]).includes(v),
    {
      message:
        'verb has a dedicated discriminator branch; payload must match that branch',
    },
  ),
});

/**
 * `retry_with_task` branch (Preview-4 §4.4, #1440 Op 4).
 *
 * Emitted by the dispatch boundary when a `taskSuitable: true` action is
 * invoked **without** the `task: { ttl }` augmentation and the elapsed
 * dispatch time exceeds the threshold (default 10_000 ms). The verb
 * suggests the caller re-invoke the same action with `task: { ttl:
 * ttl_suggestion_ms }` to get live progress telemetry.
 *
 * `ttl_suggestion_ms` is REQUIRED — the whole point of the hint is to
 * teach callers what TTL to thread back. The dispatch boundary sources it
 * from `action.dispatch.taskTtlSuggestionMs ?? 60_000`.
 */
const RetryWithTaskNextActionSchema = z.object({
  ...baseFields,
  verb: z.literal('retry_with_task'),
  ttl_suggestion_ms: z.number().int().positive(),
});

/**
 * Schema for a suggested next action in a rehydration envelope (DR-8).
 *
 * Verb-keyed union. Adding a verb with a required-payload contract: prepend
 * a `z.object({ verb: z.literal('...'), ... })` branch to the union *before*
 * `BaseNextActionSchema`. Verbs that need only the base shape don't need a
 * dedicated branch — they validate via the catch-all.
 */
export const NextAction = z.union([
  RetryWithTaskNextActionSchema,
  BaseNextActionSchema,
]);

export type NextAction = z.infer<typeof NextAction>;
