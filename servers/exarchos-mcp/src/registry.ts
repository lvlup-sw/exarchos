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

  for (const action of actions) {
    const fields = action.schema.shape;
    for (const [key, zodType] of Object.entries(fields)) {
      if (key in shape) continue; // already added from an earlier action
      // Make all per-action fields optional at the composite level;
      // individual handlers enforce required fields via their own schemas.
      // Unwrap preprocess effects for clean JSON Schema generation.
      const field = unwrapPreprocess(zodType as z.ZodTypeAny);
      shape[key] = field.isOptional() ? field : field.optional();
    }
  }

  return z.object(shape).strict();
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

/** Workflow-specific describe schema: supports actions, topology, and playbooks. */
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
});

/** Creates a workflow-specific describe action with topology and playbook support. */
function makeWorkflowDescribeAction(): ToolAction {
  return {
    name: 'describe',
    description: 'Return full schemas, descriptions, gate metadata, and phase/role info for specific actions. Optionally return HSM topology or phase playbooks for a workflow type.',
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
    description: 'Initialize a new workflow. Auto-emits workflow.started event',
    schema: z.object({
      featureId: featureIdSchema,
      workflowType: WorkflowTypeSchema,
    }),
    phases: new Set<string>(),
    roles: ROLE_LEAD,
    cli: {
      flags: { featureId: { alias: 'f' }, workflowType: { alias: 't' } },
      examples: ['exarchos wf init -f my-feature -t feature'],
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
      basileusConnected: z.boolean().optional(),
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
      nativeIsolation: z.boolean().default(false).describe('When true, skip worktree-related blockers (Claude Code handles isolation natively via isolation: "worktree")'),
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
    }),
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
      stateFile: z.string().min(1),
      repoRoot: z.string().min(1),
      skipTests: z.boolean().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
  },
  {
    name: 'reconcile_state',
    description: 'Reconcile workflow state file against git and filesystem reality',
    schema: z.object({
      stateFile: z.string().min(1),
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
    }),
    phases: new Set<string>(['synthesize']),
    roles: ROLE_LEAD,
    gate: { blocking: true },
    autoEmits: [
      { event: 'gate.executed', condition: 'always' },
    ],
  },
  {
    name: 'new_project',
    description: 'Initialize a new project with Claude Code configuration files',
    schema: z.object({
      projectPath: z.string().optional(),
      language: z.enum(['typescript', 'csharp']).optional(),
      minimal: z.boolean().optional(),
    }),
    phases: ALL_PHASES,
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
    description: 'Workflow lifecycle management — init, read, update, cancel, cleanup, and reconcile workflows',
    actions: workflowActions,
    cli: { alias: 'wf' },
    slimDescription: 'Workflow lifecycle management. Use describe(actions) for schemas.\n\nActions: init, get, set, cancel, cleanup, reconcile',
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
    slimDescription: 'Task coordination, quality gates, and validation actions. Use describe(actions) for schemas.\n\nActions: task_claim, task_complete, task_fail, review_triage, prepare_delegation, prepare_synthesis, assess_stack, check_static_analysis, check_security_scan, check_context_economy, check_operational_resilience, check_workflow_determinism, check_review_verdict, check_convergence, check_provenance_chain, check_design_completeness, check_plan_coverage, check_tdd_compliance, check_post_merge, check_task_decomposition, check_event_emissions, extract_task, review_diff, verify_worktree, select_debug_track, investigation_timer, check_coverage_thresholds, assess_refactor_scope, check_pr_comments, validate_pr_body, validate_pr_stack, debug_review_gate, extract_fix_tasks, generate_traceability, spec_coverage_check, verify_worktree_baseline, setup_worktree, verify_delegation_saga, post_delegation_check, reconcile_state, pre_synthesis_check, new_project, runbook, agent_spec',
  },
  {
    name: 'exarchos_view',
    description: 'CQRS materialized views — pipeline, tasks, workflow status, stack, and telemetry',
    actions: viewActions,
    cli: { alias: 'vw' },
    slimDescription: 'CQRS materialized views for pipeline, tasks, and telemetry. Use describe(actions) for schemas.\n\nActions: pipeline, tasks, workflow_status, stack_status, stack_place, telemetry, team_performance, delegation_timeline, code_quality, delegation_readiness, synthesis_readiness, shepherd_status, convergence',
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
