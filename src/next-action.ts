/**
 * The `NextAction` schema, a Zod union keyed on `verb`, and the registry advertisement schema.
 *
 * Most verbs share the open base shape. A verb with a required payload, such as `retry_with_task`,
 * gets its own branch, so a new verb is a schema entry and not free-form prose. `z.union` tries
 * members in order, so each verb-specific branch comes before the catch-all.
 */
import { z } from 'zod';

/**
 * The fields that each `NextAction` carries. Verb-specific branches extend this base.
 *
 * - `verb`: a snake_case control verb such as `merge_orchestrate`, or an HSM target phase such as
 *   `plan`.
 * - `reason`: a free-form rationale for a human reader.
 * - `validTargets`: an optional list of canonical target identifiers.
 * - `hint`: optional free-form prose for the caller.
 * - `idempotencyKey`: the schema rejects an empty string, because empty keys put unrelated calls in
 *   the same de-dup slot.
 */
const baseFields = {
  verb: z.string().min(1),
  reason: z.string(),
  validTargets: z.array(z.string()).optional(),
  hint: z.string().optional(),
  idempotencyKey: z.string().min(1).optional(),
} as const;

/**
 * The verbs with a dedicated branch and required payload fields. The catch-all branch rejects them,
 * so a `retry_with_task` without `ttl_suggestion_ms` cannot pass as the open shape. A new
 * verb-specific branch must add its literal here.
 */
const VERB_SPECIFIC_LITERALS = ['retry_with_task'] as const;

/**
 * The catch-all branch for a verb with only the base payload, such as an HSM transition name or
 * `merge_orchestrate`. Its `verb` refinement rejects each verb with a dedicated branch. Without it,
 * a malformed `retry_with_task` fails its own branch and then parses here. This branch must be the
 * last member of the union.
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
 * The `retry_with_task` branch. Dispatch emits it when a `taskSuitable: true` action runs without
 * the `task: { ttl }` augmentation for more than 10000 ms. The caller can then call the action again
 * with `task: { ttl: ttl_suggestion_ms }` to get live progress.
 *
 * `ttl_suggestion_ms` is required, because the TTL is the purpose of the hint. Dispatch takes it
 * from `action.dispatch.taskTtlSuggestionMs ?? 60_000`.
 */
const RetryWithTaskNextActionSchema = z.object({
  ...baseFields,
  verb: z.literal('retry_with_task'),
  ttl_suggestion_ms: z.number().int().positive(),
});

/**
 * The schema of a suggested next action in a rehydration envelope. A verb with a required payload
 * gets a branch before `BaseNextActionSchema`. A verb with only the base shape uses the catch-all.
 */
export const NextAction = z.union([
  RetryWithTaskNextActionSchema,
  BaseNextActionSchema,
]);

export type NextAction = z.infer<typeof NextAction>;

/**
 * Control-owned next-action verbs. These stay on the HSM/control envelope
 * and are outside ActionId totality — they must never be published as
 * registry advertisements.
 */
export const CONTROL_OWNED_VERBS = [
  'retry_with_task',
  'divergent_loop',
] as const;

export type ControlOwnedVerb = (typeof CONTROL_OWNED_VERBS)[number];

const CONTROL_OWNED_VERB_SET: ReadonlySet<string> = new Set(CONTROL_OWNED_VERBS);

export function isControlOwnedVerb(verb: string): verb is ControlOwnedVerb {
  return CONTROL_OWNED_VERB_SET.has(verb);
}

/**
 * Registry advertisement envelope. Distinct from {@link NextAction}: an
 * advertised item is an allow-decided ActionId plus the workflow-scoped
 * subject it was decided against. Phase names and control verbs are not
 * members of this schema.
 */
export const RegistryAdvertisement = z
  .object({
    actionId: z
      .string()
      .min(1)
      .max(256)
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
        'ActionId may contain only letters, digits, dot, underscore, colon, and hyphen',
      ),
    subject: z
      .object({
        featureId: z.string().min(1).max(256),
        stream: z.string().min(1).max(256),
      })
      .strict(),
    digest: z
      .object({
        algorithm: z.literal('sha256'),
        value: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();

export type RegistryAdvertisement = z.infer<typeof RegistryAdvertisement>;

export function isRegistryAdvertisement(
  value: unknown,
): value is RegistryAdvertisement {
  return RegistryAdvertisement.safeParse(value).success;
}
