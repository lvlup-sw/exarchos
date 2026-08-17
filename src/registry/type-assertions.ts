import { EnvelopeSchema } from '../contract/schemas/envelope.js';
import { type ExtensionOutputSchema, vacuityWaiver, withCappedShape } from '../output-schema-declaration.js';
import type { VacuityWaiverId } from '../output-schema-vacuity-allowlist.js';
import { z } from 'zod';
import type { BuiltinCompositeTool, BuiltinToolAction, CompositeTool, ExtensionCompositeTool, ExtensionToolAction, ToolAction } from './types.js';

// ─── DR-4: vacuity is unconstructible at the ToolAction boundary ─────────────
//
// `OutputSchema_NewActionDeclaringVacuous_FailsCompile`, stated where it is
// enforced. These aliases live in a NON-TEST source file deliberately: the
// package tsconfig excludes `*.test.ts`, so the same claim written as a
// `@ts-expect-error` in a spec would never be checked by `npm run typecheck`.
// The `_Pola*` aliases in `capabilities/resolver.ts` are the precedent.
// `Expect<T extends true>` is a compile error unless T is exactly `true`.
type ExpectTrue<T extends true> = T;
type NotAssignableTo<A, B> = A extends B ? false : true;

/**
 * THE ACCEPTANCE CRITERION. `EnvelopeSchema(z.unknown())` — the expression 109
 * declaration sites used to write — cannot be assigned to the field. A new
 * action that reaches for it does not compile.
 * @proof
 */
export type _OutputSchemaNewActionDeclaringVacuousFailsCompile = ExpectTrue<
  NotAssignableTo<ReturnType<typeof EnvelopeSchema<z.ZodUnknown>>, BuiltinToolAction['outputSchema']>
>;
/**
 * …and it is not assignable to the CONSUMER union either, so nothing widened.
 * @proof
 */
export type _OutputSchemaNewActionDeclaringVacuousIsNotRegistered = ExpectTrue<
  NotAssignableTo<ReturnType<typeof EnvelopeSchema<z.ZodUnknown>>, ToolAction['outputSchema']>
>;
/**
 * The escape is closed too: an id that is not already seeded in the shrink-only
 * allowlist is not a `VacuityWaiverId`, so `vacuityWaiver('<new id>')` is also
 * a compile error. Waiving a NEW declaration requires editing the generated
 * seed file, which is exactly the reviewable act DR-4 wants it to be.
 * @proof
 */
export type _OutputSchemaNewActionCannotBeWaived = ExpectTrue<
  NotAssignableTo<'exarchos_view.a_brand_new_action', VacuityWaiverId>
>;
/**
 * TASK 060, HOLE 1 — THE ACCEPTANCE CRITERION.
 * `OutputSchema_RegistryActionUsingExtensionEscape_FailsCompile`, stated where
 * it is enforced. The out-of-registry escape returns `ExtensionOutputSchema`
 * (proved in `output-schema-declaration.ts`), and that type does not satisfy a
 * built-in declaration's `outputSchema`. A new action in this file that reaches
 * for `unregisteredActionOutputSchema()` does not compile — it no longer merely
 * reddens the runtime audit.
 * @proof
 */
export type _OutputSchemaRegistryActionUsingExtensionEscapeFailsCompile = ExpectTrue<
  NotAssignableTo<ExtensionOutputSchema, BuiltinToolAction['outputSchema']>
>;
/**
 * The same claim one level up: an extension action is not a registry declaration.
 * @proof
 */
export type _OutputSchemaExtensionActionIsNotABuiltinDeclaration = ExpectTrue<
  NotAssignableTo<ExtensionToolAction, BuiltinToolAction>
>;
/**
 * …and the DOOR is the registry constant, not a per-array annotation: a plain
 * `CompositeTool` (whose actions carry the consumer-facing union) is not a legal
 * `TOOL_REGISTRY` entry, so a new `readonly ToolAction[]` array cannot be
 * smuggled in beside the five that exist.
 * @proof
 */
export type _OutputSchemaRegistryDoorRejectsUnnarrowedTools = ExpectTrue<
  NotAssignableTo<CompositeTool, BuiltinCompositeTool>
>;
/**
 * And the guarantee is not vacuous — the two blessed constructors DO satisfy
 * a built-in declaration's field, and the escape DOES satisfy an extension
 * declaration's. Without these lines the aliases above would still pass if a
 * field had been narrowed to something nothing at all can produce, and the
 * `.exarchos.yml` surface could have been "closed" by breaking it.
 * @proof
 */
export type _OutputSchemaCappedShapeSatisfiesTheField = ExpectTrue<
  ReturnType<typeof withCappedShape> extends BuiltinToolAction['outputSchema'] ? true : false
>;
/** @proof */
export type _OutputSchemaWaiverSatisfiesTheField = ExpectTrue<
  ReturnType<typeof vacuityWaiver> extends BuiltinToolAction['outputSchema'] ? true : false
>;
/** @proof */
export type _OutputSchemaExtensionEscapeSatisfiesTheExtensionField = ExpectTrue<
  ExtensionOutputSchema extends ExtensionToolAction['outputSchema'] ? true : false
>;
/**
 * Both declaration types remain consumable as plain `ToolAction`s.
 * @proof
 */
export type _OutputSchemaBuiltinActionIsAToolAction = ExpectTrue<
  BuiltinToolAction extends ToolAction ? true : false
>;
/** @proof */
export type _OutputSchemaExtensionActionIsAToolAction = ExpectTrue<
  ExtensionToolAction extends ToolAction ? true : false
>;
/** @proof */
export type _OutputSchemaExtensionToolIsACompositeTool = ExpectTrue<
  ExtensionCompositeTool extends CompositeTool ? true : false
>;
