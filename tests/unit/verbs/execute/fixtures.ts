// Fixture leaves and fixture intents for the bounded action executor.
//
// The executor takes its runbook table, its registry lookup, its argument
// schemas and its handler table as injected dependencies. That seam exists so
// these fixtures can exercise the core semantics — closure, admission order,
// per-leaf emission checking, commit and replay — without adding a test-only
// entry to the live registry and without shelling out to a real gate.
//
// The contracts below are built with the REAL `withActionContract`, so a
// fixture leaf is normalized and validated exactly as a shipped action is.

import { z } from 'zod';

import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, type DispatchContext as CorrelationContext } from '../../../../src/dispatch/dispatch-context.js';
import type { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import {
  declared,
  none,
  withActionContract,
  type ActionContract,
  type ToolAction,
} from '../../../../src/registry.js';
import type { RunbookDefinition, RunbookStep } from '../../../../src/runbooks/types.js';
import type { LeafHandler } from '../../../../src/verbs/execute/executor.js';
import type { IntentReceipt } from '../../../../src/verbs/execute/types.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';

export const FIXTURE_TOOL = 'exarchos_orchestrate';

/** The schema every fixture leaf declares: a stream, a task, and nothing else. */
export const fixtureLeafSchema = z
  .object({
    featureId: z.string().min(1),
    taskId: z.string().min(1),
    worktreePath: z.string().optional(),
    riskTier: z.enum(['low', 'medium', 'high']).optional(),
    boundaryTouching: z.boolean().optional(),
  })
  .strict();

export interface FixtureActionInput {
  readonly name: string;
  readonly schema?: z.ZodObject<z.ZodRawShape>;
  readonly emissions?: ActionContract['emissions'];
  readonly ensures?: ActionContract['ensures'];
  readonly executionAuthority?: ActionContract['executionAuthority'];
}

export function fixtureAction(input: FixtureActionInput): ToolAction {
  return withActionContract(
    {
      name: input.name,
      description: `fixture leaf ${input.name}`,
      schema: input.schema ?? fixtureLeafSchema,
      phases: new Set<string>(['delegate']),
      roles: new Set<string>(['lead']),
    },
    {
      requires: none('fixture leaf consumes no prior resolved gate or approval floor'),
      ensures: input.ensures ?? none('fixture leaf promises no observable postcondition'),
      needs: declared('mcp:exarchos'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'featureId' }),
      },
      executionAuthority: input.executionAuthority ?? { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: input.emissions ?? none('fixture leaf appends no catalog events'),
    },
  );
}

export function fixtureRunbook(id: string, steps: readonly RunbookStep[]): RunbookDefinition {
  return {
    id,
    phase: 'delegate',
    description: `fixture intent ${id}`,
    steps,
    templateVars: ['taskId', 'featureId'],
    autoEmits: [],
  };
}

export function fixtureStep(
  action: string,
  onFail: RunbookStep['onFail'],
  params?: Readonly<Record<string, unknown>>,
): RunbookStep {
  return {
    tool: FIXTURE_TOOL,
    action,
    onFail,
    ...(params !== undefined ? { params } : {}),
  };
}

/** The argument schema a fixture intent is compiled against. */
export const fixtureIntentArgs = z
  .object({
    taskId: z.string().min(1),
    worktreePath: z.string().min(1).optional(),
    riskTier: z.enum(['low', 'medium', 'high']).optional(),
    boundaryTouching: z.boolean().optional(),
  })
  .strict();

function subjectOf(args: Record<string, unknown>): string {
  const featureId = args.featureId;
  const streamId = args.streamId;
  if (typeof featureId === 'string' && featureId.length > 0) return featureId;
  if (typeof streamId === 'string' && streamId.length > 0) return streamId;
  throw new Error('fixture handler was called without a subject stream');
}

/** A leaf that appends one event to the subject stream and reports success. */
export function appendingHandler(type: string): LeafHandler {
  return async (args, _stateDir, ctx) => {
    if (ctx === undefined) throw new Error('fixture handler requires a dispatch context');
    await ctx.eventStore.append(subjectOf(args), {
      type,
      data: { taskId: String(args.taskId ?? 'fixture') },
    });
    return { success: true, data: { appended: type } };
  };
}

/** A leaf that reports success and appends nothing. */
export function silentHandler(): LeafHandler {
  return async () => ({ success: true, data: { appended: null } });
}

/** A leaf that refuses. */
export function failingHandler(message: string): LeafHandler {
  return async () => ({
    success: false,
    error: { code: 'FIXTURE_LEAF_REFUSED', message },
  });
}

/** A leaf that crashes mid-segment. */
export function throwingHandler(message: string): LeafHandler {
  return async () => {
    throw new Error(message);
  };
}

/** A handler that records every invocation so a replay can be shown to run nothing. */
export function countingHandler(inner: LeafHandler): { handler: LeafHandler; calls: () => number } {
  let calls = 0;
  const handler: LeafHandler = async (args, stateDir, ctx) => {
    calls += 1;
    return inner(args, stateDir, ctx);
  };
  return { handler, calls: () => calls };
}

export function findFixtureAction(
  actions: readonly ToolAction[],
): (tool: string, action: string) => ToolAction | undefined {
  return (tool, action) =>
    tool === FIXTURE_TOOL ? actions.find((candidate) => candidate.name === action) : undefined;
}

const FIXTURE_CAPABILITIES = [
  'fs:read',
  'fs:write',
  'shell:exec',
  'isolation:worktree',
  'mcp:exarchos',
];

export function fixtureCorrelation(): CorrelationContext {
  const identity = deriveMcpCallerIdentity({ sessionId: 'execute-intent-fixture' });
  return mintDispatchContext(
    undefined,
    snapshotCallerAuthorization(identity, createInMemoryResolver(FIXTURE_CAPABILITIES)),
  );
}

export function fixtureWiring(stateDir: string, eventStore: EventStore): DispatchContext {
  return {
    stateDir,
    eventStore,
    enableTelemetry: false,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'execute-intent-fixture' }),
    capabilityResolver: createInMemoryResolver(FIXTURE_CAPABILITIES),
  };
}

function isReceipt(value: unknown): value is IntentReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<IntentReceipt>;
  return (
    typeof candidate.operationId === 'string' &&
    typeof candidate.intent === 'string' &&
    Array.isArray(candidate.leaves)
  );
}

/** Narrow a handler result to the executor's receipt, or fail loudly. */
export function receiptOf(result: ToolResult): IntentReceipt {
  if (!isReceipt(result.data)) {
    throw new Error(`expected a receipt on data, got ${JSON.stringify(result)}`);
  }
  return result.data;
}
