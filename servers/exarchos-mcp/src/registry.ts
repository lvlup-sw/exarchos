import { z } from 'zod';
import { WorkflowTypeSchema } from './workflow/schemas.js';
import { agentSpecSchema as agentSpecSchemaForRegistry } from './agents/handler.js';
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

export interface GateMetadata {
  readonly blocking: boolean;
  readonly dimension?: string;
}

export interface AutoEmission {
  readonly event: string;
  readonly condition: 'always' | 'conditional';
  readonly description?: string;
}

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
   * DR-5: When true, the action can take multiple seconds to complete and
   * the CLI adapter should emit stderr heartbeats under `--json` so a long
   * silence doesn't look like the process hung.  MCP hosts render progress
   * natively and ignore this flag.
   */
  readonly longRunning?: boolean;
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
type ActionDiscriminatedSchema = z.ZodObject<{ action: z.ZodTypeAny } & z.ZodRawShape>;

/**
 * Builds a Zod discriminated union from a list of ToolActions.
 * Each action's schema is extended with an `action: z.literal(name)` discriminator.
 */
export function buildCompositeSchema(
  actions: readonly ToolAction[],
): z.ZodDiscriminatedUnion<'action', [ActionDiscriminatedSchema, ...ActionDiscriminatedSchema[]]> {
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
 */
function unwrapPreprocess(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodOptional) {
    const inner = schema._def.innerType;
    if (inner instanceof z.ZodEffects && inner._def.effect.type === 'preprocess') {
      return inner._def.schema.optional();
    }
  }
  if (schema instanceof z.ZodEffects && schema._def.effect.type === 'preprocess') {
    return schema._def.schema;
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
  const shape: z.ZodRawShape = {
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
      const field = unwrapPreprocess(zodType as z.ZodTypeAny);
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

  return z.object(shape).strict();
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

function fieldContract(zodType: z.ZodTypeAny): FieldContract {
  const inner = unwrapOptional(zodType);
  const enumValues = extractEnumValues(inner);
  const defaultValue = extractDefault(inner);
  return {
    kind: enumValues ? 'enum' : baseKind(inner),
    enumValues,
    defaultValue: defaultValue === undefined ? null : JSON.stringify(defaultValue),
  };
}

function baseKind(schema: z.ZodTypeAny): FieldContract['kind'] {
  let current = schema;
  if (current instanceof z.ZodDefault) current = current._def.innerType;
  if (current instanceof z.ZodOptional) current = current._def.innerType;
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

function unwrapOptional(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  // Peel Optional and Nullable wrappers. Keep Default wrappers — the default
  // is a contract-level attribute we explicitly want to inspect.
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    current = current._def.innerType;
  }
  return current;
}

function extractEnumValues(schema: z.ZodTypeAny): readonly string[] | null {
  const current = peelEnumWrappers(schema);
  if (current instanceof z.ZodEnum) {
    return [...(current._def.values as readonly string[])].sort();
  }
  if (current instanceof z.ZodLiteral) {
    // Treat a literal as a 1-member enum so two actions declaring the same
    // field with different literal values collide instead of silently
    // shadowing each other (#1127-class hazard).
    return [JSON.stringify(current._def.value as unknown)];
  }
  if (current instanceof z.ZodNativeEnum) {
    // TS `enum` objects round-trip both member names and values for numeric
    // enums (reverse mapping). Stringify-dedupe the values so string and
    // numeric native enums produce a stable, comparable set.
    const raw = Object.values(current._def.values as Record<string, unknown>);
    return [...new Set(raw.map((v) => JSON.stringify(v)))].sort();
  }
  if (current instanceof z.ZodUnion) {
    // Union-of-literals is the hand-rolled form of z.enum(). Collect the
    // literal values; fall back to null if any branch isn't a literal so
    // heterogeneous unions (e.g. string | string[]) still classify via
    // baseKind instead of being falsely flagged as enum-compatible.
    const options = current._def.options as readonly z.ZodTypeAny[];
    const literalValues: string[] = [];
    for (const opt of options) {
      const peeled = peelEnumWrappers(opt);
      if (!(peeled instanceof z.ZodLiteral)) return null;
      literalValues.push(JSON.stringify(peeled._def.value as unknown));
    }
    return [...new Set(literalValues)].sort();
  }
  return null;
}

/** Peel ZodDefault / ZodOptional / ZodNullable wrappers so the caller can
 *  match on the underlying enum-ish kind. Kept narrow on purpose: we don't
 *  peel ZodEffects or ZodBranded because those change the wire-level
 *  contract and deserve to be classified distinctly. */
function peelEnumWrappers(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (
    current instanceof z.ZodDefault ||
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable
  ) {
    current = current._def.innerType;
  }
  return current;
}

function extractDefault(schema: z.ZodTypeAny): unknown {
  if (schema instanceof z.ZodDefault) {
    return schema._def.defaultValue();
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
      const isOptional = (zodType as z.ZodTypeAny).isOptional();
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
  };
}

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
  },
  {
    name: 'set',
    description: 'Update workflow state fields or transition phase. Auto-emits workflow.transition events when phase is provided and differs from current phase (no-op if already at target phase) — do not duplicate via event append',
    schema: z.object({
      featureId: featureIdSchema,
      updates: coercedRecord().optional(),
      phase: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    cli: {
      flags: { featureId: { alias: 'f' } },
      examples: ['exarchos wf set -f my-feature --phase plan'],
    },
    autoEmits: [
      { event: 'workflow.transition', condition: 'conditional', description: 'When phase is provided and differs from current phase' },
      { event: 'state.patched', condition: 'always' },
    ],
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
  },
  {
    name: 'reconcile',
    description: 'Rebuild workflow state from event store. Applies events newer than state _eventSequence. Idempotent — no new events returns {reconciled: false, eventsApplied: 0}. Use after compaction or crash recovery',
    schema: z.object({
      featureId: featureIdSchema,
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
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
  },
  {
    name: 'checkpoint',
    description: 'Create an explicit checkpoint, resetting the operation counter. Persists checkpoint metadata to workflow state and emits workflow.checkpoint event',
    schema: z.object({
      featureId: featureIdSchema,
      summary: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'workflow.checkpoint', condition: 'always' },
    ],
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
  },
  {
    name: 'check_convergence',
    description: 'Query D1-D5 convergence status from gate.executed events. Returns overall pass/fail and per-dimension summary.',
    schema: z.object({
      featureId: z.string().min(1),
      workflowId: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false },
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
  },
  {
    name: 'verify_worktree',
    description: 'Verify a directory is a valid git worktree',
    schema: z.object({
      cwd: z.string().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_ANY,
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
  },
  {
    name: 'verify_worktree_baseline',
    description: 'Verify a worktree passes baseline tests before task work begins',
    schema: z.object({
      worktreePath: z.string().min(1),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_ANY,
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
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
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
  },
  {
    name: 'finalize_oneshot',
    description: 'Resolve the oneshot choice-state at the end of implementing: transitions to synthesize (PR path) or completed (direct-commit path) based on the synthesisOptedIn / synthesisOptedOut guards. The transition itself is emitted by the workflow set handler.',
    schema: z.object({
      featureId: featureIdSchema,
    }),
    phases: new Set<string>(['implementing']),
    roles: ROLE_LEAD,
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
  },
  {
    name: 'agent_spec',
    description: 'Retrieve agent specification for subagent dispatch',
    schema: agentSpecSchemaForRegistry,
    phases: ALL_PHASES,
    roles: ROLE_ANY,
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
  },
  {
    name: 'check_ci',
    description: 'Check CI status for a pull/merge request via the VCS provider abstraction. Read-only, no events emitted.',
    schema: z.object({
      prId: z.string().min(1),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
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
  },
  {
    name: 'get_pr_comments',
    description: 'Get comments on a pull/merge request via the VCS provider abstraction. Read-only, no events emitted.',
    schema: z.object({
      prId: z.string().min(1),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
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
  },
  {
    name: 'workflow_status',
    description: 'Workflow phase, task counts, and metadata',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
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
  },
  {
    name: 'telemetry',
    description: 'Get telemetry metrics with per-tool performance data and optimization hints',
    schema: z.object({
      compact: z.boolean().optional(),
      tool: z.string().optional(),
      sort: z.enum(['tokens', 'invocations', 'duration']).optional(),
      limit: coercedPositiveInt().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
  },
  {
    name: 'team_performance',
    description: 'Team performance metrics from delegation events',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
  },
  {
    name: 'delegation_timeline',
    description: 'Delegation timeline with bottleneck detection',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
  },
  {
    name: 'code_quality',
    description: 'Code quality metrics with gate pass rates, skill attribution, and regression detection',
    schema: z.object({
      workflowId: z.string().optional(),
      skill: z.string().optional(),
      gate: z.string().optional(),
      limit: coercedPositiveInt().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
  },
  {
    name: 'delegation_readiness',
    description: 'Check delegation readiness: plan approval, quality gates, and worktree status',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
  },
  {
    name: 'synthesis_readiness',
    description: 'Check synthesis readiness: task completion, reviews, tests, and typecheck status',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
  },
  {
    name: 'shepherd_status',
    description: 'PR shepherd status: CI, comments, unresolved findings, and iteration tracking',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
  },
  {
    name: 'convergence',
    description: 'Per-dimension gate convergence status (D1-D5) from gate.executed events',
    schema: z.object({
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
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
  },
];

// ─── Tool Registry ──────────────────────────────────────────────────────────

export const TOOL_REGISTRY: readonly CompositeTool[] = [
  {
    name: 'exarchos_workflow',
    description: 'Workflow lifecycle management — init, read, update, cancel, cleanup, checkpoint, reconcile, and rehydrate workflows',
    actions: workflowActions,
    cli: { alias: 'wf' },
    slimDescription: 'Workflow lifecycle management. Use describe(actions) for schemas.\n\nActions: init, get, set, cancel, cleanup, reconcile, checkpoint, rehydrate',
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
    slimDescription: 'Task coordination, quality gates, validation actions, and VCS operations. Use describe(actions) for schemas.\n\nActions: task_claim, task_complete, task_fail, review_triage, prepare_delegation, prepare_synthesis, assess_stack, check_static_analysis, check_security_scan, check_context_economy, check_operational_resilience, check_workflow_determinism, check_review_verdict, check_convergence, check_provenance_chain, check_design_completeness, check_plan_coverage, check_tdd_compliance, check_post_merge, check_task_decomposition, check_event_emissions, extract_task, review_diff, verify_worktree, select_debug_track, investigation_timer, check_coverage_thresholds, assess_refactor_scope, check_pr_comments, validate_pr_body, validate_pr_stack, debug_review_gate, extract_fix_tasks, generate_traceability, spec_coverage_check, verify_worktree_baseline, setup_worktree, verify_delegation_saga, post_delegation_check, reconcile_state, pre_synthesis_check, new_project, runbook, agent_spec, doctor, create_pr, merge_pr, check_ci, list_prs, get_pr_comments, add_pr_comment, create_issue',
  },
  {
    name: 'exarchos_view',
    description: 'CQRS materialized views — pipeline, tasks, workflow status, stack, and telemetry',
    actions: viewActions,
    cli: { alias: 'vw' },
    slimDescription: 'CQRS materialized views for pipeline, tasks, and telemetry. Use describe(actions) for schemas.\n\nActions: pipeline, tasks, workflow_status, stack_status, stack_place, telemetry, team_performance, delegation_timeline, code_quality, quality_hints, delegation_readiness, synthesis_readiness, shepherd_status, convergence',
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

// ─── Built-in Tool Names ────────────────────────────────────────────────────

const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_REGISTRY.map((t) => t.name),
);

// ─── Dynamic Tool Registration ──────────────────────────────────────────────

const customTools: CompositeTool[] = [];

/** Maps `toolName -> actionName -> handler` for custom tool dispatch. */
const customToolHandlers = new Map<string, Map<string, CustomToolActionHandler>>();

export type CustomToolActionHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Register a custom composite tool. Throws if the name collides with a
 * built-in tool or an already-registered custom tool.
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
  customTools.push(tool);
}

/**
 * Store a handler function for a custom tool action.
 * Called during config-driven registration to wire handlers for dispatch.
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
 */
export function getCustomToolActionHandler(
  toolName: string,
  actionName: string,
): CustomToolActionHandler | undefined {
  return customToolHandlers.get(toolName)?.get(actionName);
}

/**
 * Check if a custom tool has any registered handlers.
 */
export function hasCustomToolHandlers(toolName: string): boolean {
  const actionMap = customToolHandlers.get(toolName);
  return actionMap !== undefined && actionMap.size > 0;
}

/**
 * Unregister a custom composite tool by name. Throws if the name is a
 * built-in tool or not registered as a custom tool.
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
