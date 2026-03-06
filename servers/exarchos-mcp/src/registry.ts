import { z } from 'zod';
import { WorkflowTypeSchema } from './workflow/schemas.js';

// ─── Type Coercion Helpers ──────────────────────────────────────────────────
// LLM tool callers sometimes pass objects as JSON strings and numbers as
// string digits. These helpers transparently coerce before Zod validation.

function tryJsonParse(val: string): unknown {
  try {
    const parsed = JSON.parse(val);
    return typeof parsed === 'object' && parsed !== null ? parsed : val;
  } catch {
    return val;
  }
}

/** z.record() that also accepts a JSON string and parses it to an object.
 *  Uses z.preprocess directly into z.record so zodToJsonSchema emits
 *  {"type":"object"} instead of {} — prompting the LLM to pass native objects.
 */
export function coercedRecord() {
  return z.preprocess(
    (val) => (typeof val === 'string' ? tryJsonParse(val) : val),
    z.record(z.string(), z.unknown()),
  );
}

/** z.number().int().positive() that also accepts a numeric string.
 *  Preprocesses directly into z.number so zodToJsonSchema emits {"type":"integer"}.
 */
export function coercedPositiveInt() {
  return z.preprocess(
    (val) => (typeof val === 'string' ? Number(val) : val),
    z.number().int().positive(),
  );
}

/** z.number().int().nonnegative() that also accepts a numeric string.
 *  Preprocesses directly into z.number so zodToJsonSchema emits {"type":"integer"}.
 */
export function coercedNonnegativeInt() {
  return z.preprocess(
    (val) => (typeof val === 'string' ? Number(val) : val),
    z.number().int().nonnegative(),
  );
}

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

export interface ToolAction {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly phases: ReadonlySet<string>;
  readonly roles: ReadonlySet<string>;
  readonly cli?: CliActionHints;
}

export interface CompositeTool {
  readonly name: string;
  readonly description: string;
  readonly actions: readonly ToolAction[];
  readonly cli?: CliToolHints;
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
export function buildToolDescription(tool: CompositeTool): string {
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

const ALL_PHASES: ReadonlySet<string> = new Set([
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
  },
  {
    name: 'get',
    description: 'Read workflow state with optional query or field projection',
    schema: z.object({
      featureId: featureIdSchema,
      query: z.string().optional(),
      fields: z.array(z.string()).optional(),
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
    description: 'Update workflow state fields or transition phase. Auto-emits workflow.transition events when phase is provided — do not duplicate via event append',
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
      fields: z.array(z.string()).optional(),
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
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
  },
  {
    name: 'prepare_synthesis',
    description: 'Run pre-synthesis checks: tests, typecheck, stack health. Emits events for readiness views and eval flywheel.',
    schema: z.object({
      featureId: z.string().min(1),
    }),
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
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
  },
  {
    name: 'check_security_scan',
    description: 'Run security pattern scan on diff. Emits gate.executed event with dimension D1.',
    schema: z.object({
      featureId: z.string().min(1),
      repoRoot: z.string().optional(),
      baseBranch: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
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
  },
  {
    name: 'check_design_completeness',
    description: 'Verify design document completeness at ideate→plan boundary. Wraps verify-ideate-artifacts.sh. Advisory gate — failures inform but do not block.',
    schema: z.object({
      featureId: z.string().min(1),
      stateFile: z.string().optional(),
      designPath: z.string().optional(),
    }),
    phases: new Set<string>(['ideate', 'plan']),
    roles: ROLE_LEAD,
  },
  {
    name: 'check_plan_coverage',
    description: 'Verify plan tasks cover all design sections. Wraps verify-plan-coverage.sh. Emits gate.executed event with dimension D1.',
    schema: z.object({
      featureId: z.string().min(1),
      designPath: z.string().min(1),
      planPath: z.string().min(1),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
  },
  {
    name: 'check_tdd_compliance',
    description: 'Per-task TDD compliance gate. Wraps check-tdd-compliance.sh. Emits gate.executed event with dimension D1.',
    schema: z.object({
      featureId: z.string().min(1),
      taskId: z.string().min(1),
      branch: z.string().min(1),
      baseBranch: z.string().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
  },
  {
    name: 'check_post_merge',
    description: 'Post-merge regression check. Wraps check-post-merge.sh. Emits gate.executed event with dimension D4.',
    schema: z.object({
      featureId: z.string().min(1),
      prUrl: z.string().min(1),
      mergeSha: z.string().min(1),
    }),
    phases: new Set<string>(['synthesize']),
    roles: ROLE_LEAD,
  },
  {
    name: 'check_task_decomposition',
    description: 'Task decomposition quality check at plan boundary. Wraps check-task-decomposition.sh. Emits gate.executed event with dimension D5.',
    schema: z.object({
      featureId: z.string().min(1),
      planPath: z.string().min(1),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
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
  },
  {
    name: 'run_script',
    description: 'Run a plugin script by name with optional arguments. Scripts resolve from EXARCHOS_PLUGIN_ROOT/scripts/ with fallback to ~/.claude/scripts/.',
    schema: z.object({
      script: z.string().min(1),
      args: z.array(z.string()).optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
  },
];

// ─── Composite Tool: exarchos_view ──────────────────────────────────────────

const viewActions: readonly ToolAction[] = [
  {
    name: 'pipeline',
    description: 'Aggregated view of all workflows with stack positions',
    schema: z.object({
      limit: coercedPositiveInt().optional(),
      offset: coercedNonnegativeInt().optional(),
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
      fields: z.array(z.string()).optional(),
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
  },
  {
    name: 'exarchos_event',
    description: 'Event sourcing — append and query events in streams',
    actions: eventActions,
    cli: { alias: 'ev' },
  },
  {
    name: 'exarchos_orchestrate',
    description: 'Task coordination — claim, complete, and fail tasks',
    actions: orchestrateActions,
    cli: { alias: 'orch' },
  },
  {
    name: 'exarchos_view',
    description: 'CQRS materialized views — pipeline, tasks, workflow status, stack, and telemetry',
    actions: viewActions,
    cli: { alias: 'vw' },
  },
  {
    name: 'exarchos_sync',
    description: 'Remote synchronization — trigger immediate sync',
    actions: syncActions,
    cli: { alias: 'sy' },
  },
];
