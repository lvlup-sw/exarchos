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
import { OperationDigestMismatchError } from '../../events/atomic-appender.js';
import type { RunBundleStore } from '../../events/bundle/run-bundle-store.js';
import { ConcurrencyError } from '../../events/concurrency-error.js';
import type { ToolResult } from '../../format.js';
import { resolveWorkflowState } from '../resolve-state.js';
import type { CatalogInvariant } from './bind-authority.js';
import { compileDelegationCapsule } from './compile-capsule.js';
import { lowerBuiltInDefinition } from './lower-definition.js';
import { DELEGATION_STEP_ID, partitionDelegationBatch } from './partition-tasks.js';
import { commitPreparedCapsule } from './prepared-record.js';
import type { PreparedCapsuleReceipt, PrepareRefusal } from './types.js';

/** The workflow type whose delegation batch this compiler knows how to compile. */
const PREPARABLE_WORKFLOW_TYPE = 'feature';

/** Injected so the tests drive a real store at a temporary root, with a fixed catalog and clock. */
export interface PrepareDeps {
  readonly bundleStore?: RunBundleStore;
  readonly catalogInvariants?: (workflowType: string, phase: string) => readonly CatalogInvariant[];
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
function resolvedCatalogInvariants(workflowType: string, phase: string): readonly CatalogInvariant[] {
  const repoRoot = process.cwd();
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

  const artifacts = isRecord(state.artifacts) ? state.artifacts : {};
  const designRef =
    typeof artifacts.design === 'string' && artifacts.design.length > 0 ? artifacts.design : undefined;
  const catalogInvariants = (deps.catalogInvariants ?? resolvedCatalogInvariants)(workflowType, phase);

  const inputs = {
    streamId,
    workflowType,
    definitionVersion: lowered.definitionVersion,
    batch,
    catalogInvariants,
    designRef: designRef ?? null,
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
