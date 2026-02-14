import { z } from 'zod';

// ─── Tool Registry Types ────────────────────────────────────────────────────

export interface ToolAction {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly phases: ReadonlySet<string>;
  readonly roles: ReadonlySet<string>;
}

export interface CompositeTool {
  readonly name: string;
  readonly description: string;
  readonly actions: readonly ToolAction[];
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

// ─── Shared Constants ───────────────────────────────────────────────────────

const ALL_PHASES: ReadonlySet<string> = new Set([
  'ideate',
  'plan',
  'plan-review',
  'delegate',
  'review',
  'synthesize',
]);

const ROLE_ANY: ReadonlySet<string> = new Set(['any']);
const ROLE_LEAD: ReadonlySet<string> = new Set(['lead']);
const ROLE_TEAMMATE: ReadonlySet<string> = new Set(['teammate']);

const DELEGATE_PHASES: ReadonlySet<string> = new Set(['delegate']);
const STACK_PHASES: ReadonlySet<string> = new Set(['synthesize', 'delegate']);

// ─── Shared Schema Fragments ────────────────────────────────────────────────

const featureIdSchema = z.string().min(1).regex(/^[a-z0-9-]+$/);

// ─── Composite Tool: exarchos_workflow ───────────────────────────────────────

const workflowActions: readonly ToolAction[] = [
  {
    name: 'init',
    description: 'Initialize a new workflow',
    schema: z.object({
      featureId: featureIdSchema,
      workflowType: z.enum(['feature', 'debug', 'refactor']),
    }),
    phases: new Set(['ideate']),
    roles: ROLE_LEAD,
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
  },
  {
    name: 'set',
    description: 'Update workflow state fields or transition phase',
    schema: z.object({
      featureId: featureIdSchema,
      updates: z.record(z.string(), z.unknown()).optional(),
      phase: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
  },
  {
    name: 'cancel',
    description: 'Cancel a workflow with saga compensation',
    schema: z.object({
      featureId: featureIdSchema,
      dryRun: z.boolean().optional(),
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
      event: z.record(z.string(), z.unknown()),
      expectedSequence: z.number().int().optional(),
      idempotencyKey: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
  },
  {
    name: 'query',
    description: 'Query events from a stream with optional filtering',
    schema: z.object({
      stream: z.string().min(1),
      filter: z.record(z.string(), z.unknown()).optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
      fields: z.array(z.string()).optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
  },
];

// ─── Composite Tool: exarchos_orchestrate ───────────────────────────────────

const orchestrateActions: readonly ToolAction[] = [
  {
    name: 'team_spawn',
    description: 'Register a new agent teammate with role assignment',
    schema: z.object({
      name: z.string().min(1),
      role: z.string().min(1),
      taskId: z.string().min(1),
      taskTitle: z.string().min(1),
      streamId: z.string().min(1),
      worktreePath: z.string().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
  },
  {
    name: 'team_message',
    description: 'Send a direct message to a specific teammate',
    schema: z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      content: z.string().min(1),
      streamId: z.string().min(1),
      messageType: z.string().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
  },
  {
    name: 'team_broadcast',
    description: 'Broadcast a message to all active teammates',
    schema: z.object({
      from: z.string().min(1),
      content: z.string().min(1),
      streamId: z.string().min(1),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
  },
  {
    name: 'team_shutdown',
    description: 'Shut down a teammate agent',
    schema: z.object({
      name: z.string().min(1),
      streamId: z.string().min(1),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
  },
  {
    name: 'team_status',
    description: 'Get health status of all teammates',
    schema: z.object({
      summary: z.boolean().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
  },
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
    description: 'Mark a task as complete with optional result',
    schema: z.object({
      taskId: z.string().min(1),
      result: z.record(z.string(), z.unknown()).optional(),
      streamId: z.string().min(1),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_TEAMMATE,
  },
  {
    name: 'task_fail',
    description: 'Mark a task as failed with error details',
    schema: z.object({
      taskId: z.string().min(1),
      error: z.string().min(1),
      diagnostics: z.record(z.string(), z.unknown()).optional(),
      streamId: z.string().min(1),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_TEAMMATE,
  },
];

// ─── Composite Tool: exarchos_view ──────────────────────────────────────────

const viewActions: readonly ToolAction[] = [
  {
    name: 'pipeline',
    description: 'Aggregated view of all workflows with stack positions',
    schema: z.object({
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
  },
  {
    name: 'tasks',
    description: 'Task detail view with filtering and projection',
    schema: z.object({
      workflowId: z.string().optional(),
      filter: z.record(z.string(), z.unknown()).optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
      fields: z.array(z.string()).optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
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
    name: 'team_status',
    description: 'Teammate composition and task assignments',
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
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    phases: STACK_PHASES,
    roles: ROLE_ANY,
  },
  {
    name: 'stack_place',
    description: 'Record a stack position for a task',
    schema: z.object({
      streamId: z.string().min(1),
      position: z.number().int().nonnegative(),
      taskId: z.string().min(1),
      branch: z.string().optional(),
      prUrl: z.string().optional(),
    }),
    phases: STACK_PHASES,
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
    description: 'Workflow lifecycle management — init, read, update, and cancel workflows',
    actions: workflowActions,
  },
  {
    name: 'exarchos_event',
    description: 'Event sourcing — append and query events in streams',
    actions: eventActions,
  },
  {
    name: 'exarchos_orchestrate',
    description: 'Agent team coordination — spawn, message, and manage teammates and tasks',
    actions: orchestrateActions,
  },
  {
    name: 'exarchos_view',
    description: 'CQRS materialized views — pipeline, tasks, workflow status, team status, and stack',
    actions: viewActions,
  },
  {
    name: 'exarchos_sync',
    description: 'Remote synchronization — trigger immediate sync',
    actions: syncActions,
  },
];
