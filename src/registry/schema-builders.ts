import { digestText } from '../contract/authority-digest.js';
import { z } from 'zod';
import {
  actionContractCanonicalBytes,
  normalizeActionContract,
  type ActionContract,
} from './action-contract.js';
import type { CompositeTool, ToolAction } from './types.js';

// ─── Schema Generation ──────────────────────────────────────────────────────

/** A ZodObject whose shape includes an `action` discriminator key. */
type ActionDiscriminatedSchema = z.ZodObject<{ action: z.ZodType } & z.ZodRawShape>;

/**
 * Builds a Zod discriminated union from a list of ToolActions.
 * Each action's schema is extended with an `action: z.literal(name)` discriminator.
 *
 * Note (Zod v4): `ZodDiscriminatedUnion` swapped its generic order. The
 * declaration is now `<Options, Disc>` (tuple first, discriminator second);
 * v3 used `<Disc, Options>`.
 */
export function buildCompositeSchema(
  actions: readonly ToolAction[],
): z.ZodDiscriminatedUnion<[ActionDiscriminatedSchema, ...ActionDiscriminatedSchema[]], 'action'> {
  if (actions.length < 2) {
    throw new Error('buildCompositeSchema requires at least 2 actions for a discriminated union');
  }

  // The .extend() call adds { action: z.literal(name) } to each schema, but
  // TypeScript cannot infer the discriminator key through .map(). The assertion
  // is safe because every schema is extended with an `action` literal field.
  const schemas = actions.map((action) =>
    action.schema.extend({ action: z.literal(action.name) }),
  ) as ActionDiscriminatedSchema[];

  // Zod discriminatedUnion requires a tuple of [first, ...rest]
  const [first, ...rest] = schemas;
  if (first === undefined) {
    throw new Error('buildCompositeSchema requires at least 2 actions for a discriminated union');
  }
  return z.discriminatedUnion('action', [first, ...rest]);
}

/**
 * Unwraps `z.preprocess()` effects so zodToJsonSchema emits the inner
 * schema's type (e.g., `{"type":"object"}`) instead of an opaque
 * `{"allOf":[{},{"type":"object"}]}` wrapper.  Handles both bare and
 * optional-wrapped preprocess effects.
 *
 * The preprocess coercion still runs at validation time via the original
 * action schemas in `buildCompositeSchema` — this only affects the JSON
 * Schema sent to tool callers.
 *
 * Zod v4 unified `ZodEffects` into `ZodPipe`. A `z.preprocess(fn, inner)`
 * is now a `ZodPipe` whose `def.in` is a `ZodTransform` and whose `def.out`
 * is the original `inner` schema. We detect that exact shape rather than
 * matching every `ZodPipe` — `.transform()` is also a `ZodPipe` but with
 * `transform` as `def.out`, which we don't want to unwrap (the wire-level
 * type is the inner schema's output, not its input).
 */
function isPreprocessPipe(schema: z.ZodType): schema is z.ZodPipe {
  if (!(schema instanceof z.ZodPipe)) return false;
  const def = schema._zod.def;
  return def.in._zod.def.type === 'transform';
}

function unwrapPreprocess(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional) {
    // Zod v4 types `innerType` as the core `$ZodType` (the internal base
    // interface) rather than the classic `ZodType`. Cast at the boundary;
    // the runtime instance is always a classic schema in practice.
    const inner = schema._zod.def.innerType as z.ZodType;
    if (isPreprocessPipe(inner)) {
      return (inner._zod.def.out as z.ZodType).optional();
    }
  }
  if (isPreprocessPipe(schema)) {
    return schema._zod.def.out as z.ZodType;
  }
  return schema;
}

/**
 * Builds a strict Zod object schema for MCP SDK tool registration.
 *
 * The MCP SDK's `normalizeObjectSchema` cannot generate JSON Schema from
 * discriminated unions, so we flatten the composite schema into a single
 * object with `action` as a required enum and all other fields as optional.
 *
 * The composite handler performs action-level routing and the underlying
 * handlers validate required fields per action.
 *
 * The returned schema uses `.strict()` so that unrecognized parameter names
 * (e.g., `streamId` instead of `stream`) produce clear validation errors
 * instead of being silently dropped.
 *
 * Preprocess effects are unwrapped so zodToJsonSchema emits clean type
 * constraints (e.g., `{"type":"object"}`) rather than opaque wrappers.
 * Runtime coercion is preserved via the original schemas in buildCompositeSchema.
 */
export function buildRegistrationSchema(
  actions: readonly ToolAction[],
): z.ZodObject<z.ZodRawShape> {
  const actionNames = actions.map((a) => a.name) as [string, ...string[]];
  // Zod v4 typed `ZodRawShape` as `Readonly<{[k:string]:$ZodType}>`, so the
  // builder uses a plain mutable record and casts at the `z.object(...)`
  // boundary. Behavior is unchanged: the resulting object still has the
  // same shape and `.strict()` semantics.
  const shape: Record<string, z.ZodType> = {
    action: z.enum(actionNames),
  };
  // Track the first action to declare each field. A later action declaring the
  // same field with an incompatible enum value set or differing default is a
  // #1127-class collision — the composite's "first wins" merge silently
  // shadowed the later declaration at the MCP-registration boundary.
  // Constraint drift (min/max, pattern, optionality) is allowed: handler-level
  // schemas re-validate via dispatch(), so "first wins" is harmless there.
  const provenance = new Map<string, { action: string; contract: FieldContract }>();

  for (const action of actions) {
    const fields = action.schema.shape;
    for (const [key, zodType] of Object.entries(fields)) {
      const field = unwrapPreprocess(zodType as z.ZodType);
      const contract = fieldContract(field);

      const prior = provenance.get(key);
      if (prior) {
        const conflict = describeContractConflict(prior.contract, contract);
        if (conflict) {
          throw new Error(
            `buildRegistrationSchema: field '${key}' declared by action '${action.name}' collides with the declaration from action '${prior.action}'. ${conflict} ` +
            `Rename the field in one action (see agent_spec.outputFormat, #1127) or align the declarations.`,
          );
        }
        continue; // compatible — first wins preserved
      }

      shape[key] = field.isOptional() ? field : field.optional();
      provenance.set(key, { action: action.name, contract });
    }
  }

  return z.object(shape as z.ZodRawShape).strict();
}

/**
 * Contract-level view of a Zod field, capturing only the properties whose
 * divergence across actions causes MCP-registration-time hazards: the enum
 * value set and the default value. Base type is tracked solely to distinguish
 * enum-vs-non-enum collisions. Refinements and optionality are ignored.
 */
interface FieldContract {
  readonly kind: 'enum' | 'string' | 'number' | 'boolean' | 'array' | 'object' | 'other';
  readonly enumValues: readonly string[] | null; // present iff kind === 'enum'
  readonly defaultValue: string | null; // JSON-stringified default, null if none
}

function fieldContract(zodType: z.ZodType): FieldContract {
  const inner = unwrapOptional(zodType);
  const enumValues = extractEnumValues(inner);
  const defaultValue = extractDefault(inner);
  return {
    kind: enumValues ? 'enum' : baseKind(inner),
    enumValues,
    defaultValue: defaultValue === undefined ? null : JSON.stringify(defaultValue),
  };
}

function baseKind(schema: z.ZodType): FieldContract['kind'] {
  let current: z.ZodType = schema;
  // Zod v4: `_def` was renamed to `_zod.def`. Inner-type peeling now uses
  // `_zod.def.innerType`.
  if (current instanceof z.ZodDefault) current = current._zod.def.innerType as z.ZodType;
  if (current instanceof z.ZodOptional) current = current._zod.def.innerType as z.ZodType;
  if (current instanceof z.ZodString) return 'string';
  // Number covers z.number() and z.number().int() — JSON Schema distinguishes
  // them as number vs integer, but the per-handler schema re-validates
  // refinements, so at the composite boundary they're the same contract.
  if (current instanceof z.ZodNumber) return 'number';
  if (current instanceof z.ZodBoolean) return 'boolean';
  if (current instanceof z.ZodArray) return 'array';
  if (current instanceof z.ZodObject || current instanceof z.ZodRecord) return 'object';
  return 'other';
}

function unwrapOptional(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema;
  // Peel Optional and Nullable wrappers. Keep Default wrappers — the default
  // is a contract-level attribute we explicitly want to inspect.
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    current = current._zod.def.innerType as z.ZodType;
  }
  return current;
}

function extractEnumValues(schema: z.ZodType): readonly string[] | null {
  const current = peelEnumWrappers(schema);
  if (current instanceof z.ZodEnum) {
    // Zod v4 unified `ZodEnum` and `ZodNativeEnum` into a single `ZodEnum`
    // whose `def.entries` is a `{ name: value }` map. For string enums the
    // map is `{x:'x', y:'y'}`; for numeric TS enums it round-trips both
    // member names and values via reverse mapping
    // (`{'0':'A', '1':'B', A:0, B:1}`). Stringify-dedupe to produce a
    // stable, comparable value set across both shapes.
    const raw = Object.values(current._zod.def.entries as Record<string, unknown>);
    return [...new Set(raw.map((v) => JSON.stringify(v)))].sort();
  }
  if (current instanceof z.ZodLiteral) {
    // Treat a literal as a 1-member enum so two actions declaring the same
    // field with different literal values collide instead of silently
    // shadowing each other (#1127-class hazard). Zod v4 changed
    // `ZodLiteral.def` from `{ value: T }` to `{ values: T[] }` (an array
    // — a literal can now carry multiple permitted values in one schema).
    const values = current._zod.def.values as readonly unknown[];
    return [...new Set(values.map((v) => JSON.stringify(v)))].sort();
  }
  if (current instanceof z.ZodUnion) {
    // Union-of-literals is the hand-rolled form of z.enum(). Collect the
    // literal values; fall back to null if any branch isn't a literal so
    // heterogeneous unions (e.g. string | string[]) still classify via
    // baseKind instead of being falsely flagged as enum-compatible.
    const options = current._zod.def.options as readonly z.ZodType[];
    const literalValues: string[] = [];
    for (const opt of options) {
      const peeled = peelEnumWrappers(opt);
      if (!(peeled instanceof z.ZodLiteral)) return null;
      const lits = peeled._zod.def.values as readonly unknown[];
      for (const v of lits) literalValues.push(JSON.stringify(v));
    }
    return [...new Set(literalValues)].sort();
  }
  return null;
}

/** Peel ZodDefault / ZodOptional / ZodNullable wrappers so the caller can
 *  match on the underlying enum-ish kind. Kept narrow on purpose: ZodPipe and
 *  ZodBranded are NOT peeled, because both change the wire-level contract and
 *  deserve to be classified distinctly. */
function peelEnumWrappers(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema;
  while (
    current instanceof z.ZodDefault ||
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable
  ) {
    current = current._zod.def.innerType as z.ZodType;
  }
  return current;
}

function extractDefault(schema: z.ZodType): unknown {
  if (schema instanceof z.ZodDefault) {
    // Zod v4: `def.defaultValue` is the value itself (not a getter
    // function). v3 stored a `() => T` thunk that we had to invoke; v4
    // resolves the lazy form internally and exposes the materialized
    // value on the def. See `$ZodDefaultDef.defaultValue` in
    // zod/v4/core/schemas.d.ts.
    return schema._zod.def.defaultValue;
  }
  return undefined;
}

function describeContractConflict(a: FieldContract, b: FieldContract): string | null {
  if (a.kind !== b.kind) {
    return `Base types differ: ${a.kind} vs ${b.kind}.`;
  }
  if (a.kind === 'enum') {
    if (
      !a.enumValues ||
      !b.enumValues ||
      a.enumValues.length !== b.enumValues.length ||
      a.enumValues.some((v, i) => v !== b.enumValues![i])
    ) {
      return `Enum value sets differ: [${a.enumValues?.join(', ')}] vs [${b.enumValues?.join(', ')}].`;
    }
  }
  if (a.defaultValue !== b.defaultValue) {
    return `Default values differ: ${a.defaultValue ?? '(none)'} vs ${b.defaultValue ?? '(none)'}.`;
  }
  return null;
}

export const ACTION_CONTRACT_DIMENSIONS = [
  'requires',
  'ensures',
  'needs',
  'touches',
  'executionAuthority',
  'replay',
  'emissions',
] as const;

export type ActionContractDimension = (typeof ACTION_CONTRACT_DIMENSIONS)[number];

export interface CompactDeclaredPresence {
  readonly kind: 'declared' | 'none';
}

/** Compact MCP summary: dimension presence + digest, no prose. */
export interface CompactActionContract {
  readonly digest: string;
  readonly requires: CompactDeclaredPresence;
  readonly ensures: CompactDeclaredPresence;
  readonly needs: CompactDeclaredPresence;
  readonly touches: {
    readonly frame: 'single-machine';
    readonly resources: CompactDeclaredPresence;
  };
  readonly executionAuthority: { readonly kind: 'local' | 'host' };
  readonly replay: { readonly kind: 'safe-repeat' | 'claim-required' | 'reject-replay' };
  readonly emissions: CompactDeclaredPresence;
}

function readDeclaredActionContract(action: ToolAction): unknown {
  if (!('actionContract' in action)) return undefined;
  return Reflect.get(action, 'actionContract');
}

/** Compact a normalized contract. Omits prose; keeps every dimension and the digest. */
export function compactActionContract(contract: ActionContract): CompactActionContract {
  return {
    digest: digestText(actionContractCanonicalBytes(contract)),
    requires: { kind: contract.requires.kind },
    ensures: { kind: contract.ensures.kind },
    needs: { kind: contract.needs.kind },
    touches: {
      frame: contract.touches.frame,
      resources: { kind: contract.touches.resources.kind },
    },
    executionAuthority: { kind: contract.executionAuthority.kind },
    replay: { kind: contract.replay.kind },
    emissions: { kind: contract.emissions.kind },
  };
}

/**
 * Project a compact MCP summary from the same declared block the registry
 * normalizes. Missing live contracts stay missing — annotations are not a
 * source for inventing one.
 */
export function projectCompactActionContract(action: ToolAction): CompactActionContract | undefined {
  const declared = readDeclaredActionContract(action);
  if (declared === undefined) return undefined;
  return compactActionContract(
    normalizeActionContract(declared, { annotations: action.annotations }),
  );
}

export function formatCompactActionContracts(actions: readonly ToolAction[]): string {
  const lines = actions.map((action) => {
    const compact = projectCompactActionContract(action);
    if (compact === undefined) {
      return `- ${action.name}: absent`;
    }
    return (
      `- ${action.name}: digest=${compact.digest}` +
      ` requires=${compact.requires.kind}` +
      ` ensures=${compact.ensures.kind}` +
      ` needs=${compact.needs.kind}` +
      ` touches=${compact.touches.resources.kind}` +
      ` executionAuthority=${compact.executionAuthority.kind}` +
      ` replay=${compact.replay.kind}` +
      ` emissions=${compact.emissions.kind}`
    );
  });
  return `Action contracts:\n${lines.join('\n')}`;
}

export function appendCompactActionContracts(
  description: string,
  actions: readonly ToolAction[],
): string {
  return `${description}\n\n${formatCompactActionContracts(actions)}`;
}

/**
 * Builds a tool description that includes action signatures.
 * Appends action names and their parameters to the base description.
 */
export function buildToolDescription(tool: CompositeTool, slim = false): string {
  if (slim && tool.slimDescription) {
    return tool.slimDescription;
  }
  const actionSigs = tool.actions.map((action) => {
    const fields = Object.entries(action.schema.shape);
    const params = fields.map(([key, zodType]) => {
      const isOptional = (zodType as z.ZodType).isOptional();
      return isOptional ? `${key}?` : key;
    });
    return `- ${action.name}(${params.join(', ')}): ${action.description}`;
  });
  return `${tool.description}\n\nActions:\n${actionSigs.join('\n')}`;
}
