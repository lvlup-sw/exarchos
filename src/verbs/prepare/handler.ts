// ─── `prepare` — compiling a workflow's outstanding work into a capsule ─────
//
// The first of the semantic plane's two calls. It reads the workflow, compiles
// the batch of work still to be delegated into an immutable capsule, puts the
// capsule in custody, and records `workflow.prepared` pinning its digest. The
// harness then runs the batch with no governance calls, and `settle` judges
// what comes back against exactly this capsule.
//
// Every refusal happens before any effect, and the order of the questions is
// the order a caller has to fix them in: is there a workflow, is it one this
// compiler can lower, is it at the point where its work can be batched, and is
// the plan itself sound. Only a compilation that passes all of them reaches
// custody.
//
// A PREPARATION IS KEYED BY ITS INPUTS. The claim key is the digest of what
// the capsule was compiled from — the definition, the batch, the bound
// invariants, the design reference — so a retry after a timeout returns the
// capsule already recorded instead of compiling a second version of the same
// terms. Changed inputs are a different preparation, and get the next version.

import { contentDigest } from '../../contract/capsule/capsule-digest.js';
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

/** The runbook settlement composes per accepted task; its leaves' needs are the batch's. */
const SETTLEMENT_SEGMENT_INTENT = 'task-completion';

/**
 * The capabilities a runtime must hold to run a batch through the plane: what
 * `settle` itself declares it needs, and what every leaf of the segment it
 * composes declares. Read off the registry so the profile cannot drift from
 * the contracts it stands for; a runtime refused here is refused before it
 * fans out, rather than at settlement after the work is done.
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
 * The capabilities the calling runtime is known to hold: the trusted caller
 * snapshot the dispatch minted, the same grant admission reads. No snapshot
 * is no grant — a caller nothing vouched for holds nothing here.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The repository's resolved invariants, by id and summary.
 *
 * A configuration that fails to load degrades to no configuration rather than
 * refusing the compilation: the built-in authority is already a settleable
 * floor, and the invariant gate treats an unreadable `.exarchos.yml` the same
 * way.
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

export async function handlePrepare(
  raw: Record<string, unknown>,
  _stateDir: string,
  ctx: DispatchContext,
  deps: PrepareDeps = {},
): Promise<ToolResult> {
  const subject = resolveSubjectStream(raw);
  if (!subject.ok) return invalid(subject.message);
  const { streamId } = subject;

  // The stream is read BEFORE the state is folded, and its tail becomes the
  // commit's expected sequence. Anything appended in between — including a
  // concurrent preparation claiming the same version — moves the tail, and the
  // commit is refused rather than recording a capsule compiled from a state
  // that was already stale.
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

  // The runtime is measured against the profile BEFORE anything is compiled
  // or recorded: a harness that cannot settle what it is about to dispatch
  // should learn so before it dispatches.
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
  // Resolved from the workspace the call was dispatched for, which is not
  // necessarily the directory the serving process started in.
  const catalogInvariants = (deps.catalogInvariants ?? resolvedCatalogInvariants)(
    workflowType,
    phase,
    ctx.cwd ?? process.cwd(),
  );

  // Through the policy's one composer, with the dispatched project's
  // overrides applied: the sequence the capsule states is the sequence the
  // gates' own self-skip routing will honour at settlement. Resolved ahead
  // of the digest, because the terms are inputs to the compilation: a
  // policy that changes under an unchanged plan compiles the next version
  // rather than replaying a capsule that states the old sequence.
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
  };
  const operationId = `prepare:${contentDigest(inputs)}`;
  const requestDigest = canonicalRequestDigest(inputs);

  return runExclusivePerOperation(operationId, async (): Promise<ToolResult> => {
    // Replay pre-flight. The key IS the digest of the inputs, so a claim under
    // it records a compilation of exactly these terms.
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
