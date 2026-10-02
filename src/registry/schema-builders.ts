import { digestText } from '../contract/authority-digest.js';
import { z } from 'zod';
import {
  actionContractCanonicalBytes,
  normalizeActionContract,
  type ActionContract,
} from './action-contract.js';
import type { CompositeTool, ToolAction } from './types.js';

/** A ZodObject whose shape includes an `action` discriminator key. */
type ActionDiscriminatedSchema = z.ZodObject<{ action: z.ZodType } & z.ZodRawShape>;

/**
 * Builds a Zod discriminated union from a list of ToolActions. Each action schema gets an
 * `action: z.literal(name)` discriminator. TypeScript cannot infer that key through `.map()`, so
 * the code casts. The Zod v4 generic order of `ZodDiscriminatedUnion` is `<Options, Disc>`.
 */
export function buildCompositeSchema(
  actions: readonly ToolAction[],
): z.ZodDiscriminatedUnion<[ActionDiscriminatedSchema, ...ActionDiscriminatedSchema[]], 'action'> {
  if (actions.length < 2) {
    throw new Error('buildCompositeSchema requires at least 2 actions for a discriminated union');
  }

  const schemas = actions.map((action) =>
    action.schema.extend({ action: z.literal(action.name) }),
  ) as ActionDiscriminatedSchema[];

  const [first, ...rest] = schemas;
  if (first === undefined) {
    throw new Error('buildCompositeSchema requires at least 2 actions for a discriminated union');
  }
  return z.discriminatedUnion('action', [first, ...rest]);
}

/**
 * Returns true for a `z.preprocess(fn, inner)` schema. In Zod v4 that is a `ZodPipe` whose `def.in`
 * is a `ZodTransform` and whose `def.out` is `inner`. A `.transform()` pipe has the transform as
 * `def.out`, so it does not match.
 */
function isPreprocessPipe(schema: z.ZodType): schema is z.ZodPipe {
  if (!(schema instanceof z.ZodPipe)) return false;
  const def = schema._zod.def;
  return def.in._zod.def.type === 'transform';
}

/**
 * Unwraps a bare or optional `z.preprocess()` schema, so `zodToJsonSchema` emits the inner type and
 * not an opaque `allOf` wrapper. Validation still runs the coercion through the original action
 * schemas in `buildCompositeSchema`. Zod v4 types `innerType` as the core `$ZodType`, so the code
 * casts it to the classic `ZodType`.
 */
function unwrapPreprocess(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional) {
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
 * Builds a strict Zod object schema for MCP tool registration. The MCP SDK cannot generate JSON
 * Schema from a discriminated union. So this flattens the actions into one object with a required
 * `action` enum, and makes each other field optional. The action handlers validate required fields.
 *
 * `.strict()` turns an unknown parameter name into a validation error. Preprocess schemas are
 * unwrapped for clean JSON Schema. When two actions declare one field, the first declaration wins.
 * A different base type, enum value set, or default throws, because the merge hides the later
 * declaration. Other constraint drift is allowed, because the action schemas validate it again.
 */
export function buildRegistrationSchema(
  actions: readonly ToolAction[],
): z.ZodObject<z.ZodRawShape> {
  const actionNames = actions.map((a) => a.name) as [string, ...string[]];
  const shape: Record<string, z.ZodType> = {
    action: z.enum(actionNames),
  };
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
        continue;
      }

      shape[key] = field.isOptional() ? field : field.optional();
      provenance.set(key, { action: action.name, contract });
    }
  }

  return z.object(shape as z.ZodRawShape).strict();
}

/**
 * The contract view of a Zod field. It keeps only the properties whose divergence across actions
 * breaks MCP registration: the base kind, the enum value set, and the default. It ignores
 * refinements and optionality.
 */
interface FieldContract {
  readonly kind: 'enum' | 'string' | 'number' | 'boolean' | 'array' | 'object' | 'other';
  /** Present only when `kind` is `enum`. */
  readonly enumValues: readonly string[] | null;
  /** The default as JSON text, or null when there is no default. */
  readonly defaultValue: string | null;
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

/**
 * Returns the base kind of a field after it peels one default and one optional wrapper.
 * `z.number()` and `z.number().int()` are one kind, because the action schema validates the
 * refinement again.
 */
function baseKind(schema: z.ZodType): FieldContract['kind'] {
  let current: z.ZodType = schema;
  if (current instanceof z.ZodDefault) current = current._zod.def.innerType as z.ZodType;
  if (current instanceof z.ZodOptional) current = current._zod.def.innerType as z.ZodType;
  if (current instanceof z.ZodString) return 'string';
  if (current instanceof z.ZodNumber) return 'number';
  if (current instanceof z.ZodBoolean) return 'boolean';
  if (current instanceof z.ZodArray) return 'array';
  if (current instanceof z.ZodObject || current instanceof z.ZodRecord) return 'object';
  return 'other';
}

/**
 * Peels the optional and nullable wrappers. It keeps a default wrapper, because the default is part
 * of the contract.
 */
function unwrapOptional(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    current = current._zod.def.innerType as z.ZodType;
  }
  return current;
}

/**
 * Returns the sorted, JSON-encoded value set of an enum-like field, or null. For a `ZodEnum` it
 * reads the values of `def.entries`, which for a numeric TS enum also hold the reverse map. A
 * literal is a one-member enum, so two different literals collide. A union counts only when each
 * branch is a literal. A mixed union, such as `string | string[]`, falls back to `baseKind`.
 */
function extractEnumValues(schema: z.ZodType): readonly string[] | null {
  const current = peelEnumWrappers(schema);
  if (current instanceof z.ZodEnum) {
    const raw = Object.values(current._zod.def.entries as Record<string, unknown>);
    return [...new Set(raw.map((v) => JSON.stringify(v)))].sort();
  }
  if (current instanceof z.ZodLiteral) {
    const values = current._zod.def.values as readonly unknown[];
    return [...new Set(values.map((v) => JSON.stringify(v)))].sort();
  }
  if (current instanceof z.ZodUnion) {
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

/**
 * Peels the default, optional, and nullable wrappers. It does not peel `ZodPipe` or `ZodBranded`,
 * because both change the wire contract.
 */
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

/** Returns the default of a `ZodDefault`. In Zod v4, `def.defaultValue` holds the value itself. */
function extractDefault(schema: z.ZodType): unknown {
  if (schema instanceof z.ZodDefault) {
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

type ContractDimension =
  | 'requires'
  | 'ensures'
  | 'needs'
  | 'touches'
  | 'executionAuthority'
  | 'replay'
  | 'emissions';

export const ACTION_CONTRACT_DIMENSIONS: readonly ContractDimension[] = [
  'requires',
  'ensures',
  'needs',
  'touches',
  'executionAuthority',
  'replay',
  'emissions',
];

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

/** Compacts a normalized contract. It omits prose, and keeps each dimension and the digest. */
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
