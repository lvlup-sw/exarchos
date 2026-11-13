/**
 * `prepare` compiles the outstanding work of a workflow into a capsule.
 *
 * It is the first of the two semantic plane calls. It compiles the batch that waits for delegation
 * into an immutable capsule. Then it puts the capsule in custody and records `workflow.prepared`
 * with the capsule digest. The harness runs the batch with no governance calls, and `settle` judges
 * the results against this capsule.
 *
 * A bootstrap atomically starts a workflow and compiles its first batch before document synchronization.
 * The caller names the repository with an absolute `repoRoot`, and the capsule pins it with the commit of the base.
 * The config, the catalogs, the design record and each user workflow definition come from the checkout of that repository.
 *
 * The claim key is the digest of the compilation inputs, so a retry returns the recorded capsule. The inputs include the base,
 * its commit, the scope, the verification profile, the design version, a readable design record and the compiler name.
 *
 * The first prepare after a design revision is a continuation. Its commit also records
 * `capsule.recompiled`, which names the unfinished tasks that the revision invalidated.
 * A retry of a continuation returns the recorded receipt, with the recompile that it recorded.
 *
 * A capsule under a revised design states the accepted changes. After the replay lookup, prepare
 * reads them from the settlement bundles of the bound revisions. An unreadable bundle refuses the call.
 */

import { ZodError } from 'zod';

import { capsuleDigest, contentDigest } from '../../contract/capsule/capsule-digest.js';
import { CapsuleBaseRefSchema } from '../../contract/capsule/exarchos-capsule.js';
import { requestDigest as canonicalRequestDigest } from '../../contract/request-context.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import { resolveVerificationProfile } from '../../config/verification-profile.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { runExclusivePerOperation } from '../../dispatch/core/operation-serializer.js';
import { resolveSubjectStream } from '../../dispatch/core/subject-stream.js';
import { getDispatchContext } from '../../dispatch/dispatch-context.js';
import { OperationDigestMismatchError } from '../../events/atomic-appender.js';
import type { BundleRefV1 } from '../../events/bundle/digest-references.js';
import type { RunBundleStore } from '../../events/bundle/run-bundle-store.js';
import { ConcurrencyError } from '../../events/concurrency-error.js';
import { validateEventRowData } from '../../events/event-validation.js';
import { DesignRevisedData, WorkflowStartedData, type DesignRevised, type WorkflowEvent } from '../../events/schemas.js';
import { foldWorkflowState, rowStatusByTask } from '../../projections/guard-input/fold.js';
import type { ToolResult } from '../../format.js';
import { findActionInRegistry } from '../../registry.js';
import { ALL_RUNBOOKS } from '../../runbooks/definitions.js';
import { ContentAddressedStoreError } from '../../storage/artifacts/content-addressed-store.js';
import { capabilityNeedSatisfied } from '../../workflow/capabilities/resolver.js';
import { loadPreparedCustody, selectPreparedAuthority, type PreparedAuthoritySelection } from '../../workflow/capsule/prepared-custody.js';
import { compileDecideDefinition } from '../../workflow/decide/edges.js';
import type { DesignRecordSnapshot } from '../../workflow/design-record/schema.js';
import { validateDesignRecord } from '../../workflow/design-record/validate.js';
import { FeatureIdSchema } from '../../workflow/schemas.js';
import { VERIFICATION_GATE_NAMES } from '../../workflow/verification-policy.js';
import { resolveVerificationPolicy } from '../../workflow/verification-policy-resolver.js';
import { resolveGateSeverity } from '../gates/gate-severity.js';
import { resolveWorkflowState } from '../resolve-state.js';
import { deviationIdOf } from '../settle/handler.js';
import { decodeSettlementBundle, type SettlementBundleV1 } from '../settle/settlement-bundle.js';
import type { CatalogInvariant } from './bind-authority.js';
import { bootstrapCollision, bootstrapRequestOf, bootstrapSyncFailure, buildBootstrapPlan, replayBootstrap, type BootstrapRequest } from './bootstrap.js';
import {
  compileDelegationCapsule,
  ladderCells,
  PREPARE_COMPILER_VERSION,
  selectDesignChanges,
  type AcceptedDesignChange,
  type CompileCapsuleInput,
} from './compile-capsule.js';
import { resolveDefinition } from './definition-registry.js';
import { DESIGN_REVISED_TYPE, designVersionOf } from './design-version.js';
import { PrepareIntentSchema, type CompileIntent } from './intent.js';
import { partitionDelegationBatch, typedPlanTasks } from './partition-tasks.js';
import { pinDefinition } from './pin-definition.js';
import {
  configDigestAt,
  legacyDesignAt,
  GIT_SCOPE,
  loadCheckoutConfig,
  locateCheckout,
  observeScope,
  otherRepositoryRefusal,
  readRepoRoot,
  readTypedDesignAt,
  resolveCheckoutCatalog,
  staticAnalysisRefusal,
  type CheckoutCatalogInput,
  type ScopeGit,
} from './prepare-scope.js';
import { commitPreparedCapsule, type PreparedCommit } from './prepared-record.js';
import { pendingRevisionOf, recompiledSliceOf } from './recompiled-slice.js';
import { compilableSteps, locateStep, type StepFindingRule } from './step-locator.js';
import type { PreparedCapsuleReceipt, PreparedRecompile, PrepareRefusal } from './types.js';

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
  /**
   * The compiler name that the compilation is recorded under. Production passes none and gets the name of this build.
   * A test passes an earlier name, to record a claim as an earlier compiler left it.
   */
  readonly compilerVersion?: string;
  /** The three git reads of the scope. Production passes none and gets the reads of git. */
  readonly scopeGit?: ScopeGit;
}

function invalid(message: string): ToolResult {
  return { success: false, error: { code: 'INVALID_INPUT', message } };
}

function refused(refusal: PrepareRefusal): ToolResult {
  return { success: false, error: { ...refusal } };
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

/**
 * The recompile that a continuation records, or undefined for an ordinary prepare.
 * A prepare is a continuation when the stream holds a design revision after its latest prepared record.
 * The record of the continuation comes after that revision, so a revision is pending for one commit only.
 *
 * `events` is the read whose tail the commit expects, and `plan` is the task list that the partition reads.
 * A stream that moves after that read refuses the commit. Thus a committed row and its capsule agree.
 */
function recompileOf(
  events: readonly { readonly type: string; readonly data?: unknown }[],
  plan: readonly unknown[],
): PreparedRecompile | undefined {
  const pending = pendingRevisionOf(events);
  if (pending === undefined) return undefined;
  const slice = recompiledSliceOf(pending.affectedTasks, plan);
  return {
    priorCapsuleVersion: pending.priorCapsuleVersion,
    priorDesignVersion: pending.priorDesignVersion,
    nextDesignVersion: pending.nextDesignVersion,
    declaredTasks: slice.declared,
    invalidatedTasks: slice.invalidated,
  };
}

/** The design revision rows of one stream read, in commit order, each parsed through the row schema. */
function designRevisionsOf(
  events: readonly { readonly type: string; readonly data?: unknown }[],
): DesignRevised[] {
  return events
    .filter((event) => event.type === DESIGN_REVISED_TYPE)
    .map((event) => DesignRevisedData.parse(event.data));
}

/** The number of schema issues that a refusal names for a bundle that does not decode. */
const DECODE_ISSUES_NAMED = 3;

/**
 * Why the settlement bundle of a revision gave no bundle, as the end of a sentence about that bundle.
 * A missing blob and a blob that does not match its digest are different faults with different repairs.
 */
function unreadableReason(error: unknown): string {
  if (error instanceof ContentAddressedStoreError && error.code === 'CONTENT_NOT_FOUND') {
    return 'is not in the run-bundle store';
  }
  if (error instanceof ContentAddressedStoreError && error.code === 'DIGEST_MISMATCH') {
    return 'does not match its digest in the run-bundle store';
  }
  if (error instanceof ZodError) {
    const issues = error.issues
      .slice(0, DECODE_ISSUES_NAMED)
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    return `does not decode as a settlement bundle (${issues.join('; ')})`;
  }
  return `cannot be read (${error instanceof Error ? error.message : String(error)})`;
}

/**
 * The refusal for a bound revision whose accepted changes cannot be read.
 * `fault` ends the first sentence. It says what is wrong with the settlement bundle that the row names.
 */
function revisionUnreadable(streamId: string, revision: DesignRevised, fault: string): PrepareRefusal {
  return {
    code: 'REVISION_UNREADABLE',
    message:
      `the revision of '${streamId}' to design version ${revision.nextDesignVersion} ${fault}. ` +
      'A capsule under a revised design states the accepted changes of that bundle, so nothing was ' +
      'compiled or recorded. Restore the bundle in the run-bundle store, then prepare again.',
  };
}

type SettlementBundleRead =
  | { readonly ok: true; readonly bundle: SettlementBundleV1 }
  | { readonly ok: false; readonly reason: string };

/** Resolves one settlement bundle and decodes it. A failure of either step is an answer, not an exception. */
async function readSettlementBundle(
  bundles: RunBundleStore,
  digest: BundleRefV1['digest'],
): Promise<SettlementBundleRead> {
  try {
    return { ok: true, bundle: decodeSettlementBundle(await bundles.resolve(digest)) };
  } catch (error) {
    return { ok: false, reason: unreadableReason(error) };
  }
}

type AcceptedChangesRead =
  | { readonly ok: true; readonly changes: readonly AcceptedDesignChange[] }
  | { readonly ok: false; readonly refusal: PrepareRefusal };

/**
 * Reads the accepted changes of one revision from the settlement bundle that its row names.
 * From the bundle it takes each deviation that the row names, in row order, and no other deviation.
 * The deviation id function of `settle` pairs a deviation with its decision, and the decision must accept it.
 *
 * A bundle that does not resolve or decode refuses the read.
 * So does a bundle that lacks a named deviation, or the decision that accepted it.
 */
async function readAcceptedChanges(
  streamId: string,
  revision: DesignRevised,
  bundles: RunBundleStore,
): Promise<AcceptedChangesRead> {
  const ref = revision.bundleRefs[0];
  if (ref === undefined) {
    return { ok: false, refusal: revisionUnreadable(streamId, revision, 'names no settlement bundle') };
  }
  const named = `names the settlement bundle ${ref.artifactId} (${ref.digest.algorithm}:${ref.digest.value})`;
  const read = await readSettlementBundle(bundles, ref.digest);
  if (!read.ok) {
    return { ok: false, refusal: revisionUnreadable(streamId, revision, `${named}, which ${read.reason}`) };
  }
  const { bundle } = read;
  const held = new Map(
    bundle.deviations.map((deviation) => [
      deviationIdOf(bundle.capsule, {
        deviationKind: deviation.deviationKind,
        statement: deviation.statement,
        ...(deviation.affectedTasks !== undefined ? { affectedTasks: deviation.affectedTasks } : {}),
        ...(deviation.proposedChange !== undefined ? { proposedChange: deviation.proposedChange } : {}),
      }),
      deviation,
    ]),
  );
  const accepted = new Map(
    (bundle.decisions ?? [])
      .filter((decision) => decision.decision === 'accepted')
      .map((decision) => [decision.deviationId, decision]),
  );
  const changes: AcceptedDesignChange[] = [];
  for (const deviationId of revision.deviationIds) {
    const deviation = held.get(deviationId);
    const decision = accepted.get(deviationId);
    if (deviation === undefined || decision === undefined) {
      const lacks = deviation === undefined ? 'the deviation' : 'an accepted decision for the deviation';
      return {
        ok: false,
        refusal: revisionUnreadable(
          streamId,
          revision,
          `${named}, which lacks ${lacks} ${JSON.stringify(deviationId)} that the revision names`,
        ),
      };
    }
    changes.push({
      deviationId,
      actor: decision.actor,
      statement: deviation.statement,
      ...(deviation.affectedTasks !== undefined ? { affectedTasks: deviation.affectedTasks } : {}),
      ...(deviation.proposedChange !== undefined ? { proposedChange: deviation.proposedChange } : {}),
    });
  }
  return { ok: true, changes };
}

/**
 * Reads the accepted changes that the capsule states, one settlement bundle at a time.
 * The selection of the compiler names the next revision whose changes it needs, and this function reads that bundle.
 * Thus the bundle of each bound revision is read once, and the bundle of no other revision is read.
 *
 * Each read gives the selection one more revision, so one pass for each revision completes the selection.
 * The compiler runs the same selection on the result, and it refuses a result that is not complete.
 */
async function readBoundChanges(
  streamId: string,
  revisions: readonly DesignRevised[],
  batchTaskIds: readonly string[],
  bundles: RunBundleStore,
): Promise<AcceptedChangesRead> {
  const changes: AcceptedDesignChange[] = [];
  for (let reads = 0; reads < revisions.length; reads += 1) {
    const selection = selectDesignChanges(revisions, batchTaskIds, changes);
    if (selection.complete) break;
    const read = await readAcceptedChanges(streamId, selection.unread, bundles);
    if (!read.ok) return read;
    changes.push(...read.changes);
  }
  return { ok: true, changes };
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
  branch: unknown,
): { readonly ok: true; readonly baseRef: string } | { readonly ok: false; readonly refusal: PrepareRefusal } {
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

/** Read the original start. Patches and projected defaults do not give a stream its type. */
function startedTypeOf(rows: readonly WorkflowEvent[], streamId: string): string | undefined {
  const start = rows.find((row) => row.type === 'workflow.started');
  if (start === undefined) return undefined;
  validateEventRowData(start);
  const parsed = WorkflowStartedData.safeParse(start.data);
  return parsed.success && parsed.data.featureId === streamId ? parsed.data.workflowType : undefined;
}

/** Return a common base only when the capsule gives each task the same ref. */
function capsuleBaseOf(capsule: PreparedCapsuleReceipt['capsule']): string | undefined {
  const refs = new Set(Object.values(capsule.settlementContract.taskVerification ?? {}).map((task) => task.baseRef));
  return refs.size === 1 ? refs.values().next().value : undefined;
}

/** Validate claim and commit receipts before accepting them as a result or a replay hint. */
function matchesReceipt(receipt: PreparedCapsuleReceipt, streamId: string, operationId: string): boolean {
  const identity = receipt?.capsule?.identity;
  return identity !== undefined && receipt.operationId === operationId
    && receipt.streamId === streamId && receipt.workflowId === streamId && identity.workflowId === streamId
    && receipt.capsuleVersion === identity.capsuleVersion && receipt.definitionVersion === identity.definitionVersion
    && receipt.capsuleDigest === capsuleDigest(receipt.capsule);
}

function claimMismatch(): ToolResult {
  return { success: false, error: { code: 'OPERATION_DIGEST_MISMATCH', message: 'The stored claim has different compile inputs.' } };
}

/** The latest accepted claim can supply the base for replay before the custody read. */
function claimedBaseOf(ctx: DispatchContext, selection: PreparedAuthoritySelection): string | undefined {
  const { record, streamId, sequence } = selection;
  const claim = ctx.eventStore.getAppender().ensureSqliteBackendSync()
    .lookupOperationClaim<PreparedCapsuleReceipt>(record.operationId);
  const receipt = claim?.result;
  if (claim === undefined || receipt === undefined || claim.streamId !== streamId
    || claim.requestDigest !== record.requestDigest || !claim.sequences.includes(sequence)
    || !matchesReceipt(receipt, streamId, record.operationId) || receipt.tailSequence !== sequence
    || receipt.capsuleVersion !== record.capsuleVersion || receipt.definitionVersion !== record.definitionVersion
    || receipt.capsuleDigest !== record.capsuleDigest || receipt.capsule.provenance.compilerVersion !== record.compilerVersion) {
    return undefined;
  }
  return capsuleBaseOf(receipt.capsule);
}

/**
 * Fold lifecycle rows and the recorded branch. Other state patches do not supply typed compile inputs.
 */
function compileStateOf(rows: readonly WorkflowEvent[]) {
  const inputs = rows.flatMap((row): WorkflowEvent[] => {
    if (row.type !== 'state.patched') return [row];
    const patch = row.data?.patch;
    if (!isRecord(patch)) return [];
    const entries = Object.entries(patch).filter(([key]) => key === 'synthesis' || key === 'synthesis.integrationBranch');
    if (entries.length === 0) return [];
    return [{ ...row, data: { patch: Object.fromEntries(entries) } }];
  });
  return foldWorkflowState(inputs);
}

function branchOf(state: Record<string, unknown>): unknown {
  return isRecord(state.synthesis) ? state.synthesis.integrationBranch : undefined;
}

function preparedAuthorityRefusal(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return refused({ code: 'PREPARED_AUTHORITY_INVALID', message: `Cannot read the latest prepared authority. ${message}` });
}

function unsoundRecord(message: string): PrepareRefusal {
  return {
    code: 'PLAN_UNSOUND',
    message,
    planFindings: [{
      code: 'INVALID_DESIGN_RECORD',
      taskIds: [],
      requirementIds: [],
      span: { start: 0, end: 0, startLine: 1, endLine: 1 },
      message,
    }],
  };
}

type ApprovedDesign =
  | { readonly ok: true; readonly snapshot: DesignRecordSnapshot }
  | { readonly ok: false; readonly refusal: PrepareRefusal };

/** Use the approved capture for soundness, frontier, provenance and custody. */
async function approvedDesignAt(checkout: string, intent: Pick<CompileIntent, 'designRef' | 'approval'>): Promise<ApprovedDesign> {
  const read = await readTypedDesignAt(checkout, intent.designRef);
  if (read.kind !== 'typed') {
    return { ok: false, refusal: unsoundRecord(read.kind === 'invalid' ? read.message : 'The design record needs a typed plan.') };
  }
  if (read.snapshot.digest !== intent.approval.designDigest) {
    return { ok: false, refusal: { code: 'DESIGN_APPROVAL_MISMATCH', message: 'The design file differs from the approved bytes.' } };
  }
  try {
    const validation = validateDesignRecord(read.snapshot);
    if (!validation.passed) {
      return {
        ok: false,
        refusal: {
          code: 'PLAN_UNSOUND',
          message: 'The typed plan has whole-plan findings.',
          planFindings: validation.findings,
        },
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, refusal: { code: 'INTERNAL_ERROR', message: `Cannot validate the typed plan. ${message}` } };
  }
  return { ok: true, snapshot: read.snapshot };
}

/** The artifact keys that can name the design of record, in the order that prepare reads them. */
const DESIGN_REFERENCE_KEYS: readonly string[] = ['spec', 'design', 'plan'];

/** The longest artifact value, in characters, that prepare takes as a design reference. */
const DESIGN_REFERENCE_MAX_LENGTH = 512;

/**
 * The characters that end a line in an artifact value. Two are the line feed and the carriage return.
 * The others are the vertical tab, the form feed, the next line character, and the line and paragraph separators.
 */
const LINE_BREAK = /[\n\r\u000b\u000c\u0085\u2028\u2029]/;

/**
 * Tells a reference to a document from the contents of a document.
 * A reference is a string of one line that is not blank and stays in the length bound.
 */
function isDesignReference(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= DESIGN_REFERENCE_MAX_LENGTH &&
    !LINE_BREAK.test(value)
  );
}

/**
 * The design of record of the workflow: the first artifact value that is a reference.
 * An artifact key can hold the contents of a document, so a value that is not a reference is skipped.
 * With no reference, the capsule binds no design.
 */
function resolveDesignRef(state: Record<string, unknown>): string | undefined {
  const artifacts = isRecord(state.artifacts) ? state.artifacts : {};
  for (const key of DESIGN_REFERENCE_KEYS) {
    const value = artifacts[key];
    if (isDesignReference(value)) return value;
  }
  return undefined;
}

/**
 * The severity of one verification gate under a config. The dimension of the gate comes from its registration.
 * The severity of a gate is keyed by its action name.
 */
function gateSeverityOf(
  gate: string,
  config: ResolvedProjectConfig,
  workflowType: string,
): 'blocking' | 'warning' | 'disabled' {
  const dimension = findActionInRegistry('exarchos_orchestrate', gate)?.gate?.dimension ?? '';
  return resolveGateSeverity(gate, dimension, config, workflowType);
}

type CatalogOutcome =
  | { readonly ok: true; readonly invariants: readonly CatalogInvariant[] }
  | { readonly ok: false; readonly refusal: PrepareRefusal };

/**
 * The catalog invariants of the batch. A test seam gives its own invariants. Else the effective catalog of the checkout
 * gives them, and a registered catalog that does not resolve refuses.
 */
function catalogOf(deps: PrepareDeps, input: CheckoutCatalogInput): CatalogOutcome {
  if (deps.catalogInvariants === undefined) return resolveCheckoutCatalog(input);
  return { ok: true, invariants: deps.catalogInvariants(input.workflowType, input.phase, input.checkout) };
}

/**
 * The custom types of the `workflows:` key of the server config. The registry refuses each of them before it reads a file or runs git.
 * This in-memory read is the one read of server state in prepare. It can only refuse, and no input of the claim key comes from it.
 */
function configWorkflowTypesOf(ctx: DispatchContext): readonly string[] {
  return Object.keys(ctx.config?.workflows ?? {});
}

/**
 * The refusal for a phase that is not a task-batch step of the definition. The message names the phase and the finding.
 * It names the compilable steps, or it says that the definition has none. A single-agent step also names the primitive path.
 */
function stepRefusal(
  streamId: string,
  workflowType: string,
  phase: string | undefined,
  rule: StepFindingRule,
  compilable: readonly string[],
): PrepareRefusal {
  const steps =
    compilable.length > 0
      ? `prepare compiles the steps ${compilable.map((stepId) => `'${stepId}'`).join(', ')} of that definition. ` +
        'Transition to one of them, then prepare again.'
      : `The '${workflowType}' definition has no task-batch step, so prepare compiles no step of it.`;
  const primitive =
    rule === 'single-agent-step' ? ' A single-agent step takes the primitive path of the delegate skill.' : '';
  return {
    code: 'PHASE_NOT_PREPARABLE',
    message:
      `'${streamId}' is in phase '${phase ?? 'unknown'}', which is not a task-batch step of the '${workflowType}' ` +
      `definition (finding: ${rule}). ${steps}${primitive}`,
  };
}

/**
 * Compiles the delegation batch of a workflow into a capsule and records it.
 *
 * The handler reads the stream before it folds the state. The stream tail is
 * the expected sequence of the commit, so the store refuses the commit after a
 * concurrent append. The design version and the pending revision come from the same read.
 * The commit announces only the batch tasks that the stream has not seen,
 * because a second `task.assigned` moves a task back to `assigned`.
 *
 * The runtime check occurs before compilation. Then git observes the scope, and the config, the catalog and the design
 * record load from the checkout. The scope holds the config digest and the inputs hold the profile, so a change of either compiles the next version.
 * A replay returns the receipt of its claim and reads no bundle. Only a call that compiles reads
 * the capsule of the latest prepared record, and then the settlement bundles of the revisions that its capsule binds.
 */
export async function handlePrepare(
  raw: Record<string, unknown>,
  stateDir: string,
  ctx: DispatchContext,
  deps: PrepareDeps = {},
): Promise<ToolResult> {
  const subject = resolveSubjectStream(raw);
  if (!subject.ok) return invalid(subject.message);
  const { streamId } = subject;
  const root = readRepoRoot(raw);
  if (!root.ok) return invalid(root.message);
  const { repoRoot } = root;
  const parsedIntent = PrepareIntentSchema.optional().safeParse(raw.intent);
  if (!parsedIntent.success) return invalid(parsedIntent.error.message);
  const intent = parsedIntent.data;
  if (intent?.mode !== 'bootstrap') {
    return prepareFromSnapshot(intent, streamId, repoRoot, await ctx.eventStore.query(streamId), ctx, deps);
  }
  if (!FeatureIdSchema.safeParse(streamId).success) return invalid('Bootstrap requires a valid feature ID.');

  const bootstrap = bootstrapRequestOf(streamId, repoRoot, intent);
  const rows = await ctx.eventStore.query(streamId);
  if (rows.length > 0) return replayBootstrap(ctx, stateDir, bootstrap, rows);

  let result: ToolResult;
  try {
    result = await bootstrapCollision(stateDir, streamId)
      ?? await prepareFromSnapshot(undefined, streamId, repoRoot, rows, ctx, deps, bootstrap);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = refused({ code: 'INTERNAL_ERROR', message: `Cannot commit bootstrap. ${message}` });
  }
  if (result.success) {
    const receipt = result.data as PreparedCapsuleReceipt;
    try {
      const current = await ctx.eventStore.query(streamId);
      return await replayBootstrap(
        ctx, stateDir, bootstrap, current, bootstrapSyncFailure(receipt, 'The accepted marker is unavailable.'), receipt,
      );
    } catch (error) {
      return bootstrapSyncFailure(receipt, error);
    }
  }
  const current = await ctx.eventStore.query(streamId).catch(() => rows);
  if (current.length === 0) return result;
  const original = result.error?.code === 'CONCURRENCY_CONFLICT' ? undefined : result;
  return replayBootstrap(ctx, stateDir, bootstrap, current, original);
}

/** Compile from the first stream read. An empty stream supplies only checked bootstrap facts. */
async function prepareFromSnapshot(
  intent: CompileIntent | undefined,
  streamId: string,
  repoRoot: string,
  events: readonly WorkflowEvent[],
  ctx: DispatchContext,
  deps: PrepareDeps,
  bootstrap?: BootstrapRequest,
): Promise<ToolResult> {
  if (events.length === 0 && bootstrap === undefined) {
    return refused({ code: 'WORKFLOW_NOT_FOUND', message: `no workflow is recorded for '${streamId}'` });
  }
  const tail = events[events.length - 1]?.sequence ?? 0;
  const capsuleVersion = events.filter((event) => event.type === 'workflow.prepared').length + 1;

  let authority: PreparedAuthoritySelection | undefined;
  if (intent !== undefined || events.some((row) => row.type === 'workflow.prepared' && Object.hasOwn(row.data ?? {}, 'planRecordDigest'))) {
    try {
      authority = selectPreparedAuthority(events, streamId);
    } catch (error) {
      return preparedAuthorityRefusal(error);
    }
    if (intent === undefined) {
      return refused({ code: 'PREPARE_INTENT_REQUIRED', message: 'This stream requires an approved compile intent.' });
    }
  }

  let state: Record<string, unknown>;
  let recordedType: string | undefined;
  if (bootstrap !== undefined) {
    recordedType = bootstrap.intent.workflowType;
    state = { synthesis: { integrationBranch: bootstrap.intent.baseRef } };
  } else if (intent !== undefined) {
    try {
      recordedType = startedTypeOf(events, streamId);
      state = { ...compileStateOf(events) };
    } catch (error) {
      return preparedAuthorityRefusal(error);
    }
    if (recordedType === undefined) {
      return refused({ code: 'WORKFLOW_NOT_FOUND', message: `No valid start is recorded for '${streamId}'.` });
    }
    if (intent.workflowType !== undefined && intent.workflowType !== recordedType) {
      return invalid(`The compile intent names '${intent.workflowType}', but the workflow started as '${recordedType}'.`);
    }
    if (intent.refactor !== undefined && recordedType !== 'refactor') {
      return invalid('Refactor terms require the refactor workflow type.');
    }
    if (recordedType === 'refactor' && intent.refactor === undefined) {
      return invalid('Refactor compile requires overhaul terms.');
    }
    if (authority !== undefined && authority.record.workflowType !== recordedType) {
      return preparedAuthorityRefusal(new Error('The latest prepared workflow type differs from the start.'));
    }
  } else {
    const resolved = await resolveWorkflowState({ featureId: streamId, eventStore: ctx.eventStore });
    if ('error' in resolved) return resolved.error;
    state = resolved.state;
    recordedType = typeof state.workflowType === 'string' ? state.workflowType : undefined;
  }

  const git = deps.scopeGit ?? GIT_SCOPE;
  const resolution = await resolveDefinition({
    streamId,
    workflowType: recordedType,
    locateCheckout: () => locateCheckout(repoRoot, git),
    configWorkflowTypes: configWorkflowTypesOf(ctx),
  });
  if (!resolution.ok) return refused(resolution.refusal);
  const { registered, located } = resolution;
  const { workflowType } = registered;

  let checkoutLocation = located;
  let snapshot: DesignRecordSnapshot | undefined;
  let planned: PreparedCommit['bootstrap'];
  let bootstrapScope: Extract<Awaited<ReturnType<typeof observeScope>>, { ok: true }> | undefined;
  let bootstrapConfig: Extract<ReturnType<typeof loadCheckoutConfig>, { ok: true }> | undefined;
  let bootstrapProfile: ReturnType<typeof resolveVerificationProfile> | undefined;
  const approvedIntent = bootstrap?.intent ?? intent;
  if (bootstrap !== undefined) {
    if (checkoutLocation === undefined) {
      const checkoutResult = await locateCheckout(repoRoot, git);
      if (!checkoutResult.ok) return refused(checkoutResult.refusal);
      checkoutLocation = checkoutResult.located;
    }
    const approved = await approvedDesignAt(checkoutLocation.toplevel, bootstrap.intent);
    if (!approved.ok) return refused(approved.refusal);
    snapshot = approved.snapshot;
    const scope = await observeScope({
      streamId, repoRoot, baseRef: bootstrap.intent.baseRef, completedBlockers: {}, rows: events, git,
      located: checkoutLocation,
    });
    if (!scope.ok) return refused(scope.refusal);
    bootstrapScope = scope;
    const loaded = loadCheckoutConfig(scope.observed.checkout);
    if (!loaded.ok) return refused(loaded.refusal);
    bootstrapConfig = loaded;
    bootstrapProfile = resolveVerificationProfile(scope.observed.checkout, { loadConfig: () => loaded.config.outcome });
    const prefix = buildBootstrapPlan(bootstrap, {
      definition: registered.definition, repository: scope.observed.repository, snapshot,
      profile: bootstrapProfile, skipPhases: loaded.config.projectConfig.workflow.skipPhases,
      timestamp: (deps.now ?? (() => new Date().toISOString()))(),
    });
    if (!prefix.ok) {
      return refused({ code: prefix.code, message: prefix.message, ...(prefix.findings ? { planFindings: prefix.findings } : {}) });
    }
    planned = prefix;
  }
  const phase = planned?.phase ?? (typeof state.phase === 'string' ? state.phase : undefined);
  const location = phase === undefined ? undefined : locateStep(registered.definition, phase);
  if (location === undefined || !location.ok) {
    const rule = location?.rule ?? 'not-a-step';
    const compilable = location?.compilable ?? compilableSteps(registered.definition);
    return refused(stepRefusal(streamId, workflowType, phase, rule, compilable));
  }
  const lowered = pinDefinition(workflowType, registered.definition);

  if (intent !== undefined) {
    if (checkoutLocation === undefined) {
      const checkoutResult = await locateCheckout(repoRoot, git);
      if (!checkoutResult.ok) return refused(checkoutResult.refusal);
      checkoutLocation = checkoutResult.located;
    }
    const approved = await approvedDesignAt(checkoutLocation.toplevel, intent);
    if (!approved.ok) return refused(approved.refusal);
    snapshot = approved.snapshot;
  }
  const plan: readonly unknown[] = snapshot !== undefined
    ? typedPlanTasks(snapshot, rowStatusByTask(events))
    : Array.isArray(state.tasks) ? state.tasks : [];
  const partition = partitionDelegationBatch(plan, location.step.stepId);
  if (!partition.ok) return refused(partition.refusal);
  const { batch, completedBlockers } = partition;

  const bundles = deps.bundleStore ?? ctx.eventStore.bundleStore;
  let checkedPin: Awaited<ReturnType<typeof loadPreparedCustody>> | undefined;
  let branch = branchOf(state);
  if (intent !== undefined) {
    if (authority !== undefined && (authority.kind === 'typed' || branch == null)) {
      let pinnedBase: string | undefined;
      try {
        pinnedBase = claimedBaseOf(ctx, authority);
        if (pinnedBase === undefined) {
          checkedPin = await loadPreparedCustody(authority, bundles);
          pinnedBase = capsuleBaseOf(checkedPin.capsule);
        }
      } catch (error) {
        return preparedAuthorityRefusal(error);
      }
      if (pinnedBase === undefined && authority.kind === 'typed') {
        return preparedAuthorityRefusal(new Error('The typed capsule needs one common base ref.'));
      }
      branch = pinnedBase ?? branch;
    }
    if (branch != null && intent.baseRef !== undefined && intent.baseRef !== branch) {
      return refused({ code: 'BASE_UNRESOLVED', message: 'The compile intent base differs from the recorded base.' });
    }
    branch ??= intent.baseRef;
  }
  const base = resolveBaseRef(streamId, branch);
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

  const observed = bootstrapScope ?? await observeScope({
    streamId,
    repoRoot,
    baseRef,
    completedBlockers,
    rows: events,
    git,
    ...(checkoutLocation !== undefined ? { located: checkoutLocation } : {}),
  });
  if (!observed.ok) return refused(observed.refusal);
  const { checkout, repository, baseCommit } = observed.observed;
  const loaded = bootstrapConfig ?? loadCheckoutConfig(checkout);
  if (!loaded.ok) return refused(loaded.refusal);
  const { projectConfig, outcome } = loaded.config;
  const verificationProfile = bootstrapProfile ?? resolveVerificationProfile(checkout, { loadConfig: () => outcome });

  const catalog = catalogOf(deps, { checkout, config: loaded.config, phase: location.step.stepId, workflowType });
  if (!catalog.ok) return refused(catalog.refusal);
  const catalogInvariants = catalog.invariants;

  const staticAnalysis = staticAnalysisRefusal(checkout, gateSeverityOf('check_static_analysis', projectConfig, workflowType));
  if (staticAnalysis !== undefined) return refused(staticAnalysis);
  const disabledGates = VERIFICATION_GATE_NAMES.filter(
    (gate) => gateSeverityOf(gate, projectConfig, workflowType) === 'disabled',
  );

  const scope = { repository, checkout, configDigest: await configDigestAt(checkout) };
  const designRef = snapshot === undefined ? resolveDesignRef(state) : snapshot.reference;
  const legacyDesign = snapshot === undefined ? await legacyDesignAt(checkout, designRef) : undefined;
  if (legacyDesign?.read.kind === 'typed') {
    return refused({ code: 'PREPARE_INTENT_REQUIRED', message: 'The typed design record requires an approved compile intent.' });
  }
  if (legacyDesign?.read.kind === 'invalid') return refused(unsoundRecord(legacyDesign.read.message));
  const designRecordDigest = snapshot?.digest ?? legacyDesign?.digest;
  const designVersion = designVersionOf(events);
  const recompile = recompileOf(events, plan);
  const compilerVersion = deps.compilerVersion ?? PREPARE_COMPILER_VERSION;
  const skipPhases = bootstrap !== undefined || compilerVersion === PREPARE_COMPILER_VERSION
    ? projectConfig.workflow.skipPhases : undefined;
  if (skipPhases !== undefined) {
    try {
      compileDecideDefinition(workflowType, registered.definition, skipPhases);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return refused({ code: 'SCOPE_UNRESOLVED', message: `Cannot freeze the checkout skip policy. ${message}` });
    }
  }

  const sequenceOf: CompileCapsuleInput['verificationSequence'] = (riskTier, boundaryTouching) =>
    resolveVerificationPolicy(riskTier, boundaryTouching, projectConfig).sequence;
  const verificationTerms = ladderCells(batch).map((cell) => ({
    riskTier: cell.riskTier,
    boundaryTouching: cell.boundaryTouching,
    sequence: [...sequenceOf(cell.riskTier, cell.boundaryTouching)],
  }));

  const inputs = {
    streamId,
    workflowType,
    definitionVersion: lowered.definitionVersion,
    batch,
    catalogInvariants,
    designRef: designRef ?? null,
    designVersion,
    compilerVersion,
    executionProfile: { capabilities },
    verificationTerms,
    baseRef,
    baseCommit,
    scope,
    verificationProfile,
    ...(skipPhases !== undefined ? { skipPhases } : {}),
    ...(approvedIntent !== undefined ? {
      intent: { mode: approvedIntent.mode, designDepth: approvedIntent.designDepth ?? 'standard', refactor: approvedIntent.refactor ?? null },
    } : {}),
    ...(bootstrap === undefined ? {} : { bootstrapRequestDigest: bootstrap.entryDigest }),
    ...(designRecordDigest !== undefined ? { designSource: { sourceId: 'design-record', digest: designRecordDigest } } : {}),
  };
  const operationId = `prepare:${contentDigest(inputs)}`;
  const requestDigest = canonicalRequestDigest(inputs);

  return runExclusivePerOperation(operationId, async (): Promise<ToolResult> => {
    const claim = ctx.eventStore
      .getAppender()
      .ensureSqliteBackendSync()
      .lookupOperationClaim<PreparedCapsuleReceipt>(operationId);
    if (claim !== undefined) {
      return claim.streamId === streamId && claim.requestDigest === requestDigest
        && matchesReceipt(claim.result, streamId, operationId) ? receiptResult(claim.result) : claimMismatch();
    }

    if (authority !== undefined) {
      try {
        checkedPin ??= await loadPreparedCustody(authority, bundles);
        if (checkedPin.kind === 'typed' && capsuleBaseOf(checkedPin.capsule) !== baseRef) {
          return preparedAuthorityRefusal(new Error('The typed capsule pins a different base.'));
        }
      } catch (error) {
        return preparedAuthorityRefusal(error);
      }
    }
    const otherRepository = await otherRepositoryRefusal({
      streamId, repoRoot, repository, rows: events, bundles,
      ...(checkedPin !== undefined ? { pinnedCapsule: checkedPin.capsule } : {}),
    });
    if (otherRepository !== undefined) return refused(otherRepository);

    const designRevisions = designRevisionsOf(events);
    const accepted = await readBoundChanges(
      streamId,
      designRevisions,
      batch.tasks.map((task) => task.taskId),
      bundles,
    );
    if (!accepted.ok) return refused(accepted.refusal);

    const compiled = compileDelegationCapsule({
      workflowId: streamId,
      capsuleVersion,
      lowered,
      batch,
      catalogInvariants,
      designRef,
      ...(designRecordDigest !== undefined ? { designRecordDigest } : {}),
      designVersion,
      designRevisions,
      acceptedChanges: accepted.changes,
      compilerVersion,
      baseRef,
      pin: { scope, baseCommit },
      verificationProfile,
      executionProfile: { capabilities },
      verificationSequence: sequenceOf,
      disabledGates,
      ...(skipPhases !== undefined ? { skipPhases } : {}),
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
          ...(planned === undefined ? {} : { bootstrap: planned }),
          ...(snapshot !== undefined ? {
            plan: {
              digest: snapshot.digest,
              designRecord: { reference: snapshot.reference, text: Buffer.from(snapshot.rawBytes).toString('utf8') },
            },
          } : {}),
          ...(recompile !== undefined ? { recompile } : {}),
        },
        deps.bundleStore,
      );
      return matchesReceipt(receipt, streamId, operationId) ? receiptResult(receipt) : claimMismatch();
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
