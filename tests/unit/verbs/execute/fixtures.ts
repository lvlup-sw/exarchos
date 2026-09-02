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

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { EnvelopeSchema } from '../../../../src/contract/schemas/envelope.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import {
  getDispatchContext,
  mintDispatchContext,
  type DispatchContext as CorrelationContext,
} from '../../../../src/dispatch/dispatch-context.js';
import { AdmissionEvidenceRecordedData } from '../../../../src/events/schemas.js';
import type { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { withCappedShape } from '../../../../src/output-schema-declaration.js';
import { LOCAL_MUTATION } from '../../../../src/registry/annotations.js';
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
import { ADMISSION_RUNTIME_CONTRACT_VERSION } from '../../../../src/workflow/admission/types.js';
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
  readonly requires?: ActionContract['requires'];
  /**
   * Overridable because the registry's own admission rules read it: a
   * `safe-repeat` declaration is only accepted from an action annotated
   * idempotent, so a fixture registered through `registerCustomTool` rather
   * than constructed in place has to declare the replay policy its mutating
   * annotation supports.
   */
  readonly replay?: ActionContract['replay'];
}

/**
 * A fixture leaf's output declaration. Not exercised by anything here — the
 * fixtures never reach the response-economy path — but `ToolAction` requires
 * an output schema and an annotation set, and a fixture that satisfies the
 * real type is a fixture the real lookups accept.
 */
const fixtureOutputSchema = withCappedShape(
  EnvelopeSchema(z.object({ appended: z.string().nullable().optional() })),
);

export function fixtureAction(input: FixtureActionInput): ToolAction {
  return withActionContract(
    {
      name: input.name,
      description: `fixture leaf ${input.name}`,
      schema: input.schema ?? fixtureLeafSchema,
      phases: new Set<string>(['delegate']),
      roles: new Set<string>(['lead']),
      outputSchema: fixtureOutputSchema,
      annotations: LOCAL_MUTATION,
    },
    {
      requires:
        input.requires ?? none('fixture leaf consumes no prior resolved gate or approval floor'),
      ensures: input.ensures ?? none('fixture leaf promises no observable postcondition'),
      needs: declared('mcp:exarchos'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'stream', selector: 'featureId' }),
      },
      executionAuthority: input.executionAuthority ?? { kind: 'local' },
      replay: input.replay ?? { kind: 'safe-repeat' },
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

/**
 * The idempotency key the real durable gate runner would derive for a leaf's
 * append: a hash over the AMBIENT operation id plus a producer label. Mirrored
 * here rather than approximated, because the property under test is that the
 * executor's derived per-leaf operation id is STABLE across a crash-retry —
 * and stability only pays for anything if the key downstream is built from it.
 */
export function derivedEvidenceKey(operationId: string, producerRef: string): string {
  const digest = createHash('sha256')
    .update([operationId, producerRef].join('\0'), 'utf8')
    .digest('hex');
  return `evidence:${digest}`;
}

function ambientOperationId(): string {
  const ctx = getDispatchContext();
  if (ctx === undefined) throw new Error('fixture handler ran outside a dispatch context');
  return ctx.operationId;
}

/**
 * A leaf that appends one event keyed the way the gate runner keys its own —
 * by an id derived from the ambient operation id. A re-run under the same
 * derived id collapses onto the first write instead of adding a row.
 */
export function keyedAppendingHandler(type: string, producerRef: string): LeafHandler {
  return async (args, _stateDir, ctx) => {
    if (ctx === undefined) throw new Error('fixture handler requires a dispatch context');
    await ctx.eventStore.append(
      subjectOf(args),
      { type, data: { taskId: String(args.taskId ?? 'fixture') } },
      { idempotencyKey: derivedEvidenceKey(ambientOperationId(), producerRef) },
    );
    return { success: true, data: { appended: type } };
  };
}

/**
 * A leaf that records passing gate evidence for `requirementId` — the fact a
 * LATER leaf's declared `requires` reads out of the store. Built with the real
 * evidence schema and keyed like the gate runner's, so the admission evaluator
 * accepts or rejects it for the same reasons it would a shipped gate's.
 */
export function gateEvidenceHandler(input: {
  readonly requirementId: string;
  readonly phaseAttemptId: string;
  readonly producerRef: string;
  readonly verdict?: 'pass' | 'fail';
}): LeafHandler {
  return async (args, _stateDir, ctx) => {
    if (ctx === undefined) throw new Error('fixture handler requires a dispatch context');
    const streamId = subjectOf(args);
    const evidenceId = derivedEvidenceKey(ambientOperationId(), input.producerRef);
    const createdAt = new Date().toISOString();
    const record = AdmissionEvidenceRecordedData.parse({
      eventVersion: '1.0',
      evidence: {
        contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
        kind: 'gate',
        evidenceId,
        requirementId: input.requirementId,
        phaseAttemptId: input.phaseAttemptId,
        subject: {
          kind: 'phase-attempt',
          phaseAttemptId: input.phaseAttemptId,
          digest: { algorithm: 'sha256', value: 'a'.repeat(64) },
        },
        producer: {
          producerId: 'fixture-producer',
          providerRef: input.producerRef,
          providerVersion: '1.0.0',
          invocationId: ambientOperationId(),
        },
        policyId: 'fixture-policy',
        policyDigest: { algorithm: 'sha256', value: 'b'.repeat(64) },
        contentDigest: { algorithm: 'sha256', value: 'c'.repeat(64) },
        createdAt,
        verdict: input.verdict ?? 'pass',
      },
    });
    await ctx.eventStore.append(
      streamId,
      { type: 'admission.evidence-recorded', timestamp: createdAt, data: record },
      { idempotencyKey: evidenceId },
    );
    return { success: true, data: { recorded: evidenceId } };
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

// The gate-evidence policy capability is here because a fixture whose leaf
// declares a real `requires` needs its evidence to be ACCEPTED — evidence the
// caller was not authorized to issue denies admission for an authorization
// reason, which would prove nothing about execution order.
const FIXTURE_CAPABILITIES = [
  'fs:read',
  'fs:write',
  'shell:exec',
  'isolation:worktree',
  'mcp:exarchos',
  'admission:issue-gate-evidence',
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
