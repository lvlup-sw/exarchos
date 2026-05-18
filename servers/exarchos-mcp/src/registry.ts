import { z } from 'zod';
import { CheckpointHandoffSchema, WorkflowTypeSchema } from './workflow/schemas.js';
import { agentSpecSchema as agentSpecSchemaForRegistry } from './agents/handler.js';
import { EnvelopeSchema } from './schemas/envelope.js';
export { coercedRecord, coercedPositiveInt, coercedNonnegativeInt, coercedStringArray } from './coerce.js';
import { coercedRecord, coercedPositiveInt, coercedNonnegativeInt, coercedStringArray } from './coerce.js';

// ─── Tool Registry Types ────────────────────────────────────────────────────

export interface CliActionHints {
  readonly alias?: string;
  readonly group?: string;
  readonly examples?: readonly string[];
  readonly flags?: Readonly<Record<string, {
    readonly alias?: string;
    readonly description?: string;
  }>>;
  readonly format?: 'table' | 'json' | 'tree';
}

export interface CliToolHints {
  readonly alias?: string;
  readonly group?: string;
}

/**
 * Action-descriptor-level dispatch metadata (#1440 Op 2, preview-4 T2,
 * design §4.3).
 *
 * Lives at the action-descriptor level (sibling to `cli`, `gate`,
 * `autoEmits`) — NOT under `cli.` — because the Tasks dispatch-core is
 * shared between the CLI and MCP facades (INV-2). Annotating under
 * `cli.` would imply this is CLI-presentation metadata; it isn't. It's
 * action-behavior metadata: "this action is long-running and benefits
 * from Tasks-augmented dispatch."
 *
 * The block is intentionally extensible — a future `streaming: true`
 * marker, for example, belongs here too. Hence the name `dispatch`
 * (not `tasks`, which would be too narrow).
 */
export interface DispatchHints {
  /**
   * Advisory marker: this action is long-running and benefits from
   * Tasks-augmented dispatch. Surfaced via `exarchos_view describe` so
   * clients can enumerate. The actual opt-in gate remains
   * `taskAugmented && ctx.taskStore && taskCapabilityGate` at
   * core/dispatch.ts:927-954. Clients are not required to honor this
   * marker; the gate is binding.
   */
  readonly taskSuitable?: boolean;
  /**
   * Suggested TTL for Tasks-augmented dispatch, in ms. Surfaced
   * alongside `taskSuitable` so clients have a sensible default to
   * thread when they opt in.
   */
  readonly taskTtlSuggestionMs?: number;
}

export interface GateMetadata {
  readonly blocking: boolean;
  readonly dimension?: string;
}

export interface AutoEmission {
  readonly event: string;
  readonly condition: 'always' | 'conditional';
  readonly description?: string;
}

// ─── Action Annotations (#1289, design §2.4) ─────────────────────────
//
// Per-action metadata co-located with the schema. `safety` is
// server-trusted (consumed by HSM guards + computeNextActions in a
// later task). The 4 *Hint flags are spec-defined client-untrusted UI
// hints populated to tools/list. Per MCP §Tools / Annotations,
// annotations are EXPLICITLY untrusted by clients unless the server is
// trusted — they are advisory only on the wire.
export type ActionAnnotations = {
  readonly safety: 'read-only' | 'local-mutation' | 'remote-mutation' | 'compensable';
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
};

// Mapping rules (mirror the §"Shared Annotation Presets" comment block
// below). `superRefine` rejects contradictory tuples — e.g. an action
// that claims `safety: 'read-only'` but flips `readOnly: false` would
// otherwise pass the shape-only check yet smuggle a writer past the
// capability boundary (CodeRabbit MAJOR on PR #1369; also the same
// mis-annotation class behind the doctor / check_convergence Sentry
// HIGH).
//
// `idempotent` is not asserted because the comment block explicitly
// notes that idempotency varies per handler within the local-mutation
// family. `openWorld` is asserted only where the safety enum implies
// it (remote-mutation must be openWorld:true; other classes leave it
// free because compensable splits local/remote).
export const ActionAnnotationsSchema = z.object({
  safety: z.enum(['read-only', 'local-mutation', 'remote-mutation', 'compensable']),
  readOnly: z.boolean(),
  destructive: z.boolean(),
  idempotent: z.boolean(),
  openWorld: z.boolean(),
}).strict().superRefine((a, ctx) => {
  switch (a.safety) {
    case 'read-only':
      if (!a.readOnly) {
        ctx.addIssue({
          code: 'custom',
          path: ['readOnly'],
          message: "safety 'read-only' requires readOnly: true",
        });
      }
      if (a.destructive) {
        ctx.addIssue({
          code: 'custom',
          path: ['destructive'],
          message: "safety 'read-only' requires destructive: false",
        });
      }
      break;
    case 'local-mutation':
      if (a.readOnly) {
        ctx.addIssue({
          code: 'custom',
          path: ['readOnly'],
          message: "safety 'local-mutation' requires readOnly: false",
        });
      }
      if (a.destructive) {
        ctx.addIssue({
          code: 'custom',
          path: ['destructive'],
          message: "safety 'local-mutation' requires destructive: false (use 'compensable' for destructive writes)",
        });
      }
      break;
    case 'remote-mutation':
      if (a.readOnly) {
        ctx.addIssue({
          code: 'custom',
          path: ['readOnly'],
          message: "safety 'remote-mutation' requires readOnly: false",
        });
      }
      if (a.destructive) {
        ctx.addIssue({
          code: 'custom',
          path: ['destructive'],
          message: "safety 'remote-mutation' requires destructive: false (use 'compensable' for destructive writes)",
        });
      }
      if (!a.openWorld) {
        ctx.addIssue({
          code: 'custom',
          path: ['openWorld'],
          message: "safety 'remote-mutation' requires openWorld: true",
        });
      }
      break;
    case 'compensable':
      if (a.readOnly) {
        ctx.addIssue({
          code: 'custom',
          path: ['readOnly'],
          message: "safety 'compensable' requires readOnly: false",
        });
      }
      if (!a.destructive) {
        ctx.addIssue({
          code: 'custom',
          path: ['destructive'],
          message: "safety 'compensable' requires destructive: true",
        });
      }
      break;
  }
});

export function validateAnnotations(a: unknown, actionName: string): asserts a is ActionAnnotations {
  const result = ActionAnnotationsSchema.safeParse(a);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Action '${actionName}' has invalid annotations: ${issues}`);
  }
}

/**
 * Registration-time invariant check (Wave 0 task C.3, design §2.1 + §2.4,
 * issues #1287 + #1289).
 *
 * Every action MUST declare both `outputSchema` (a Zod schema for the
 * response envelope) and `annotations` (a typed ActionAnnotations record).
 * Called from the module-load loop at the bottom of this file so any
 * malformed action fails the import — DIM-3 contracts fail closed at
 * startup rather than at first call. The thrown error always surfaces
 * the fully-qualified `${toolName}.${action.name}` identifier so the
 * operator can navigate from a failed import directly to the offender.
 */
export function validateAction(
  action: { name: string; outputSchema?: z.ZodType; annotations?: unknown },
  toolName: string,
): void {
  const id = `${toolName}.${action.name}`;
  if (action.outputSchema === undefined) {
    throw new Error(`Action '${id}' is missing required outputSchema`);
  }
  if (typeof (action.outputSchema as { parse?: unknown }).parse !== 'function') {
    throw new Error(`Action '${id}' outputSchema is not a Zod schema`);
  }
  // ActionAnnotationsSchema is re-validated here (not just a presence
  // check) so a hand-edited field set that drifts from the schema fails
  // at the same boundary as a missing declaration.
  validateAnnotations(action.annotations, id);
}

// ─── Shared Annotation Presets (Wave 0 E.1-E.5, design §2.4) ────────
//
// Each preset codifies the (safety, readOnly, destructive, idempotent,
// openWorld) tuple for one of the recurring action shapes in the
// registry. Co-locating them removes drift risk across 90+ declaration
// sites and makes per-action annotations a single keyword in the array
// literal — the *kind* of action is the only thing the author has to
// classify; the flag tuple follows from the preset.
//
// Mapping rules (DIM-3 safety boundary, applied uniformly):
// - read-only            → readOnly:true,  destructive:false, idempotent:true,  openWorld:false
// - read-only + external → readOnly:true,  destructive:false, idempotent:true,  openWorld:true
// - local-mutation       → readOnly:false, destructive:false, idempotent:false, openWorld:false
// - local-mutation idem. → readOnly:false, destructive:false, idempotent:true,  openWorld:false
// - compensable (local)  → readOnly:false, destructive:true,  idempotent:false, openWorld:false
// - compensable (remote) → readOnly:false, destructive:true,  idempotent:false, openWorld:true
// - remote-mutation      → readOnly:false, destructive:false, idempotent:false, openWorld:true
//
// `idempotent: true` is asserted only for actions whose handler is
// documented or empirically safe to re-run (reconcile, rehydrate,
// checkpoint, sync, plus all pure reads). Default for state-writers is
// false because re-running yields a new event in the stream.

const READ_ONLY_LOCAL: ActionAnnotations = {
  safety: 'read-only',
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
};

const READ_ONLY_REMOTE: ActionAnnotations = {
  safety: 'read-only',
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: true,
};

const LOCAL_MUTATION: ActionAnnotations = {
  safety: 'local-mutation',
  readOnly: false,
  destructive: false,
  idempotent: false,
  openWorld: false,
};

const LOCAL_MUTATION_IDEMPOTENT: ActionAnnotations = {
  safety: 'local-mutation',
  readOnly: false,
  destructive: false,
  idempotent: true,
  openWorld: false,
};

const COMPENSABLE_LOCAL: ActionAnnotations = {
  safety: 'compensable',
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: false,
};

const COMPENSABLE_REMOTE: ActionAnnotations = {
  safety: 'compensable',
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: true,
};

const REMOTE_MUTATION: ActionAnnotations = {
  safety: 'remote-mutation',
  readOnly: false,
  destructive: false,
  idempotent: false,
  openWorld: true,
};

// Wave 5 (#1437) — shared correlation-tuple filter shape spliced into every
// view action that supports dispatch-boundary scoping. Keeping it in one
// place prevents the six call sites from drifting if a field is added,
// renamed, or constrained.
const CORRELATION_TUPLE_FILTER_SHAPE = {
  operationId: z.string().optional(),
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
} as const;

export interface ToolAction {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly phases: ReadonlySet<string>;
  readonly roles: ReadonlySet<string>;
  readonly cli?: CliActionHints;
  readonly gate?: GateMetadata;
  readonly autoEmits?: readonly AutoEmission[];
  /**
   * Dispatch-layer metadata (#1440 Op 2, preview-4 T2, design §4.3).
   * Sibling-level (not under `cli`) because the Tasks dispatch-core is
   * shared between CLI and MCP facades (INV-2). Advisory only — the
   * binding opt-in gate stays at `core/dispatch.ts:927-954`. Surfaced
   * via `exarchos_view describe` so clients can enumerate
   * task-suitable actions.
   */
  readonly dispatch?: DispatchHints;
  /**
   * DR-5: When true, the action can take multiple seconds to complete and
   * the CLI adapter should emit stderr heartbeats under `--json` so a long
   * silence doesn't look like the process hung.  MCP hosts render progress
   * natively and ignore this flag.
   */
  readonly longRunning?: boolean;
  /**
   * DR-4 / DR-11 (durable-substrate, #1259) — when true, this action is
   * scheduled for removal one release ahead and currently routes through a
   * deprecation rerouting surface. Surfaces in `describe` entries so model-
   * facing agents can self-correct toward the canonical action without
   * human prompting.
   */
  readonly deprecated?: boolean;
  /**
   * Typed Zod schema describing the action's response envelope (Wave 0
   * task E.1-E.5, DR-11, design §2.1). All actions in the built-in
   * registry MUST declare an `outputSchema` — most attach
   * `EnvelopeSchema(z.unknown())` (the LCD envelope shape with
   * `data: unknown`) while a small set of HSM actions (workflow.set/
   * transition/update) attach typed sub-shapes that register the
   * `_meta.deprecation` slot. Per-action data-shape tightening is
   * incremental follow-up work (design §10, out of scope for Wave 0).
   *
   * The field is required at the interface boundary; the registration-
   * time validator (`validateAction`) also enforces presence at module
   * load so a malformed declaration fails the import (DIM-3 fail-closed).
   */
  readonly outputSchema: z.ZodType;
  /**
   * Per-action annotations (Wave 0 task E.1-E.5, design §2.4, #1289).
   * `safety` is server-trusted and is consumed by HSM guards +
   * computeNextActions in a later task. The four Hint flags
   * (readOnly/destructive/idempotent/openWorld) are spec-defined
   * advisory hints surfaced to MCP clients via `tools/list`; per the
   * MCP spec they are EXPLICITLY untrusted unless the server itself
   * is trusted.
   */
  readonly annotations: ActionAnnotations;
}

export interface CompositeTool {
  readonly name: string;
  readonly description: string;
  readonly actions: readonly ToolAction[];
  readonly cli?: CliToolHints;
  /** When true, the tool is excluded from MCP registration (not exposed to agents). CLI access is preserved. */
  readonly hidden?: boolean;
  /** One-line summary for slim MCP registration. Used when slimRegistration is enabled. */
  readonly slimDescription?: string;
}

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
 *  match on the underlying enum-ish kind. Kept narrow on purpose: we don't
 *  peel ZodPipe (formerly ZodEffects) or ZodBranded because those change
 *  the wire-level contract and deserve to be classified distinctly. */
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

// ─── Shared Constants ───────────────────────────────────────────────────────

export const ALL_PHASES: ReadonlySet<string> = new Set([
  // Feature workflow
  'ideate',
  'plan',
  'plan-review',
  'delegate',
  // Substate of `delegate` — entered when a worktree-task's autonomous merge
  // is pending. Must be in this set so phase-gated actions (notably
  // `merge_orchestrate` itself) remain dispatchable while the workflow sits
  // in this phase.
  'merge-pending',
  'review',
  'synthesize',
  // Debug workflow
  'triage',
  'investigate',
  'rca',
  'design',
  'debug-implement',
  'debug-validate',
  'debug-review',
  'hotfix-implement',
  'hotfix-validate',
  // Refactor workflow
  'explore',
  'brief',
  'polish-implement',
  'polish-validate',
  'polish-update-docs',
  'overhaul-plan',
  'overhaul-delegate',
  'overhaul-review',
  'overhaul-update-docs',
  // Oneshot workflow (compressed lifecycle: plan → implementing →
  // synthesize|completed). `plan` is already present above from the
  // feature workflow; `implementing` is oneshot-exclusive and MUST be in
  // this set so generic actions gated by ALL_PHASES (get / set / cancel /
  // event append / etc.) remain callable while a oneshot is mid-flight.
  'implementing',
  // Shared
  'blocked',
]);

const ROLE_ANY: ReadonlySet<string> = new Set(['any']);
const ROLE_LEAD: ReadonlySet<string> = new Set(['lead']);
const ROLE_TEAMMATE: ReadonlySet<string> = new Set(['teammate']);

const DELEGATE_PHASES: ReadonlySet<string> = new Set([
  'delegate',
  'overhaul-delegate',
  'debug-implement',
]);
const STACK_PHASES: ReadonlySet<string> = new Set([
  'synthesize',
  'delegate',
  'overhaul-delegate',
  'debug-implement',
]);
const REVIEW_PHASES: ReadonlySet<string> = new Set([
  'review',
  'overhaul-review',
  'debug-review',
]);
const SYNTHESIS_REVIEW_PHASES: ReadonlySet<string> = new Set([
  'synthesize',
  'review',
  'overhaul-review',
  'debug-review',
]);
const PLAN_PHASES: ReadonlySet<string> = new Set([
  'plan',
  'plan-review',
  'overhaul-plan',
]);

// ─── Shared Schema Fragments ────────────────────────────────────────────────

const featureIdSchema = z.string().min(1).regex(/^[a-z0-9-]+$/);

// ─── Describe Action ────────────────────────────────────────────────────────

const describeSchema = z.object({
  actions: z.array(z.string()).min(1).max(10)
    .describe('Action names to describe. Returns full schema + description for each.'),
});

/** Creates a shared describe action definition for composite tools. */
function makeDescribeAction(): ToolAction {
  return {
    name: 'describe',
    description: 'Return full schemas, descriptions, gate metadata, and phase/role info for specific actions',
    schema: describeSchema,
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  };
}

/** Workflow-specific describe schema: supports actions, topology, playbooks, and config. */
const workflowDescribeSchema = z.object({
  actions: z.array(z.string()).min(1).max(10)
    .describe('Action names to describe. Returns full schema + description for each.')
    .optional(),
  topology: z.string()
    .describe('Workflow type to return HSM topology for. Use "all" to list all types.')
    .optional(),
  playbook: z.string()
    .describe('Workflow type for phase playbooks. "all" lists types.')
    .optional(),
  config: z.boolean()
    .describe('When true, returns annotated project config showing values and sources (default vs .exarchos.yml).')
    .optional(),
});

/** Creates a workflow-specific describe action with topology, playbook, and config support. */
function makeWorkflowDescribeAction(): ToolAction {
  return {
    name: 'describe',
    description: 'Return full schemas, descriptions, gate metadata, and phase/role info for specific actions. Optionally return HSM topology, phase playbooks, or annotated project config.',
    schema: workflowDescribeSchema,
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  };
}

const eventDescribeSchema = z.object({
  actions: z.array(z.string()).min(1).max(10)
    .describe('Action names to describe. Returns full schema + description for each.')
    .optional(),
  eventTypes: z.array(z.string()).min(1).max(20)
    .describe('Event type names to describe. Returns data schema, emission source, and built-in status for each.')
    .optional(),
  emissionGuide: z.boolean().optional()
    .describe('When true, returns the full event emission catalog grouped by source'),
});

/** Creates a describe action for the event tool that supports both actions, eventTypes, and emissionGuide. */
function makeEventDescribeAction(): ToolAction {
  return {
    name: 'describe',
    description: 'Return schemas for actions and/or event types, or the emission guide. At least one of actions, eventTypes, or emissionGuide must be provided.',
    schema: eventDescribeSchema,
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  };
}

// ─── Output Schemas — `_meta.deprecation` Registration (DR-11, #1259) ──────
//
// The HSM single-path consolidation introduces a deprecation envelope on
// the affected actions. `_meta.deprecation` describes the migration window
// (since/removeIn) and the canonical replacement so agents can self-correct
// without human prompting. The schemas below describe the typed sub-shape
// registered in each action's `outputSchema`.
//
// v2.10 registered the same typed sub-shape on both
// `exarchos_workflow.set` and `exarchos_workflow.transition`. v2.11 (DR-4)
// removes the `set` action entry from the registry, but keeps the
// `_meta.deprecation` slot on `transition`'s `outputSchema` for one more
// release as a historical marker (INV-5b). v2.12 drops the slot.
// `WorkflowSetOutputSchema` is retained as a private export for one
// release to preserve symmetry of the schema definitions; nothing in the
// registry references it any longer.
//
// The envelope version is implicitly bumped via this schema registration:
// `_meta.envelopeVersion` callers can rely on the structured deprecation
// payload appearing instead of (or alongside) any free-text warning that
// may have surfaced via `result.warnings` historically.

/**
 * `_meta.deprecation` typed sub-shape (DR-4, DR-11). Surfaces on the response
 * envelope of any action whose handler routes through a deprecation rerouting
 * surface (currently: `exarchos_workflow.set` when `phase` is provided).
 *
 * `since` / `removeIn` use semver strings (validated as non-empty);
 * `replacement` names the canonical action a caller should migrate to.
 */
export const MetaDeprecationSchema = z.object({
  since: z.string().min(1).describe('Version when this action was deprecated (semver)'),
  removeIn: z.string().min(1).describe('Version when this action is removed (semver)'),
  replacement: z.string().min(1).describe('Canonical action name that supersedes this one'),
});

// Wave 0 / Task G.2 (#1340): consolidate the three v2.10.0-preview.2
// standalone envelope constants onto the canonical `EnvelopeSchema(data)`
// factory from `schemas/envelope.ts`. Each surface remains as a named
// export so any downstream consumer that typed-imported the constants
// directly continues to compile through one release window; canonical
// replacement is `EnvelopeSchema` itself (callers should migrate to it
// before the v2.12 removal).
//
// Per design §2.1 (single envelope factory) and DIM-1 (dispatch core is
// single-source for action contracts) — the previous bespoke
// `z.object({...}).passthrough()` shapes drifted from the canonical
// envelope contract (no typed `_perf`, `success` not literal-discriminated,
// no typed `error` block). The factory anchors all three on the same
// discriminated-union envelope and applies an additional intersection
// constraint where DR-4/DR-11 requires the typed `_meta.deprecation`
// sub-shape.

/**
 * Shape constraint for `_meta.deprecation` (DR-4, DR-11). When `_meta`
 * carries a `deprecation` slot, each sub-field must validate against
 * {@link MetaDeprecationSchema}. The slot itself is always optional —
 * the canonical action does not emit it; the rerouted/deprecated
 * surface does.
 *
 * `passthrough()` on `_meta` so the rest of the typed envelope's
 * `z.record(z.string(), z.unknown())` _meta merge survives the
 * intersection.
 */
const MetaDeprecationConstraint = z.object({
  _meta: z.object({
    deprecation: MetaDeprecationSchema.optional(),
  }).passthrough().optional(),
}).passthrough();

/**
 * `outputSchema` for the (now-removed) `exarchos_workflow.set` action.
 *
 * @deprecated v2.10 LCD; will be removed in v2.12. Use
 * `EnvelopeSchema(dataSchema)` from `./schemas/envelope.js` directly.
 *
 * Retained for one release as a named re-export so downstream typed
 * imports compile. Nothing in the registry references this constant
 * any longer (the `set` action entry was removed in v2.11/DR-4).
 */
export const WorkflowSetOutputSchema = EnvelopeSchema(z.unknown()).and(
  MetaDeprecationConstraint,
);

/**
 * `outputSchema` for `exarchos_workflow.transition` (DR-11).
 *
 * @deprecated v2.10 LCD; will be removed in v2.12. Use
 * `EnvelopeSchema(dataSchema)` from `./schemas/envelope.js` directly
 * (parameterized on the action's success-data shape).
 *
 * Thin wrapper over the canonical envelope factory plus the DR-4/DR-11
 * typed `_meta.deprecation` constraint. The canonical action does not
 * emit `_meta.deprecation` itself, but registering the typed sub-shape
 * keeps the surfaces interchangeable from a contract-introspection
 * standpoint (INV-5b).
 */
export const WorkflowTransitionOutputSchema = EnvelopeSchema(z.unknown()).and(
  MetaDeprecationConstraint,
);

/**
 * `outputSchema` for `exarchos_workflow.update` (Wave 0, #1340 prep for
 * #1266).
 *
 * @deprecated v2.10 LCD; will be removed in v2.12. Use
 * `EnvelopeSchema(dataSchema)` from `./schemas/envelope.js` directly.
 *
 * Mirrors {@link WorkflowTransitionOutputSchema} EXCEPT the
 * `_meta.deprecation` constraint: `update` is a canonical surface
 * restored in v2.10.0-preview.2 and is not on a deprecation track, so
 * the envelope does not advertise the migration sub-shape.
 */
export const WorkflowUpdateOutputSchema = EnvelopeSchema(z.unknown());

/**
 * `outputSchema` for `exarchos_view.telemetry` (PR3/T10, #1364 — Wave 3
 * polish on top of Wave 0 carrier swap).
 *
 * Typed envelope so MCP advertises the per-tool `actionErrors` and
 * `actionErrorBreakdown` fields the `tool.action_errored` projection now
 * folds. Both fields are required on every tool entry so downstream
 * consumers (CLI rendering, dashboards, drift detection) can rely on
 * their presence rather than treating them as optional decorators.
 *
 * The per-tool entry is intentionally `.passthrough()` because the
 * compact-vs-full split adds extra arrays (`durations`, `sizes`,
 * `tokenEstimates`) on the non-compact path — strict objects would
 * reject the full shape. `hints[]` items are also passthrough to leave
 * room for future hint flavours without re-cutting the schema.
 *
 * See [`docs/designs/2026-05-15-wave2-wave3-polish.md`](../docs/designs/2026-05-15-wave2-wave3-polish.md)
 * `#1364 — split transport vs action-level errors` for context.
 */
const TelemetryToolEntrySchema = z.object({
  tool: z.string(),
  invocations: z.number().nonnegative(),
  errors: z.number().nonnegative(),
  totalDurationMs: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  p50DurationMs: z.number().nonnegative(),
  p95DurationMs: z.number().nonnegative(),
  p50Bytes: z.number().nonnegative(),
  p95Bytes: z.number().nonnegative(),
  p50Tokens: z.number().nonnegative(),
  p95Tokens: z.number().nonnegative(),
  // PR3/T10 (#1364) — structured action-level failure counters.
  actionErrors: z.number().nonnegative(),
  actionErrorBreakdown: z.record(z.string(), z.number().nonnegative()),
}).passthrough();

const TelemetryViewDataSchema = z.object({
  session: z.object({
    start: z.string(),
    totalInvocations: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
  }),
  tools: z.array(TelemetryToolEntrySchema),
  hints: z.array(z.unknown()),
}).passthrough();

export const TelemetryViewOutputSchema = EnvelopeSchema(TelemetryViewDataSchema);

// ─── Composite Tool: exarchos_workflow ───────────────────────────────────────

const workflowActions: readonly ToolAction[] = [
  {
    name: 'init',
    description: 'Initialize a new workflow. Auto-emits workflow.started event. For workflowType=oneshot, an optional synthesisPolicy (always | never | on-request) seeds state.oneshot.synthesisPolicy; silently ignored for other workflow types.',
    schema: z.object({
      featureId: featureIdSchema,
      workflowType: WorkflowTypeSchema,
      synthesisPolicy: z.enum(['always', 'never', 'on-request']).optional(),
    }),
    phases: new Set<string>(),
    roles: ROLE_LEAD,
    cli: {
      flags: { featureId: { alias: 'f' }, workflowType: { alias: 't' } },
      examples: [
        'exarchos wf init -f my-feature -t feature',
        'exarchos wf init -f my-oneshot -t oneshot --synthesisPolicy always',
      ],
    },
    autoEmits: [
      { event: 'workflow.started', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'get',
    description: 'Read workflow state with optional query or field projection',
    schema: z.object({
      featureId: featureIdSchema,
      query: z.string().optional(),
      fields: coercedStringArray().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    cli: {
      alias: 'status',
      flags: { featureId: { alias: 'f' }, query: { alias: 'q' } },
      examples: ['exarchos wf status -f my-feature', 'exarchos wf status -f my-feature -q phase'],
    },
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'transition',
    description: 'Transition the workflow to a target phase. Canonical phase-mutation action. Routes through the HSM transition guard primitive — emits exactly one workflow.transition event on success, or returns a structured error envelope (validTargets, expectedShape, suggestedFix) on guard/topology failure.',
    schema: z.object({
      featureId: featureIdSchema,
      target: z.string().min(1).describe('Target phase (must be a declared transition from the current phase)'),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    cli: {
      flags: { featureId: { alias: 'f' }, target: { alias: 't' } },
      examples: ['exarchos wf transition -f my-feature -t plan'],
    },
    autoEmits: [
      { event: 'workflow.transition', condition: 'always' },
    ],
    outputSchema: WorkflowTransitionOutputSchema,
    annotations: LOCAL_MUTATION,
  },
  {
    // Wave 0 (#1340, v2.10.0-preview.2): canonical state-mutation surface.
    // Replaces the deprecated v2.10 `set({updates})` rerouting path that
    // was removed alongside `set({phase})` in v2.11. Phase mutation lives
    // on `transition`; non-phase fields (artifacts, planReview, task
    // results, etc.) flow through this action so callers see a single
    // validated, output-enveloped surface instead of being told to emit
    // `state.patched` directly via `event.append` (which bypasses input
    // validation, output enveloping, idempotency, and `next_actions`).
    //
    // Handler delegates to the existing internal `workflow.update()`
    // helper (`handleSet` with `updates` only, no `phase`). The phase
    // field is rejected at the input boundary with a structured
    // `INVALID_INPUT` + `suggestedFix` pointing callers at `transition`
    // (Task 0.2). `updates` is `Record<string, unknown>` so dot-paths
    // (`'artifacts.design'`) and nested objects both resolve through
    // `applyDotPath` in `handleSet`.
    name: 'update',
    description: 'Mutate non-phase workflow state fields (artifacts, planReview, task results, etc.). Canonical state-mutation surface. Emits exactly one state.patched event on success. For phase changes use action: transition.',
    schema: z.object({
      featureId: featureIdSchema,
      updates: z.record(z.string(), z.unknown()),
    }),
    // Wave 0 judgment call: the plan literally specified `new Set<string>()`
    // (no phases) but the registry has an existing invariant — enforced by
    // `registry.test.ts:should have non-empty phases for every action except
    // init` — that every non-init action declares at least one phase. Using
    // `ALL_PHASES` honors both the plan's intent (phase-agnostic mutation
    // surface, parallel to `transition`) and the existing invariant. The
    // semantically equivalent alternative would be to widen the test's
    // exception list, but adding `update` to the empty-phase exception
    // bucket would couple a foundational action to an `init`-only escape
    // hatch — fragile against future audits.
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    cli: {
      flags: { featureId: { alias: 'f' } },
      examples: ['exarchos wf update -f my-feature --updates \'{"artifacts":{"design":"docs/designs/foo.md"}}\''],
    },
    autoEmits: [
      { event: 'state.patched', condition: 'always' },
    ],
    // Wave 0 (#1340) — register WorkflowUpdateOutputSchema for envelope-
    // version discipline (#1266 prep). The schema mirrors the transition
    // surface's contract minus the `_meta.deprecation` slot (`update` is
    // not on a deprecation track) so a future contract-introspection
    // consumer can decode both surfaces with the same envelope shape.
    // `describe/handler.ts` exposes the schema via `outputSchema` in
    // action descriptions; callers reach it through
    // `exarchos_workflow.describe({actions: ['update']})`.
    outputSchema: WorkflowUpdateOutputSchema,
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'cancel',
    description: 'Cancel a workflow with saga compensation. Auto-emits workflow.cancel and compensation events',
    schema: z.object({
      featureId: featureIdSchema,
      dryRun: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'workflow.cancel', condition: 'always' },
      { event: 'workflow.compensation', condition: 'conditional', description: 'Per compensation action' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: COMPENSABLE_LOCAL,
  },
  {
    name: 'cleanup',
    description: 'Resolve a merged workflow to completed. Verifies merge, backfills synthesis metadata, force-resolves reviews, transitions to completed. Auto-emits workflow.cleanup event',
    schema: z.object({
      featureId: featureIdSchema,
      mergeVerified: z.boolean(),
      prUrl: z.union([z.string(), z.array(z.string())]).optional(),
      mergedBranches: z.array(z.string()).optional(),
      dryRun: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'workflow.cleanup', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: COMPENSABLE_LOCAL,
  },
  {
    name: 'reconcile',
    description: 'Rebuild workflow state from event store. Applies events newer than state _eventSequence. Idempotent — no new events returns {reconciled: false, eventsApplied: 0}. Use after compaction or crash recovery',
    schema: z.object({
      featureId: featureIdSchema,
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION_IDEMPOTENT,
  },
  {
    name: 'rehydrate',
    description: 'Rehydrate the canonical workflow document for a feature via the rehydration@v1 projection. Loads the latest snapshot and folds events written since, returning the full RehydrationDocument. Emits workflow.rehydrated on successful hydration (T032, DR-4) — the event records the deliveryPath used so downstream observers can correlate cache hints. Optional deliveryPath ∈ {direct, ndjson, snapshot}; defaults to "direct".',
    schema: z.object({
      featureId: featureIdSchema,
      // Closed enum mirrors `WorkflowRehydratedData.deliveryPath` so an
      // invalid value can't reach the workflow.rehydrated event payload.
      // Without this, registry validation accepted any string and let the
      // bad value bubble all the way to event-store append, where Zod
      // would reject it AFTER the read had already produced a document —
      // surfacing as a confusing "rehydrate succeeded but emit failed"
      // call. (CodeRabbit on PR #1178.)
      deliveryPath: z.enum(['direct', 'ndjson', 'snapshot']).optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      {
        event: 'workflow.rehydrated',
        condition: 'conditional',
        description: 'When rehydration succeeds (event-store emission failures are logged but do not fail the call — see rehydrate.ts).',
      },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION_IDEMPOTENT,
  },
  {
    name: 'checkpoint',
    description: 'Create an explicit checkpoint, resetting the operation counter. Persists checkpoint metadata to workflow state and emits workflow.checkpoint event',
    schema: z.object({
      featureId: featureIdSchema,
      summary: z.string().optional(),
      // T5 (#1240): formal `handoff` field on the dispatch surface so the
      // MCP arm validates the same shape `handleCheckpoint` re-validates
      // internally via `CheckpointInputSchema`. Without this, dispatch
      // silently strips `handoff` (registry per-action schemas are
      // non-strict) and an MCP caller passing `handoff` would observe a
      // successful checkpoint with no persisted handoff payload — the
      // CLI would honour the convenience flags while MCP would not,
      // breaking DR-3 surface parity.
      //
      // CodeRabbit nitpick on PR #1297: reuse the canonical
      // `CheckpointHandoffSchema` rather than redefining the shape inline.
      // The handler re-parses against `CheckpointInputSchema` so the
      // strictObject cap is ultimately enforced on a single line of code;
      // composing the canonical schema here keeps schema introspection
      // (`exarchos schema describe wf.checkpoint`) and the auto-gen CLI
      // flag table aligned with the handler's contract.
      handoff: CheckpointHandoffSchema.optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'workflow.checkpoint', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION_IDEMPOTENT,
  },
  makeWorkflowDescribeAction(),
];

// ─── Composite Tool: exarchos_event ─────────────────────────────────────────

const eventActions: readonly ToolAction[] = [
  {
    name: 'append',
    description: 'Append an event to a stream',
    schema: z.object({
      stream: z.string().min(1),
      event: coercedRecord(),
      expectedSequence: coercedNonnegativeInt().optional(),
      idempotencyKey: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    cli: {
      examples: ['exarchos ev append --stream my-feature --event \'{"type":"task.completed","data":{"taskId":"t1"}}\''],
    },
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'query',
    description: 'Query events from a stream with optional filtering',
    schema: z.object({
      stream: z.string().min(1),
      filter: coercedRecord().optional(),
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      fields: coercedStringArray().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'batch_append',
    description: 'Append multiple events to a stream atomically',
    schema: z.object({
      stream: z.string().min(1),
      events: z.array(coercedRecord()),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  makeEventDescribeAction(),
];

// ─── Composite Tool: exarchos_orchestrate ───────────────────────────────────

const orchestrateActions: readonly ToolAction[] = [
  {
    name: 'task_claim',
    description: 'Claim a task for execution',
    schema: z.object({
      taskId: z.string().min(1),
      agentId: z.string().min(1),
      streamId: z.string().min(1),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_TEAMMATE,
    autoEmits: [
      { event: 'task.claimed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'task_complete',
    description: 'Mark a task as complete with optional result and evidence. Auto-emits task.completed event. When evidence is provided, verified=true in event data; otherwise verified=false',
    schema: z.object({
      taskId: z.string().min(1),
      result: coercedRecord().optional(),
      evidence: z.object({
        type: z.enum(['test', 'build', 'typecheck', 'manual']),
        output: z.string(),
        passed: z.boolean(),
      }).optional(),
      streamId: z.string().min(1),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_TEAMMATE,
    autoEmits: [
      { event: 'task.completed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'task_fail',
    description: 'Mark a task as failed with error details. Auto-emits task.failed event',
    schema: z.object({
      taskId: z.string().min(1),
      error: z.string().min(1),
      diagnostics: coercedRecord().optional(),
      streamId: z.string().min(1),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_TEAMMATE,
    autoEmits: [
      { event: 'task.failed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'review_triage',
    description: 'Score PRs by risk and dispatch to CodeRabbit or self-hosted review based on velocity',
    schema: z.object({
      featureId: z.string().min(1),
      prs: z.array(z.object({
        number: z.number().int().positive(),
        paths: z.array(z.string()),
        linesChanged: z.number().int().nonnegative(),
        filesChanged: z.number().int().nonnegative(),
        newFiles: z.number().int().nonnegative(),
      })),
      activeWorkflows: z.array(z.object({ phase: z.string() })).optional(),
      pendingCodeRabbitReviews: z.number().int().nonnegative().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'prepare_delegation',
    description: 'Query delegation readiness and prepare quality hints for subagent dispatch',
    schema: z.object({
      featureId: z.string().min(1),
      tasks: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
      nativeIsolation: z.boolean().default(false).describe('When true, skip worktree-related blockers (the host platform handles isolation natively)'),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'quality.hint.generated', condition: 'conditional', description: 'When hints exist' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'prepare_synthesis',
    description: 'Run pre-synthesis checks: tests, typecheck, stack health. Emits events for readiness views and eval flywheel.',
    schema: z.object({
      featureId: z.string().min(1),
    }),
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    // DR-5: invokes `npm run test:run` + typecheck under the hood; seconds
    // to minutes on non-trivial repos.  CLI adapter emits heartbeats.
    longRunning: true,
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'assess_stack',
    description: 'Assess PR stack health during synthesize: CI status, reviews, comments. Emits events for the shepherd iteration loop (within synthesize phase) and eval flywheel.',
    schema: z.object({
      featureId: z.string().min(1),
      prNumbers: z.array(z.number().int().positive()),
    }),
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    // DR-5: shells out to `gh` across each PR in the stack; latency scales
    // with stack depth + GitHub API round-trip time.
    longRunning: true,
    autoEmits: [
      { event: 'shepherd.started', condition: 'conditional', description: 'First invocation (idempotent)' },
      { event: 'shepherd.approval_requested', condition: 'conditional', description: 'When approval needed' },
      { event: 'shepherd.completed', condition: 'conditional', description: 'When PR merged' },
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    // sentry LOW on PR #1369: `assess_stack` reads GitHub PR state but
    // also emits 3 shepherd lifecycle events + gate.executed on every
    // call. `readOnly: true` would mislead clients that gate on the
    // hint. REMOTE_MUTATION matches the actual write surface; the
    // conditional emission discipline is a handler-level detail and
    // should not be smuggled into the advisory annotation.
    annotations: REMOTE_MUTATION,
  },
  {
    name: 'check_static_analysis',
    description: 'Run static analysis gate (lint + typecheck). Emits gate.executed event with dimension D2.',
    schema: z.object({
      featureId: z.string().min(1),
      repoRoot: z.string().optional(),
      skipLint: z.boolean().optional(),
      skipTypecheck: z.boolean().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D2' },
    // DR-5: shells out to `npm run lint` and `npm run typecheck`; on
    // non-trivial repos both exceed the 2s heartbeat threshold.
    longRunning: true,
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_security_scan',
    description: 'Run security pattern scan on diff. Emits gate.executed event with dimension D1.',
    schema: z.object({
      featureId: z.string().min(1),
      diffContent: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D1' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_context_economy',
    description: 'Check code complexity impacting LLM context consumption. Emits gate.executed event with dimension D3.',
    schema: z.object({
      featureId: z.string().min(1),
      repoRoot: z.string().optional(),
      baseBranch: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D3' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_operational_resilience',
    description: 'Check for operational anti-patterns (empty catches, swallowed errors, console.log). Emits gate.executed event with dimension D4.',
    schema: z.object({
      featureId: z.string().min(1),
      repoRoot: z.string().optional(),
      baseBranch: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D4' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_workflow_determinism',
    description: 'Check test reliability and determinism (.only/.skip, non-deterministic time/random, debug artifacts). Emits gate.executed event with dimension D5.',
    schema: z.object({
      featureId: z.string().min(1),
      repoRoot: z.string().optional(),
      baseBranch: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D5' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_review_verdict',
    description: 'Compute review verdict from finding counts. Emits per-dimension and summary gate.executed events.',
    schema: z.object({
      featureId: z.string().min(1),
      high: coercedNonnegativeInt(),
      medium: coercedNonnegativeInt(),
      low: coercedNonnegativeInt(),
      blockedReason: z.string().optional(),
      dimensionResults: z.record(z.string(), z.object({
        passed: z.boolean(),
        findingCount: z.number().int().nonnegative(),
      })).optional(),
      pluginFindings: z.array(z.object({
        source: z.string(),
        severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
        dimension: z.string().optional(),
        file: z.string().optional(),
        line: z.number().int().positive().optional(),
        message: z.string(),
      })).optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_convergence',
    description: 'Query D1-D5 convergence status from gate.executed events. Emits gate.executed event on each invocation. Returns overall pass/fail and per-dimension summary.',
    schema: z.object({
      featureId: z.string().min(1),
      workflowId: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    // sentry HIGH on PR #1369: although `check_convergence` reads
    // existing gate state, the handler `emitGateEvent`s on every call,
    // so the action is not readOnly — annotating it as such would let
    // readonly-capability clients mutate the event store. LOCAL_MUTATION
    // matches the actual write surface (matches the rest of the check_*
    // family that emits gate.executed).
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_provenance_chain',
    description: 'Verify design requirement traceability (DR-N) from design doc to plan tasks. Emits gate.executed event with dimension D1.',
    schema: z.object({
      featureId: z.string().min(1),
      designPath: z.string().min(1),
      planPath: z.string().min(1),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_design_completeness',
    description: 'Verify design document completeness at ideate→plan boundary. Advisory gate — failures inform but do not block.',
    schema: z.object({
      featureId: z.string().min(1),
      stateFile: z.string().optional(),
      designPath: z.string().optional(),
    }),
    phases: new Set<string>(['ideate', 'plan']),
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D1' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_plan_coverage',
    description: 'Verify plan tasks cover all design sections. Emits gate.executed event with dimension D1.',
    schema: z.object({
      featureId: z.string().min(1),
      designPath: z.string().min(1),
      planPath: z.string().min(1),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_tdd_compliance',
    description: 'Per-task TDD compliance gate. Emits gate.executed event with dimension D1.',
    schema: z.object({
      featureId: z.string().min(1),
      taskId: z.string().min(1),
      branch: z.string().min(1),
      baseBranch: z.string().optional(),
    }).strict(),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_post_merge',
    description: 'Post-merge regression check. Emits gate.executed event with dimension D4.',
    schema: z.object({
      featureId: z.string().min(1),
      prUrl: z.string().min(1),
      mergeSha: z.string().min(1),
    }),
    phases: new Set<string>(['synthesize']),
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D4' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  // ─── Merge Orchestrator (DR-MO-1) ─────────────────────────────────────────
  {
    name: 'merge_orchestrate',
    description: 'Top-level merge orchestrator: runs preflight, emits merge.preflight, then delegates to the executor on pass. Handles abort/dryRun/resume per DR-MO-1.',
    schema: z.object({
      featureId: z.string().min(1),
      sourceBranch: z.string().min(1),
      targetBranch: z.string().min(1),
      taskId: z.string().optional(),
      // Required-no-default — matches `merge_pr.strategy` per #1127, gives
      // CLI/MCP user-visible parity (#1109 §2), and keeps operator intent
      // explicit in the event log (DIM-2 / DIM-3).
      strategy: z.enum(['squash', 'rebase', 'merge']),
      dryRun: z.boolean().optional(),
      resume: z.boolean().optional(),
      repoRoot: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'merge.preflight', condition: 'always' },
      { event: 'merge.executed', condition: 'conditional', description: 'When preflight passes and execute succeeds' },
      { event: 'merge.rollback', condition: 'conditional', description: 'When execute fails after a merge SHA was produced' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: COMPENSABLE_REMOTE,
  },
  {
    name: 'check_task_decomposition',
    description: 'Task decomposition quality check at plan boundary. Emits gate.executed event with dimension D5.',
    schema: z.object({
      featureId: z.string().min(1),
      planPath: z.string().min(1),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D5' },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_event_emissions',
    description: 'Check for expected-but-missing model-emitted events in the current workflow phase. Returns structured hints for missing events.',
    schema: z.object({
      featureId: z.string().min(1),
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'extract_task',
    description: 'Extract a task definition from a plan file by task ID',
    schema: z.object({
      planPath: z.string().min(1),
      taskId: z.string().min(1),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'review_diff',
    description: 'Collect diff statistics for a worktree branch against its base',
    schema: z.object({
      worktreePath: z.string().optional(),
      baseBranch: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'verify_worktree',
    description: 'Verify a directory is a valid git worktree',
    schema: z.object({
      cwd: z.string().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'select_debug_track',
    description: 'Select hotfix or thorough debug track based on urgency and root cause knowledge',
    schema: z.object({
      urgency: z.string().optional(),
      rootCauseKnown: z.union([z.boolean(), z.string()]).optional(),
      stateFile: z.string().optional(),
    }),
    phases: new Set<string>(['investigate']),
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'investigation_timer',
    description: 'Check investigation time budget and recommend continue or escalate',
    schema: z.object({
      startedAt: z.string().optional(),
      stateFile: z.string().optional(),
      budgetMinutes: z.number().optional(),
    }),
    phases: new Set<string>(['investigate']),
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'check_coverage_thresholds',
    description: 'Check code coverage metrics against threshold values',
    schema: z.object({
      coverageFile: z.string().min(1),
      lineThreshold: z.number().optional(),
      branchThreshold: z.number().optional(),
      functionThreshold: z.number().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D3' },
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'assess_refactor_scope',
    description: 'Assess refactoring scope and recommend polish or overhaul track',
    schema: z.object({
      files: z.array(z.string()).optional(),
      stateFile: z.string().optional(),
    }),
    phases: new Set<string>(['explore', 'brief']),
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'check_pr_comments',
    description: 'Check PR for unresolved review comment threads',
    schema: z.object({
      pr: z.number().int().positive(),
      repo: z.string().optional(),
    }),
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_REMOTE,
  },
  {
    name: 'validate_pr_body',
    description: 'Validate PR body contains required sections (Summary, Changes, Test Plan)',
    schema: z.object({
      pr: z.number().int().positive().optional(),
      bodyFile: z.string().optional(),
      body: z.string().optional(),
      template: z.string().optional(),
    }),
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'validate_pr_stack',
    description: 'Validate PR stack ordering and base branch consistency',
    schema: z.object({
      baseBranch: z.string().min(1),
    }),
    phases: new Set<string>(['synthesize']),
    roles: ROLE_LEAD,
    gate: { blocking: true },
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'debug_review_gate',
    description: 'Run debug-track review gate: verify test files exist and pass for changed files',
    schema: z.object({
      repoRoot: z.string().min(1),
      baseBranch: z.string().min(1),
      skipRun: z.boolean().optional(),
    }),
    phases: new Set<string>(['debug-review']),
    roles: ROLE_LEAD,
    gate: { blocking: true },
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'extract_fix_tasks',
    description: 'Extract fix tasks from review findings and map to worktrees',
    schema: z.object({
      stateFile: z.string().min(1),
      reviewReport: z.string().optional(),
      repoRoot: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'classify_review_items',
    description: 'Group ActionItems by file and recommend dispatch strategy (direct/delegate-fixer/delegate-scaffolder) per group (#1159)',
    schema: z.object({
      featureId: z.string().min(1),
      actionItems: z.array(z.record(z.string(), z.unknown())),
    }),
    // Shepherd operates within `synthesize` and invokes classify_review_items
    // after assess_stack; restricting to REVIEW_PHASES would trip phase-guard
    // at runtime (#1161 / Sentry bug prediction).
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'generate_traceability',
    description: 'Generate a traceability matrix mapping design sections to plan tasks',
    schema: z.object({
      designFile: z.string().min(1),
      planFile: z.string().min(1),
      outputFile: z.string().optional(),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'spec_coverage_check',
    description: 'Verify that test files referenced in the plan exist in the repo',
    schema: z.object({
      planFile: z.string().min(1),
      repoRoot: z.string().min(1),
      skipRun: z.boolean().optional(),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D1' },
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'verify_worktree_baseline',
    description: 'Verify a worktree passes baseline tests before task work begins',
    schema: z.object({
      worktreePath: z.string().min(1),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'setup_worktree',
    description: 'Create a git worktree for a task with branch and baseline verification',
    schema: z.object({
      repoRoot: z.string().min(1),
      taskId: z.string().min(1),
      taskName: z.string().min(1),
      baseBranch: z.string().optional(),
      skipTests: z.boolean().optional(),
      // DR-3 (T-09, #1204): resolution priority is
      //   `branch` > `workflow.tasks[id=taskId].branch` > legacy default.
      // Provide `featureId` to let the composite adapter look up the planned
      // branch from workflow state when `branch` is not supplied.
      branch: z.string().min(1).optional(),
      featureId: z.string().min(1).optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'verify_delegation_saga',
    description: 'Verify delegation event saga completeness (spawned, dispatched, disbanded)',
    schema: z.object({
      featureId: z.string().min(1),
      stateDir: z.string().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'post_delegation_check',
    description: 'Run post-delegation checks: task completion, test pass, branch existence',
    schema: z.object({
      stateFile: z.string().min(1).optional(),
      featureId: z.string().min(1).optional(),
      repoRoot: z.string().min(1),
      skipTests: z.boolean().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true },
    // DR-5: chains `npm run test:run` across every task worktree with a
    // 120s per-worktree timeout; scales with the number of tasks.
    longRunning: true,
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: COMPENSABLE_LOCAL,
  },
  {
    name: 'reconcile_state',
    description: 'Reconcile workflow state file against git and filesystem reality',
    schema: z.object({
      stateFile: z.string().min(1).optional(),
      featureId: z.string().min(1).optional(),
      repoRoot: z.string().min(1),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'pre_synthesis_check',
    description: 'Run pre-synthesis checks: task completion, reviews, tests, and stack health',
    schema: z.object({
      stateFile: z.string().min(1),
      repoRoot: z.string().optional(),
      skipTests: z.boolean().optional(),
      skipStack: z.boolean().optional(),
      testCommand: z.string().optional(),
    }),
    phases: new Set<string>(['synthesize']),
    roles: ROLE_LEAD,
    gate: { blocking: true },
    // DR-5: runs the full project test suite + typecheck + build + stack
    // assessment; routinely seconds-to-minutes on real repos.
    longRunning: true,
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'new_project',
    description: 'Initialize a new project with workflow configuration files',
    schema: z.object({
      projectPath: z.string().optional(),
      language: z.enum(['typescript', 'csharp']).optional(),
      minimal: z.boolean().optional(),
      platform: z.enum(['claude-code', 'generic', 'auto']).default('auto').optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'check_coderabbit',
    description: 'Query CodeRabbit review state on GitHub PRs — APPROVED/NONE → pass, else fail',
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      prNumbers: z.array(z.number()),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_REMOTE,
  },
  {
    name: 'check_polish_scope',
    description: 'Check if polish refactor scope has expanded beyond limits (>5 files, >2 modules)',
    schema: z.object({
      repoRoot: z.string(),
      baseBranch: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'needs_schema_sync',
    description: 'Detect API file modifications (Endpoints.cs, Models/, Requests/, etc.) requiring schema sync',
    schema: z.object({
      repoRoot: z.string(),
      baseBranch: z.string().optional(),
      diffFile: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'verify_doc_links',
    description: 'Check that internal markdown links resolve to existing files',
    schema: z.object({
      docFile: z.string().optional(),
      docsDir: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'verify_review_triage',
    description: 'Verify review triage routing — check review.routed events against state file PRs',
    schema: z.object({
      stateFile: z.string(),
      eventStream: z.string(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'prepare_review',
    description: 'Prepare quality review by serving the check catalog as structured data. Returns deterministic check patterns, structural analysis instructions, and plugin status for any MCP client to execute.',
    schema: z.object({
      featureId: z.string().min(1),
      scope: z.string().optional(),
      dimensions: z.array(z.string()).optional(),
      repoRoot: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false },
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'prune_stale_workflows',
    description: 'Find stale non-terminal workflows and cancel them. Defaults to dry-run; pass dryRun:false to actually prune. Auto-emits workflow.pruned event per pruned workflow.',
    schema: z.object({
      thresholdMinutes: z.number().int().positive().optional(),
      dryRun: z.boolean().optional(),
      force: z.boolean().optional(),
      includeOneShot: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'workflow.pruned', condition: 'conditional', description: 'Per pruned workflow when dryRun is false' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: COMPENSABLE_LOCAL,
  },
  {
    name: 'request_synthesize',
    description: 'Opt-in event for oneshot workflows with synthesisPolicy:on-request. Appending a synthesize.requested event flips the choice-state guard so finalize_oneshot routes to the synthesize phase. Auto-emits synthesize.requested.',
    schema: z.object({
      featureId: featureIdSchema,
      reason: z.string().optional(),
    }),
    // Allowed from `plan` as well as `implementing`: the synthesisOptedIn
    // guard only fires at the `implementing → ?` choice-state boundary, so
    // emitting the event earlier is idempotent — it sits in the event stream
    // until finalize_oneshot reads it. Restricting to `implementing` broke
    // the "I know I'll want a PR" signal during planning.
    phases: new Set<string>(['plan', 'implementing']),
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'synthesize.requested', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'finalize_oneshot',
    description: 'Resolve the oneshot choice-state at the end of implementing: transitions to synthesize (PR path) or completed (direct-commit path) based on the synthesisOptedIn / synthesisOptedOut guards. The transition itself is emitted by the workflow set handler.',
    schema: z.object({
      featureId: featureIdSchema,
    }),
    phases: new Set<string>(['implementing']),
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'runbook',
    description: 'List available runbooks or get a resolved runbook with schemas',
    schema: z.object({
      phase: z.string().optional(),
      id: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'agent_spec',
    description: 'Retrieve agent specification for subagent dispatch',
    schema: agentSpecSchemaForRegistry,
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'doctor',
    description: 'Run exarchos environment diagnostics — 10 checks across runtime, storage, VCS, agent config, plugin, env, and remote surfaces. Emits diagnostic.executed on completion.',
    schema: z.object({
      timeoutMs: z.number().int().positive().optional(),
      format: z.enum(['table', 'json']).optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'diagnostic.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    // sentry HIGH on PR #1369: `doctor` emits `diagnostic.executed` on
    // every invocation (see `autoEmits` above and
    // `orchestrate/doctor/index.ts:204`). The advisory annotation must
    // match the actual write surface — `readOnly: true` would let a
    // readonly-capability client trigger event-store writes and bypass
    // the audit boundary.
    annotations: LOCAL_MUTATION,
  },
  // ─── VCS Actions ──────────────────────────────────────────────────────────
  {
    name: 'create_pr',
    description: 'Create a pull/merge request via the VCS provider abstraction. Auto-emits pr.created event.',
    schema: z.object({
      title: z.string().min(1),
      body: z.string().min(1),
      base: z.string().min(1),
      head: z.string().min(1),
      draft: z.boolean().optional(),
      labels: z.array(z.string()).optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'pr.created', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: COMPENSABLE_REMOTE,
  },
  {
    name: 'merge_pr',
    description: 'Merge a pull/merge request via the VCS provider abstraction. Auto-emits pr.merged event on success.',
    schema: z.object({
      prId: z.string().min(1),
      strategy: z.enum(['squash', 'rebase', 'merge']),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'pr.merged', condition: 'conditional', description: 'When merge succeeds' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: COMPENSABLE_REMOTE,
  },
  {
    name: 'check_ci',
    description: 'Check CI status for a pull/merge request via the VCS provider abstraction. Read-only, no events emitted.',
    schema: z.object({
      prId: z.string().min(1),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_REMOTE,
  },
  {
    name: 'list_prs',
    description: 'List pull/merge requests via the VCS provider abstraction. Read-only, no events emitted.',
    schema: z.object({
      state: z.enum(['open', 'closed', 'merged', 'all']).optional(),
      head: z.string().optional(),
      base: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_REMOTE,
  },
  {
    name: 'get_pr_comments',
    description: 'Get comments on a pull/merge request via the VCS provider abstraction. Read-only, no events emitted.',
    schema: z.object({
      prId: z.string().min(1),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_REMOTE,
  },
  {
    name: 'add_pr_comment',
    description: 'Add a comment to a pull/merge request via the VCS provider abstraction. Auto-emits pr.commented event.',
    schema: z.object({
      prId: z.string().min(1),
      body: z.string().min(1),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'pr.commented', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: COMPENSABLE_REMOTE,
  },
  {
    name: 'create_issue',
    description: 'Create an issue via the VCS provider abstraction. Auto-emits issue.created event.',
    schema: z.object({
      title: z.string().min(1),
      body: z.string().min(1),
      labels: z.array(z.string()).optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'issue.created', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: COMPENSABLE_REMOTE,
  },
  // ─── Init Action ──────────────────────────────────────────────────────────
  {
    name: 'init',
    description: 'Initialize runtime configurations and detect VCS provider. Writes MCP server config for detected/specified runtimes. Emits init.executed on completion.',
    schema: z.object({
      runtime: z.string().optional(),
      vcs: z.string().optional(),
      nonInteractive: z.boolean().optional(),
      forceOverwrite: z.boolean().optional(),
      format: z.enum(['table', 'json']).optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    autoEmits: [
      { event: 'init.executed', condition: 'always' },
    ],
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  makeDescribeAction(),
];

// ─── Composite Tool: exarchos_view ──────────────────────────────────────────

const viewActions: readonly ToolAction[] = [
  {
    name: 'pipeline',
    description: 'Aggregated view of active workflows with stack positions (excludes completed/cancelled unless includeCompleted=true)',
    schema: z.object({
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      includeCompleted: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    cli: {
      alias: 'ls',
      examples: ['exarchos vw ls'],
    },
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'tasks',
    description: 'Task detail view with filtering and projection',
    schema: z.object({
      workflowId: z.string().optional(),
      filter: coercedRecord().optional(),
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
      fields: coercedStringArray().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    cli: {
      flags: { workflowId: { alias: 'w' }, limit: { alias: 'l' } },
      examples: ['exarchos vw tasks -w my-feature'],
    },
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'workflow_status',
    description: 'Workflow phase, task counts, and metadata',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'stack_status',
    description: 'Get current stack positions from events',
    schema: z.object({
      streamId: z.string().optional(),
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
    }),
    phases: STACK_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'stack_place',
    description: 'Record a stack position for a task',
    schema: z.object({
      streamId: z.string().min(1),
      position: coercedNonnegativeInt(),
      taskId: z.string().min(1),
      branch: z.string().optional(),
      prUrl: z.string().optional(),
    }),
    phases: STACK_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION,
  },
  {
    name: 'telemetry',
    description: 'Get telemetry metrics with per-tool performance data and optimization hints',
    schema: z.object({
      compact: z.boolean().optional(),
      tool: z.string().optional(),
      sort: z.enum(['tokens', 'invocations', 'duration']).optional(),
      limit: coercedPositiveInt().optional(),
      // Wave 5 (#1437) — correlation tuple filters scope the telemetry
      // rollup to a single dispatch boundary. Honored at the backend layer
      // (indexed columns / post-fetch JS filter); INV-1 keeps payload as
      // truth, mirrored to the indexed columns.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    // PR3/T10 (#1364) — typed envelope advertises the per-tool
    // `actionErrors` + `actionErrorBreakdown` fields (post Wave 0 carrier
    // composition).
    outputSchema: TelemetryViewOutputSchema,
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'team_performance',
    description: 'Team performance metrics from delegation events',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'delegation_timeline',
    description: 'Delegation timeline with bottleneck detection',
    schema: z.object({
      workflowId: z.string().optional(),
      // Wave 5 (#1437) — correlation tuple filters scope the projection
      // fold to a single dispatch boundary.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'code_quality',
    description: 'Code quality metrics with gate pass rates, skill attribution, and regression detection',
    schema: z.object({
      workflowId: z.string().optional(),
      skill: z.string().optional(),
      gate: z.string().optional(),
      limit: coercedPositiveInt().optional(),
      // Wave 5 (#1437) — correlation tuple filters scope the projection
      // fold to a single dispatch boundary.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  // Wave 5 (#1437) — Group B telemetry view actions. These actions were
  // previously dispatched via `exarchos_view` through composite.ts but had
  // no entry in TOOL_REGISTRY's `viewActions`, so per-action schema
  // validation (DR-5) and describe-handler introspection both skipped them.
  // Registering them here brings them under the dispatch-validation contract
  // AND surfaces their correlation-filter slots through `describe(actions)`.
  {
    name: 'eval_results',
    description: 'Evaluation suite results with per-skill pass/fail rates and regression flags',
    schema: z.object({
      workflowId: z.string().optional(),
      skill: z.string().optional(),
      limit: coercedPositiveInt().optional(),
      // Wave 5 (#1437) — correlation tuple filters scope the projection
      // fold to a single dispatch boundary.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'quality_correlation',
    description: 'Per-skill correlation of code-quality gate pass rates with eval scores',
    schema: z.object({
      workflowId: z.string().optional(),
      // Wave 5 (#1437) — correlation tuple filters scope BOTH underlying
      // projection folds (CQ + ER) to a single dispatch boundary so the
      // joined output stays internally consistent.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'quality_attribution',
    description: 'Attribute quality outcomes across a dimension (skill / model / gate / prompt-version)',
    schema: z.object({
      workflowId: z.string().optional(),
      dimension: z.enum(['skill', 'model', 'gate', 'prompt-version']).optional(),
      skill: z.string().optional(),
      timeRange: z
        .object({
          start: z.string(),
          end: z.string(),
        })
        .optional(),
      // Wave 5 (#1437) — correlation tuple filters scope BOTH underlying
      // projection folds (CQ + ER) to a single dispatch boundary.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'delegation_readiness',
    description: 'Check delegation readiness: plan approval, quality gates, and worktree status',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  // T1 (#1446 residue) — three view actions dispatched through
  // `views/composite.ts` but previously absent from TOOL_REGISTRY.viewActions.
  // Without the registry entry, per-action Zod validation at
  // `core/dispatch.ts:801` is silently skipped (DR-5 hole) and
  // `exarchos_view describe` cannot surface their schemas. Registering them
  // here closes both gaps. Schemas mirror the args the composite.ts handlers
  // route today (see `views/composite.ts` cases for each action).
  {
    name: 'session_provenance',
    description: 'Per-session provenance roll-up (tokens, tools, cost attribution) — query by sessionId or workflowId, optionally narrowed by metric',
    schema: z.object({
      sessionId: z.string().optional(),
      workflowId: z.string().optional(),
      metric: z.string().optional(),
      // No correlation-tuple filter slots: the underlying handler
      // (`handleViewSessionProvenance`) does not receive the event store.
      // The session-provenance projection reads `stateDir` only, so there
      // is no event-store query for the tuple filters to scope.
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'provenance',
    description: 'Design-to-task provenance: per-requirement coverage and orphan-task detection from the design.linked / task.assigned event chain',
    schema: z.object({
      workflowId: z.string().optional(),
      // Underlying handler (`handleViewProvenance`) queries the event store
      // via `queryDeltaEvents`, so the correlation-tuple filter surface
      // mirrors the Wave 5 (#1437) telemetry-view contract — slots are
      // optional and pass through the cache-bypassing filtered fold path
      // when present.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'ideate_readiness',
    description: 'Check ideate-phase readiness: design artifact presence and the gates that gate transition to plan',
    schema: z.object({
      workflowId: z.string().optional(),
      // Underlying handler (`handleViewIdeateReadiness`) queries the event
      // store via `queryDeltaEvents`; correlation-tuple filter surface
      // mirrors the Wave 5 (#1437) contract.
      ...CORRELATION_TUPLE_FILTER_SHAPE,
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'synthesis_readiness',
    description: 'Check synthesis readiness: task completion, reviews, tests, and typecheck status',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'shepherd_status',
    description: 'PR shepherd status: CI, comments, unresolved findings, and iteration tracking',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'convergence',
    description: 'Per-dimension gate convergence status (D1-D5) from gate.executed events',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  {
    name: 'quality_hints',
    description: 'Generate quality improvement hints from code quality view',
    schema: z.object({
      workflowId: z.string().optional().describe('Workflow ID to generate hints for'),
      skill: z.string().optional().describe('Filter hints by skill name'),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: READ_ONLY_LOCAL,
  },
  makeDescribeAction(),
];

// ─── Composite Tool: exarchos_sync ──────────────────────────────────────────

const syncActions: readonly ToolAction[] = [
  {
    name: 'now',
    description: 'Trigger immediate sync with remote',
    schema: z.object({}),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: LOCAL_MUTATION_IDEMPOTENT,
  },
];

// ─── Tool Registry ──────────────────────────────────────────────────────────

export const TOOL_REGISTRY: readonly CompositeTool[] = [
  {
    name: 'exarchos_workflow',
    description: 'Workflow lifecycle management — init, read, update, cancel, cleanup, checkpoint, reconcile, and rehydrate workflows',
    actions: workflowActions,
    cli: { alias: 'wf' },
    slimDescription: 'Workflow lifecycle management. Use describe(actions) for schemas.\n\nActions: init, get, update, transition, cancel, cleanup, reconcile, checkpoint, rehydrate',
  },
  {
    name: 'exarchos_event',
    description: 'Event sourcing — append and query events in streams',
    actions: eventActions,
    cli: { alias: 'ev' },
    slimDescription: 'Event sourcing — append and query events. Use describe(actions) for action schemas, describe(eventTypes) for event data schemas.\n\nActions: append, query, batch_append',
  },
  {
    name: 'exarchos_orchestrate',
    description: 'Task coordination — claim, complete, and fail tasks',
    actions: orchestrateActions,
    cli: { alias: 'orch' },
    slimDescription: 'Task coordination, quality gates, validation actions, and VCS operations. Use describe(actions) for schemas.\n\nActions: task_claim, task_complete, task_fail, review_triage, prepare_delegation, prepare_synthesis, assess_stack, check_static_analysis, check_security_scan, check_context_economy, check_operational_resilience, check_workflow_determinism, check_review_verdict, check_convergence, check_provenance_chain, check_design_completeness, check_plan_coverage, check_tdd_compliance, check_post_merge, check_task_decomposition, check_event_emissions, extract_task, review_diff, verify_worktree, select_debug_track, investigation_timer, check_coverage_thresholds, assess_refactor_scope, check_pr_comments, validate_pr_body, validate_pr_stack, debug_review_gate, extract_fix_tasks, generate_traceability, spec_coverage_check, verify_worktree_baseline, setup_worktree, verify_delegation_saga, post_delegation_check, reconcile_state, pre_synthesis_check, new_project, runbook, agent_spec, doctor, create_pr, merge_pr, check_ci, list_prs, get_pr_comments, add_pr_comment, create_issue, merge_orchestrate',
  },
  {
    name: 'exarchos_view',
    description: 'CQRS materialized views — pipeline, tasks, workflow status, stack, and telemetry',
    actions: viewActions,
    cli: { alias: 'vw' },
    slimDescription: 'CQRS materialized views for pipeline, tasks, and telemetry. Use describe(actions) for schemas.\n\nActions: pipeline, tasks, workflow_status, stack_status, stack_place, telemetry, team_performance, delegation_timeline, code_quality, eval_results, quality_correlation, quality_attribution, quality_hints, delegation_readiness, synthesis_readiness, shepherd_status, convergence, session_provenance, provenance, ideate_readiness',
  },
  {
    name: 'exarchos_sync',
    description: 'Remote synchronization — trigger immediate sync (planned)',
    actions: syncActions,
    cli: { alias: 'sy' },
    hidden: true,
    slimDescription: 'Remote synchronization. Use describe(actions) for schemas.\n\nActions: now',
  },
];

// ─── Registration-time Invariant Loop (Wave 0 task C.3) ────────────────
//
// Runs at module load so any built-in action that drifts away from the
// `outputSchema` + `annotations` contract fails the import (DIM-3 fail-
// closed at startup). Custom tools registered via `registerCustomTool`
// are not covered here — that path validates per-action at call time
// through `validateAction` once `register.ts` is wired (Wave 0 follow-up).
for (const tool of TOOL_REGISTRY) {
  for (const action of tool.actions) {
    validateAction(action, tool.name);
  }
}

// ─── Built-in Tool Names ────────────────────────────────────────────────────

const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_REGISTRY.map((t) => t.name),
);

// ─── Dynamic Tool Registration (DEPRECATED — superseded by v3.0 #1258) ─────
//
// The `registerCustomTool` / `setCustomToolActionHandler` /
// `unregisterCustomTool` surface plus the `exarchos.config.ts` `tools:`
// block is the pre-SDK extension scaffolding for declaring custom MCP
// composite tools at runtime. It is superseded by the Workflow Builder
// SDK (epic #1258) shipping in v3.0, which becomes the single authoring
// surface for workflows AND custom tools. The closed-form `hsm-
// definitions.ts` / `playbooks.ts` registries are deleted in that
// milestone for the same DIM-5 hygiene reason — the SDK is the single
// source of truth.
//
// There are no known active consumers of this surface. CodeRabbit MAJOR
// on PR #1369 flagged that `registerCustomTool` doesn't run actions
// through `validateAction`, leaving missing `outputSchema`/`annotations`
// to surface as runtime crashes far from the registration site. Rather
// than tighten the contract (which would touch test fixtures and ship a
// pseudo-breaking-change to an API with no consumers), we mark the
// entire surface `@deprecated` here and schedule its removal alongside
// #1258 in v3.0.

const customTools: CompositeTool[] = [];

/** Maps `toolName -> actionName -> handler` for custom tool dispatch. */
const customToolHandlers = new Map<string, Map<string, CustomToolActionHandler>>();

export type CustomToolActionHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Register a custom composite tool. Throws if the name collides with a
 * built-in tool or an already-registered custom tool.
 *
 * @deprecated since v2.10.0 — this surface is removed in v3.0.0 in favor
 * of the Workflow Builder SDK (epic #1258), which becomes the single
 * authoring path for custom workflows and tools. New extension code
 * should target the v3.0 SDK instead.
 */
export function registerCustomTool(tool: CompositeTool): void {
  if (BUILTIN_TOOL_NAMES.has(tool.name)) {
    throw new Error(
      `Cannot register custom tool "${tool.name}": collides with built-in tool name`,
    );
  }
  if (customTools.some((t) => t.name === tool.name)) {
    throw new Error(
      `Cannot register custom tool "${tool.name}": already registered as a custom tool`,
    );
  }
  // Custom tools are intentionally NOT run through `validateAction` here.
  // The whole surface is `@deprecated` for v3.0 removal per #1258, so
  // hardening the contract here would ship a pseudo-breaking-change for
  // an API with no consumers (CodeRabbit PR #1369 MAJOR, resolved by
  // deprecation rather than tightening).
  customTools.push(tool);
}

/**
 * Store a handler function for a custom tool action.
 * Called during config-driven registration to wire handlers for dispatch.
 *
 * @deprecated since v2.10.0 — removed in v3.0.0 per #1258. See
 * {@link registerCustomTool}.
 */
export function setCustomToolActionHandler(
  toolName: string,
  actionName: string,
  handler: CustomToolActionHandler,
): void {
  let actionMap = customToolHandlers.get(toolName);
  if (!actionMap) {
    actionMap = new Map();
    customToolHandlers.set(toolName, actionMap);
  }
  actionMap.set(actionName, handler);
}

/**
 * Retrieve the handler for a custom tool action.
 * Returns undefined if the tool or action is not registered.
 *
 * @deprecated since v2.10.0 — removed in v3.0.0 per #1258. See
 * {@link registerCustomTool}.
 */
export function getCustomToolActionHandler(
  toolName: string,
  actionName: string,
): CustomToolActionHandler | undefined {
  return customToolHandlers.get(toolName)?.get(actionName);
}

/**
 * Check if a custom tool has any registered handlers.
 *
 * @deprecated since v2.10.0 — removed in v3.0.0 per #1258. See
 * {@link registerCustomTool}.
 */
export function hasCustomToolHandlers(toolName: string): boolean {
  const actionMap = customToolHandlers.get(toolName);
  return actionMap !== undefined && actionMap.size > 0;
}

/**
 * Unregister a custom composite tool by name. Throws if the name is a
 * built-in tool or not registered as a custom tool.
 *
 * @deprecated since v2.10.0 — removed in v3.0.0 per #1258. See
 * {@link registerCustomTool}.
 */
export function unregisterCustomTool(name: string): void {
  if (BUILTIN_TOOL_NAMES.has(name)) {
    throw new Error(
      `Cannot unregister built-in tool "${name}"`,
    );
  }
  const index = customTools.findIndex((t) => t.name === name);
  if (index === -1) {
    throw new Error(
      `Cannot unregister tool "${name}": not registered as a custom tool`,
    );
  }
  customTools.splice(index, 1);
  customToolHandlers.delete(name);
}

/**
 * Returns the full registry: built-in TOOL_REGISTRY + custom tools.
 */
export function getFullRegistry(): readonly CompositeTool[] {
  if (customTools.length === 0) return TOOL_REGISTRY;
  return [...TOOL_REGISTRY, ...customTools];
}

/**
 * Clear all registered custom tools. Used for test cleanup.
 */
export function clearCustomTools(): void {
  customTools.length = 0;
  customToolHandlers.clear();
}

/**
 * Find a specific action within a tool in the full registry (built-in + custom).
 * Returns undefined if the tool or action is not found.
 */
export function findActionInRegistry(toolName: string, actionName: string): ToolAction | undefined {
  const tool = getFullRegistry().find(t => t.name === toolName);
  return tool?.actions.find(a => a.name === actionName);
}
