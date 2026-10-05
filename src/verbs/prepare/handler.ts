/**
 * `prepare` compiles the outstanding work of a workflow into a capsule.
 *
 * It is the first of the two semantic plane calls. It compiles the batch that
 * waits for delegation into an immutable capsule. Then it puts the capsule in
 * custody and records `workflow.prepared` with the capsule digest. The harness
 * runs the batch with no governance calls, and `settle` judges the results
 * against this capsule.
 *
 * Every refusal occurs before any effect. The workflow must name the branch that its tasks fork from.
 * The claim key is the digest of the compilation inputs, the base included, so a retry returns the
 * recorded capsule. Changed inputs get the next capsule version.
 */

import { contentDigest } from '../../contract/capsule/capsule-digest.js';
import { CapsuleBaseRefSchema } from '../../contract/capsule/exarchos-capsule.js';
import { requestDigest as canonicalRequestDigest } from '../../contract/request-context.js';
import { loadExarchosConfig } from '../../config/load-exarchos-config.js';
import { resolveEffectiveCatalog } from '../../architecture/resolve-effective-catalog.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { runExclusivePerOperation } from '../../dispatch/core/operation-serializer.js';
import { resolveSubjectStream } from '../../dispatch/core/subject-stream.js';
import { getDispatchContext } from '../../dispatch/dispatch-context.js';
import { OperationDigestMismatchError } from '../../events/atomic-appender.js';
import type { RunBundleStore } from '../../events/bundle/run-bundle-store.js';
import { ConcurrencyError } from '../../events/concurrency-error.js';
import type { ToolResult } from '../../format.js';
import { findActionInRegistry } from '../../registry.js';
import { ALL_RUNBOOKS } from '../../runbooks/definitions.js';
import { capabilityNeedSatisfied } from '../../workflow/capabilities/resolver.js';
import { resolveVerificationPolicy } from '../../workflow/verification-policy-resolver.js';
import { resolveWorkflowState } from '../resolve-state.js';
import type { CatalogInvariant } from './bind-authority.js';
import { compileDelegationCapsule, verificationProfiles, type CompileCapsuleInput } from './compile-capsule.js';
import { lowerBuiltInDefinition } from './lower-definition.js';
import { DELEGATION_STEP_ID, partitionDelegationBatch } from './partition-tasks.js';
import { commitPreparedCapsule } from './prepared-record.js';
import type { PreparedCapsuleReceipt, PrepareRefusal } from './types.js';

/** The workflow type whose delegation batch this compiler knows how to compile. */
const PREPARABLE_WORKFLOW_TYPE = 'feature';

/** The runbook that settlement composes for each accepted task. Its leaf needs are the batch needs. */
const SETTLEMENT_SEGMENT_INTENT = 'task-completion';

/**
 * The capabilities a runtime must hold to run a batch through the plane.
 * They are the needs that `settle` declares, plus the needs of each registry
 * step in the settlement segment. The registry is the source, so the profile
 * cannot drift. A runtime without them is refused before it fans out.
 */
export function planeExecutionCapabilities(): readonly string[] {
  const needs = new Set<string>();
  const collect = (tool: string, action: string): void => {
    const declared = findActionInRegistry(tool, action)?.actionContract?.needs;
    if (declared?.kind !== 'declared') return;
    for (const capability of declared.values) needs.add(capability);
  };
  collect('exarchos_orchestrate', 'settle');
  const segment = ALL_RUNBOOKS.find((runbook) => runbook.id === SETTLEMENT_SEGMENT_INTENT);
  for (const step of segment?.steps ?? []) {
    if (step.tool === 'none' || step.tool.startsWith('native:')) continue;
    collect(step.tool, step.action);
  }
  return [...needs].sort();
}

/**
 * The capabilities of the calling runtime, from the trusted caller snapshot of
 * the dispatch. Admission reads the same grant. Without a snapshot, the set is empty.
 */
function heldCapabilities(): ReadonlySet<string> {
  return new Set(getDispatchContext()?.authorization?.capabilities ?? []);
}

/** Injected so the tests drive a real store at a temporary root, with a fixed catalog and clock. */
export interface PrepareDeps {
  readonly bundleStore?: RunBundleStore;
  readonly catalogInvariants?: (
    workflowType: string,
    phase: string,
    repoRoot: string,
  ) => readonly CatalogInvariant[];
  readonly now?: () => string;
}

function invalid(message: string): ToolResult {
  return { success: false, error: { code: 'INVALID_INPUT', message } };
}

function refused(refusal: PrepareRefusal): ToolResult {
  return { success: false, error: { code: refusal.code, message: refusal.message } };
}

function receiptResult(receipt: PreparedCapsuleReceipt): ToolResult {
  return { success: true, data: receipt };
}

/** The tasks the stream has already announced, read from the rows themselves. */
function announcedTaskIds(events: readonly { readonly type: string; readonly data?: unknown }[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== 'task.assigned' || !isRecord(event.data)) continue;
    const taskId = event.data.taskId;
    if (typeof taskId === 'string') ids.add(taskId);
  }
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How a caller records the integration branch, quoted in the refusal that asks for it. */
const SET_INTEGRATION_BRANCH =
  'exarchos_workflow({ action: "update", featureId: "<featureId>", ' +
  'updates: { "synthesis.integrationBranch": "<the branch the tasks fork from>" } })';

/**
 * The branch that each task of the batch forks from: the recorded integration branch of the workflow.
 * A missing branch is refused, not guessed. A guessed base measures the task diff against the wrong
 * commit, and the kill probe then judges work that the task did not do.
 */
function resolveBaseRef(
  streamId: string,
  state: Record<string, unknown>,
): { readonly ok: true; readonly baseRef: string } | { readonly ok: false; readonly refusal: PrepareRefusal } {
  const branch = isRecord(state.synthesis) ? state.synthesis.integrationBranch : undefined;
  if (typeof branch !== 'string' || branch.trim().length === 0) {
    return {
      ok: false,
      refusal: {
        code: 'BASE_UNRESOLVED',
        message:
          `'${streamId}' records no integration branch, so no task in the batch has a base to measure ` +
          `its diff against. Record the branch the tasks fork from, then prepare again: ${SET_INTEGRATION_BRANCH}`,
      },
    };
  }
  if (!CapsuleBaseRefSchema.safeParse(branch).success) {
    return {
      ok: false,
      refusal: {
        code: 'BASE_UNRESOLVED',
        message:
          `'${streamId}' records the integration branch ${JSON.stringify(branch)}, which is not a safe ref ` +
          'name (it must start with a letter, digit or underscore and hold no whitespace or ".."). Record ' +
          `the branch the tasks fork from, then prepare again: ${SET_INTEGRATION_BRANCH}`,
      },
    };
  }
  return { ok: true, baseRef: branch };
}

/**
 * The resolved invariants of the repository, by id and summary.
 *
 * A configuration that fails to load counts as no configuration, and the
 * compilation continues. The built-in authority is already a settleable floor.
 * The invariant gate treats an unreadable `.exarchos.yml` the same way.
 */
function resolvedCatalogInvariants(
  workflowType: string,
  phase: string,
  repoRoot: string,
): readonly CatalogInvariant[] {
  let config;
  try {
    config = loadExarchosConfig(repoRoot)?.config;
  } catch {
    config = undefined;
  }
  const { entries } = resolveEffectiveCatalog({ repoRoot, config, phase, workflowType });
  return entries.map((entry) => ({ id: entry.id, summary: entry.summary }));
}

/**
 * Compiles the delegation batch of a workflow into a capsule and records it.
 *
 * The handler reads the stream before it folds the state. The stream tail is
 * the expected sequence of the commit, so the store refuses the commit after a
 * concurrent append. The commit announces only the batch tasks that the stream
 * has not seen, because a second `task.assigned` moves a task back to `assigned`.
 * The runtime check occurs before compilation. The verification sequence is a
 * compilation input, so a policy change compiles the next version.
 */
export async function handlePrepare(
  raw: Record<string, unknown>,
  _stateDir: string,
  ctx: DispatchContext,
  deps: PrepareDeps = {},
): Promise<ToolResult> {
  const subject = resolveSubjectStream(raw);
  if (!subject.ok) return invalid(subject.message);
  const { streamId } = subject;

  const events = await ctx.eventStore.query(streamId);
  if (events.length === 0) {
    return refused({ code: 'WORKFLOW_NOT_FOUND', message: `no workflow is recorded for '${streamId}'` });
  }
  const tail = events[events.length - 1]?.sequence ?? 0;
  const capsuleVersion = events.filter((event) => event.type === 'workflow.prepared').length + 1;

  const resolved = await resolveWorkflowState({ featureId: streamId, eventStore: ctx.eventStore });
  if ('error' in resolved) return resolved.error;
  const { state } = resolved;

  const workflowType = typeof state.workflowType === 'string' ? state.workflowType : undefined;
  const lowered = workflowType === PREPARABLE_WORKFLOW_TYPE ? lowerBuiltInDefinition(workflowType) : undefined;
  if (workflowType === undefined || lowered === undefined) {
    return refused({
      code: 'WORKFLOW_TYPE_UNSUPPORTED',
      message:
        `prepare compiles the delegation batch of a ${PREPARABLE_WORKFLOW_TYPE} workflow, and ` +
        `'${streamId}' is ${workflowType === undefined ? 'untyped' : `a ${workflowType} workflow`}`,
    });
  }

  const phase = typeof state.phase === 'string' ? state.phase : undefined;
  if (phase !== DELEGATION_STEP_ID) {
    return refused({
      code: 'PHASE_NOT_PREPARABLE',
      message:
        `'${streamId}' is in phase '${phase ?? 'unknown'}'; its work is batched for delegation ` +
        `only in '${DELEGATION_STEP_ID}'`,
    });
  }

  const partition = partitionDelegationBatch(Array.isArray(state.tasks) ? state.tasks : []);
  if (!partition.ok) return refused(partition.refusal);
  const { batch } = partition;

  const base = resolveBaseRef(streamId, state);
  if (!base.ok) return refused(base.refusal);
  const { baseRef } = base;

  const heard = announcedTaskIds(events);
  const announce = batch.tasks
    .filter((task) => !heard.has(task.taskId))
    .map((task) => ({ taskId: task.taskId, title: task.title }));

  const capabilities = planeExecutionCapabilities();
  const held = heldCapabilities();
  const missing = capabilities.filter((capability) => !capabilityNeedSatisfied(held, capability));
  if (missing.length > 0) {
    return refused({
      code: 'RUNTIME_UNFIT',
      message:
        `the calling runtime lacks ${missing.map((c) => JSON.stringify(c)).join(', ')}, which the batch's ` +
        `execution profile requires (${capabilities.join(', ')}): settlement runs each task's ` +
        'verification through the same runtime, so the batch is refused before it is dispatched.',
    });
  }

  const artifacts = isRecord(state.artifacts) ? state.artifacts : {};
  const designRef =
    typeof artifacts.design === 'string' && artifacts.design.length > 0 ? artifacts.design : undefined;
  const catalogInvariants = (deps.catalogInvariants ?? resolvedCatalogInvariants)(
    workflowType,
    phase,
    ctx.cwd ?? process.cwd(),
  );

  const sequenceOf: CompileCapsuleInput['verificationSequence'] = (riskTier, boundaryTouching) =>
    resolveVerificationPolicy(riskTier, boundaryTouching, ctx.projectConfig).sequence;
  const verificationTerms = verificationProfiles(batch).map((profile) => ({
    riskTier: profile.riskTier,
    boundaryTouching: profile.boundaryTouching,
    sequence: [...sequenceOf(profile.riskTier, profile.boundaryTouching)],
  }));

  const inputs = {
    streamId,
    workflowType,
    definitionVersion: lowered.definitionVersion,
    batch,
    catalogInvariants,
    designRef: designRef ?? null,
    executionProfile: { capabilities },
    verificationTerms,
    baseRef,
  };
  const operationId = `prepare:${contentDigest(inputs)}`;
  const requestDigest = canonicalRequestDigest(inputs);

  return runExclusivePerOperation(operationId, async (): Promise<ToolResult> => {
    const claim = ctx.eventStore
      .getAppender()
      .ensureSqliteBackendSync()
      .lookupOperationClaim<PreparedCapsuleReceipt>(operationId);
    if (claim !== undefined) return receiptResult(claim.result);

    const compiled = compileDelegationCapsule({
      workflowId: streamId,
      capsuleVersion,
      lowered,
      batch,
      catalogInvariants,
      designRef,
      baseRef,
      executionProfile: { capabilities },
      verificationSequence: sequenceOf,
      compiledAt: (deps.now ?? (() => new Date().toISOString()))(),
    });
    if (!compiled.ok) return refused(compiled.refusal);

    try {
      const receipt = await commitPreparedCapsule(
        ctx,
        {
          streamId,
          operationId,
          requestDigest,
          workflowType,
          capsule: compiled.capsule,
          definition: lowered.definition,
          expectedSequence: tail,
          announce,
        },
        deps.bundleStore,
      );
      return receiptResult(receipt);
    } catch (error) {
      if (error instanceof ConcurrencyError) {
        return {
          success: false,
          error: {
            code: 'CONCURRENCY_CONFLICT',
            message:
              `'${streamId}' changed while capsule v${capsuleVersion} was being compiled, so the ` +
              'compilation was not recorded. Prepare again to compile from the current state.',
          },
        };
      }
      if (error instanceof OperationDigestMismatchError) {
        return {
          success: false,
          error: {
            code: 'OPERATION_DIGEST_MISMATCH',
            message:
              `a concurrent preparation recorded operation '${operationId}' under a different ` +
              'request while this one was compiling. Nothing was recorded by this call.',
          },
        };
      }
      throw error;
    }
  });
}
