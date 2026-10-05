/**
 * The `outputSchema` declaration surface. A built-in action cannot declare a vacuous output schema
 * such as `EnvelopeSchema(z.unknown())` unless the vacuity allowlist names it.
 *
 * Two brands control construction. {@link DeclaredOutputSchema} comes only from
 * {@link withCappedShape} and {@link vacuityWaiver}, and `BuiltinToolAction` accepts only that
 * brand. {@link ExtensionOutputSchema} comes only from {@link unregisteredActionOutputSchema}, for
 * `.exarchos.yml` custom tools and the oracle probe. Neither brand is assignable to the other.
 *
 * The brand is a `unique symbol` property that `Object.assign` attaches. This needs no type
 * assertion, keeps object identity, and lets tests observe the brand at run time. The run-time
 * checks are `auditVacuityAllowlist` and `auditVacuitySeedIntegrity` in
 * `tools/conformance/src/output-schema-census.ts`.
 */
import { z } from 'zod';
import { EnvelopeSchema } from './contract/schemas/envelope.js';
import { extractEnvelopeDataSchema } from './verbs/worktree/schemas.js';
import { acceptsEveryValue } from './contract/schemas/schema-totality.js';
import type { VacuityWaiverId } from './output-schema-vacuity-allowlist.js';

/**
 * The nominal marker on each schema that this module brands. It is exported only because
 * `declaration: true` cannot emit a `.d.ts` for {@link DeclaredOutputSchema} with a private symbol.
 * A forged brand needs a visible `Object.assign`, and `auditVacuityAllowlist` still reports the
 * vacuity.
 */
export const OUTPUT_SCHEMA_BRAND: unique symbol = Symbol('exarchos.outputSchema.declared');

const DECLARED_BRAND: 'declared' = 'declared';
const EXTENSION_BRAND: 'extension' = 'extension';

/**
 * An `outputSchema` from a registry constructor, {@link withCappedShape} or {@link vacuityWaiver}.
 * It is assignable to `z.ZodType`, so the consumers of `action.outputSchema` need no change. A bare
 * `z.ZodType` or an {@link ExtensionOutputSchema} is not assignable to it.
 */
export type DeclaredOutputSchema = z.ZodType & {
  readonly [OUTPUT_SCHEMA_BRAND]: typeof DECLARED_BRAND;
};

/**
 * An `outputSchema` for an action outside the built-in registry: a `.exarchos.yml` custom tool or
 * the oracle registration probe. Only {@link unregisteredActionOutputSchema} makes one. Its brand
 * value differs, so it cannot satisfy `BuiltinToolAction.outputSchema`.
 */
export type ExtensionOutputSchema = z.ZodType & {
  readonly [OUTPUT_SCHEMA_BRAND]: typeof EXTENSION_BRAND;
};

/**
 * Either brand. `ToolAction`, the type that each consumer of a registered action reads, declares
 * it, so consumers handle built-in and extension actions the same way. The declaration types
 * `BuiltinToolAction` and `ExtensionToolAction` apply the narrowing.
 */
export type RegisteredOutputSchema = DeclaredOutputSchema | ExtensionOutputSchema;

/**
 * Attaches the registry brand. It is not exported, because an exported function that brands any
 * schema bypasses the compile-time check.
 */
function declareOutputSchema(schema: z.ZodType): DeclaredOutputSchema {
  return Object.assign(schema, { [OUTPUT_SCHEMA_BRAND]: DECLARED_BRAND });
}

/** Attaches the extension brand. It is not exported, for the same reason. */
function declareExtensionOutputSchema(schema: z.ZodType): ExtensionOutputSchema {
  return Object.assign(schema, { [OUTPUT_SCHEMA_BRAND]: EXTENSION_BRAND });
}

/** Runtime counterpart of the registry brand, so tests can observe the closed set. */
export function isDeclaredOutputSchema(schema: z.ZodType): schema is DeclaredOutputSchema {
  return OUTPUT_SCHEMA_BRAND in schema && schema[OUTPUT_SCHEMA_BRAND] === DECLARED_BRAND;
}

/**
 * The run-time check for the extension brand. The two predicates are mutually exclusive, so a test
 * can observe the split. Each live `TOOL_REGISTRY` declaration gives `true` for
 * {@link isDeclaredOutputSchema} and `false` here.
 */
export function isExtensionOutputSchema(schema: z.ZodType): schema is ExtensionOutputSchema {
  return OUTPUT_SCHEMA_BRAND in schema && schema[OUTPUT_SCHEMA_BRAND] === EXTENSION_BRAND;
}

/**
 * The generic capped `data` shape. The dispatch economy emits it for an over-budget response with
 * no summarizer. It holds a `summary`, `counts` by group, and a `firstPage` preview.
 *
 * {@link withCappedShape} adds it to each typed-`data` output schema. The MCP validator replaces a
 * response that does not match the schema with an `INTERNAL_ERROR`, so each typed schema must also
 * accept the capped shape. `.passthrough()` accepts the extra fields that a summarizer adds.
 */
export const CappedDataSchema = z
  .object({
    summary: z.union([z.string(), z.record(z.string(), z.unknown())]),
    counts: z.record(z.string(), z.number()),
    firstPage: z.array(z.unknown()),
  })
  .passthrough();

/**
 * Adds {@link CappedDataSchema} to the `data` branch of an `EnvelopeSchema(...)` output schema. The
 * result stays one `success`-keyed envelope union, so `extractEnvelopeDataSchema` still reads it as
 * typed. This is the only constructor of a substantive `outputSchema`.
 *
 * It throws for a schema that is not an envelope, because that schema has no `data` branch to
 * widen. It throws for a base `data` that accepts every value, because the capped union is then
 * still total but classifies as substantive.
 */
export function withCappedShape(outputSchema: z.ZodType): DeclaredOutputSchema {
  const baseData = extractEnvelopeDataSchema(outputSchema);
  if (baseData === undefined) {
    throw new Error(
      'withCappedShape: refusing a non-envelope `outputSchema` — ' +
        '`extractEnvelopeDataSchema` found no `data` branch to widen with ' +
        'CappedDataSchema, so this constructor cannot do the job it exists to ' +
        'do. Wrap the schema in EnvelopeSchema(<data schema>) first, or if the ' +
        'declaration is genuinely vacuous, record the debt with ' +
        'vacuityWaiver(<id>) so it stays on the shrink-only allowlist.',
    );
  }

  if (acceptsEveryValue(baseData)) {
    throw new Error(
      'withCappedShape: refusing a base whose `data` already accepts every value. ' +
        'Capping it would produce a union that is still total but classifies as ' +
        'substantive. Declare a real `data` shape, or record the debt with ' +
        'vacuityWaiver(<id>) so it stays on the shrink-only allowlist.',
    );
  }

  return declareOutputSchema(EnvelopeSchema(z.union([baseData, CappedDataSchema])));
}

/**
 * Declares a known-vacuous `outputSchema` against its allowlist entry. The `id` type is
 * {@link VacuityWaiverId}, the literal union of the seeded ids, so a new declaration cannot get a
 * waiver. The run-time audit fails when a waived declaration stops being vacuous.
 *
 * `schema` defaults to `EnvelopeSchema(z.unknown())`. A declaration with a named vacuous schema
 * passes it, so the action keeps its advertised shape. The function reads nothing from `id` at run
 * time, because the audit resolves ids from the census.
 */
export function vacuityWaiver(
  id: VacuityWaiverId,
  schema: z.ZodType = EnvelopeSchema(z.unknown()),
): DeclaredOutputSchema {
  void id;
  return declareOutputSchema(schema);
}

/**
 * The escape for actions outside the built-in registry, which have no census id: `.exarchos.yml`
 * custom tools (`config/register.ts`) and the oracle registration probe
 * (`contract/oracle/fixtures.ts`). Their names come from config or a fixture, so no literal union
 * can cover them.
 *
 * It returns an {@link ExtensionOutputSchema}, so a registry action that uses it fails
 * `npm run typecheck`. `auditVacuityAllowlist` still reports vacuity that reaches the registry by
 * another path, such as a forged brand.
 */
export function unregisteredActionOutputSchema(): ExtensionOutputSchema {
  return declareExtensionOutputSchema(EnvelopeSchema(z.unknown()));
}

/**
 * A compile error unless `T` is exactly `true`. The proof aliases below live in a non-test file,
 * because the package tsconfig excludes `*.test.ts`, so the build does not check a test file.
 */
type Expect<T extends true> = T;
type IsNotAssignable<A, B> = A extends B ? false : true;

/**
 * The vacuous envelope is not a declared schema.
 * @proof
 */
export type _OutputSchemaVacuousEnvelopeIsNotDeclared = Expect<
  IsNotAssignable<ReturnType<typeof EnvelopeSchema<z.ZodUnknown>>, DeclaredOutputSchema>
>;
/**
 * Neither is a TYPED envelope that skipped the constructor.
 * @proof
 */
export type _OutputSchemaUnbrandedTypedEnvelopeIsNotDeclared = Expect<
  IsNotAssignable<ReturnType<typeof EnvelopeSchema<z.ZodObject>>, DeclaredOutputSchema>
>;
/**
 * Nor is a bare `z.ZodType`.
 * @proof
 */
export type _OutputSchemaBareZodTypeIsNotDeclared = Expect<
  IsNotAssignable<z.ZodType, DeclaredOutputSchema>
>;
/**
 * An id that is not seeded cannot get a waiver, so the allowlist can only shrink.
 * @proof
 */
export type _OutputSchemaUnseededIdCannotBeWaived = Expect<
  IsNotAssignable<'exarchos_workflow.a_brand_new_action', VacuityWaiverId>
>;
/**
 * The out-of-registry escape has a different brand, so it cannot satisfy
 * `BuiltinToolAction.outputSchema`. `registry/type-assertions.ts` proves that `BuiltinToolAction`
 * rejects it.
 * @proof
 */
export type _OutputSchemaExtensionEscapeIsNotDeclared = Expect<
  IsNotAssignable<ReturnType<typeof unregisteredActionOutputSchema>, DeclaredOutputSchema>
>;
/**
 * …and symmetrically, a registry-blessed schema is not an extension schema.
 * @proof
 */
export type _OutputSchemaDeclaredIsNotExtension = Expect<
  IsNotAssignable<ReturnType<typeof withCappedShape>, ExtensionOutputSchema>
>;
/** @proof */
export type _OutputSchemaWaiverIsNotExtension = Expect<
  IsNotAssignable<ReturnType<typeof vacuityWaiver>, ExtensionOutputSchema>
>;
/**
 * Each of the three constructors produces its brand, so the negative proofs above reject only the
 * wrong brand. Without these proofs, a brand that nothing can produce leaves each negative proof
 * green.
 * @proof
 */
export type _OutputSchemaCappedShapeIsDeclared = Expect<
  ReturnType<typeof withCappedShape> extends DeclaredOutputSchema ? true : false
>;
/** @proof */
export type _OutputSchemaWaiverIsDeclared = Expect<
  ReturnType<typeof vacuityWaiver> extends DeclaredOutputSchema ? true : false
>;
/** @proof */
export type _OutputSchemaEscapeIsExtension = Expect<
  ReturnType<typeof unregisteredActionOutputSchema> extends ExtensionOutputSchema ? true : false
>;
/**
 * A declared schema is still a `z.ZodType`, so consumers need no change.
 * @proof
 */
export type _OutputSchemaDeclaredIsStillZodType = Expect<
  DeclaredOutputSchema extends z.ZodType ? true : false
>;
/**
 * …and so is an extension schema — `ToolAction` consumers see one shape.
 * @proof
 */
export type _OutputSchemaExtensionIsStillZodType = Expect<
  ExtensionOutputSchema extends z.ZodType ? true : false
>;
/**
 * Both brands satisfy the consumer union.
 * @proof
 */
export type _OutputSchemaBothBrandsAreRegistered = Expect<
  DeclaredOutputSchema extends RegisteredOutputSchema
    ? ExtensionOutputSchema extends RegisteredOutputSchema
      ? true
      : false
    : false
>;
