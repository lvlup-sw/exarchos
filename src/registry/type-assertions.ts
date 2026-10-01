import { EnvelopeSchema } from '../contract/schemas/envelope.js';
import { type ExtensionOutputSchema, vacuityWaiver, withCappedShape } from '../output-schema-declaration.js';
import type { VacuityWaiverId } from '../output-schema-vacuity-allowlist.js';
import { z } from 'zod';
import type { ActionContract } from './action-contract.js';
import type { BuiltinCompositeTool, BuiltinToolAction, CompositeTool, ContractedToolAction, ExtensionCompositeTool, ExtensionToolAction, ToolAction } from './types.js';

/**
 * Compiles only when `T` is exactly `true`. The proof aliases in this file live in a source file,
 * because the package tsconfig excludes `*.test.ts`, so `npm run typecheck` does not check a spec.
 */
type ExpectTrue<T extends true> = T;
type NotAssignableTo<A, B> = A extends B ? false : true;

/**
 * A vacuous `EnvelopeSchema(z.unknown())` is not assignable to the `outputSchema` of a built-in
 * action. A new action that uses it does not compile.
 * @proof
 */
export type _OutputSchemaNewActionDeclaringVacuousFailsCompile = ExpectTrue<
  NotAssignableTo<ReturnType<typeof EnvelopeSchema<z.ZodUnknown>>, BuiltinToolAction['outputSchema']>
>;
/**
 * The vacuous envelope is not assignable to the consumer union either, so nothing widened.
 * @proof
 */
export type _OutputSchemaNewActionDeclaringVacuousIsNotRegistered = ExpectTrue<
  NotAssignableTo<ReturnType<typeof EnvelopeSchema<z.ZodUnknown>>, ToolAction['outputSchema']>
>;
/**
 * An id that is not in the shrink-only allowlist is not a `VacuityWaiverId`. So a waiver for a new
 * action needs an edit to the generated seed file, which a reviewer sees.
 * @proof
 */
export type _OutputSchemaNewActionCannotBeWaived = ExpectTrue<
  NotAssignableTo<'exarchos_view.a_brand_new_action', VacuityWaiverId>
>;
/**
 * The out-of-registry escape returns `ExtensionOutputSchema`, which does not satisfy the
 * `outputSchema` of a built-in action. A registry action that uses
 * `unregisteredActionOutputSchema()` does not compile.
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
 * The registry constant enforces the type, not each action array. A plain `CompositeTool` is not a
 * legal `TOOL_REGISTRY` entry, so a new `readonly ToolAction[]` array cannot enter the registry.
 * @proof
 */
export type _OutputSchemaRegistryDoorRejectsUnnarrowedTools = ExpectTrue<
  NotAssignableTo<CompositeTool, BuiltinCompositeTool>
>;
/**
 * The two approved constructors satisfy the built-in field, and the escape satisfies the extension
 * field. These aliases keep the checks above from passing on a field that nothing can produce.
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
/**
 * Omitting the contract block is not assignable to the contracted action
 * type. A built-in or extension action plus a complete contract is.
 * @proof
 */
export type _ActionContractOmittedFromToolActionFailsCompile = ExpectTrue<
  NotAssignableTo<ToolAction, ContractedToolAction>
>;
/** @proof */
export type _ActionContractOmittedFromBuiltinActionFailsCompile = ExpectTrue<
  NotAssignableTo<Omit<BuiltinToolAction, 'actionContract'>, BuiltinToolAction>
>;
/** @proof */
export type _ActionContractOmittedFromExtensionActionFailsCompile = ExpectTrue<
  NotAssignableTo<Omit<ExtensionToolAction, 'actionContract'>, ExtensionToolAction>
>;
/** @proof */
export type _ActionContractSatisfiesContractedToolAction = ExpectTrue<
  ToolAction & { readonly actionContract: ActionContract } extends ContractedToolAction ? true : false
>;
/** @proof */
export type _OutputSchemaExtensionToolIsACompositeTool = ExpectTrue<
  ExtensionCompositeTool extends CompositeTool ? true : false
>;
