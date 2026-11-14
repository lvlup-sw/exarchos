/**
 * Authenticated task standing joins operation claims, custody and exact ledger rows before commit.
 * RESERVED(issue: #1927, owner: exarchos, expires: 2026-12-14)
 * Production callers will use this resolver for segment recovery and dependency scheduling.
 * Remove this reservation when those callers adopt it.
 */
import { z } from 'zod';
import { canonicalJson, requestDigest as canonicalRequestDigest } from '../../contract/request-context.js';
import { TaskVerificationCoordinateSchema } from '../../contract/capsule/exarchos-capsule.js';
import { BundleRefV1Schema } from '../../events/bundle/digest-references.js';
import type { RunBundleStore } from '../../events/bundle/run-bundle-store.js';
import { DesignRevisedData, ExecutionSettledData, OrchestrateIntentExecutedData } from '../../events/schemas.js';
import { loadPreparedCustody, selectPreparedAuthority, type PreparedAuthority } from '../../workflow/capsule/prepared-custody.js';
import { decodeExecuteIntentBundle, normalizedExecuteRequestDigest, receiptLeavesOfRun } from '../execute/run-bundle.js';
import { IntentExecutedOutputSchema } from '../execute/schemas.js';
import type { SettledCapsuleIdentity } from './types.js';
import { SettlementReceiptData } from './schemas.js';
import { decodeSettlementBundle, type SettlementBundleV1 } from './settlement-bundle.js';
import { settlementClaimKey, verificationOperationId } from './settlement-reads.js';

/** Full persisted envelopes retain the random event identifier used by operation claims. */
interface StandingRow {
  readonly streamId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: string;
  readonly eventId?: unknown;
  readonly schemaVersion?: string;
  readonly data?: unknown;
}

/** The storage boundary supplies actual claims, never reconstructed event copies. */
interface StandingClaim {
  readonly streamId: string;
  readonly requestDigest: string;
  readonly result: unknown;
  readonly eventIds: readonly string[];
  readonly sequences: readonly number[];
  readonly timestamps: readonly string[];
}

type ClaimLookup = (operationId: string) => StandingClaim | undefined;
type Coordinate = z.infer<typeof TaskVerificationCoordinateSchema>;
type ProofReference = Coordinate['blockers'][number];

/** Callers supply one stream snapshot and perform all custody reads before the write transaction. */
interface StandingRequest {
  readonly streamId: string;
  readonly taskId: string;
  readonly rows: readonly StandingRow[];
  readonly lookupClaim: ClaimLookup;
  readonly bundles: Pick<RunBundleStore, 'resolve'>;
  readonly provisional?: { readonly outerOperationId: string; readonly capsule: SettledCapsuleIdentity };
  readonly acceptedOperationId?: string;
  readonly pinnedProvisional?: { readonly outerOperationId: string; readonly capsule: SettledCapsuleIdentity };
}

/** A proof exports its original identities and a synchronous fence for the current transaction snapshot. */
interface StandingProof {
  readonly taskId: string;
  readonly headCommit: string;
  readonly coordinate: Coordinate;
  readonly reference?: ProofReference;
  readonly outerOperationId: string;
  readonly segmentOperationId: string;
  readonly segmentRecordSequence: number;
  readonly segmentRecord: ProofReference['segmentRecord'];
  readonly completionSequence: number;
  readonly staticAnalysisSequence: number;
  readonly worktreePath: string;
  readonly runBundle: z.infer<typeof BundleRefV1Schema>;
  readonly recheck: (rows: readonly StandingRow[], lookupClaim: ClaimLookup) => boolean;
}

type StandingResult =
  | { readonly kind: 'accepted' | 'provisional'; readonly proof: StandingProof }
  | { readonly kind: 'missing' | 'invalidated' | 'corrupt'; readonly code: 'MISSING_ACCEPTED_STANDING'; readonly message: string };

/** Invalid proofs never fall through to an older, more convenient acceptance. */
class StandingFault extends Error {
  constructor(readonly kind: 'missing' | 'invalidated' | 'corrupt', message: string) { super(message); }
}

/** Require one joined fact without converting absence into success. */
function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new StandingFault('corrupt', message);
}

/** Raw data retains server-observed completion fields that public schemas omit. */
function dataOf(row: StandingRow): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(row.data);
}

/** Compare canonical values without depending on property insertion order. */
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }

/** Bind every terminal append member to its exact persisted envelope. */
function terminalRows(request: StandingRequest, operationId: string, claims: Map<string, string>): { claim: StandingClaim; rows: StandingRow[] } | undefined {
  const claim = request.lookupClaim(operationId);
  if (claim === undefined) return undefined;
  requireFact(claim.streamId === request.streamId && Array.isArray(claim.sequences)
    && Array.isArray(claim.eventIds) && Array.isArray(claim.timestamps) && claim.sequences.length > 0
    && claim.sequences.length === claim.eventIds.length && claim.sequences.length === claim.timestamps.length
    && new Set(claim.sequences).size === claim.sequences.length && new Set(claim.eventIds).size === claim.eventIds.length,
  'Invalid operation claim membership');
  const rows = claim.sequences.map((sequence, index) => {
    const matches = request.rows.filter(row => row.streamId === request.streamId && row.sequence === sequence);
    const row = matches[0];
    requireFact(matches.length === 1 && row !== undefined && typeof row.eventId === 'string' && row.eventId.length > 0
      && row.eventId === claim.eventIds[index] && row.timestamp === claim.timestamps[index], 'Claim member row is missing or changed');
    return row;
  });
  claims.set(operationId, canonicalJson(claim));
  return { claim, rows };
}

/** An exact prepared version must resolve from its original row and immutable custody. */
async function originOf(request: StandingRequest, identity: SettledCapsuleIdentity): Promise<PreparedAuthority> {
  const matches = request.rows.filter(row => row.type === 'workflow.prepared' && dataOf(row).capsuleVersion === identity.capsuleVersion);
  requireFact(matches.length === 1, 'Prepared origin is missing or ambiguous');
  const selection = selectPreparedAuthority(matches, request.streamId);
  requireFact(selection !== undefined, 'Prepared origin is missing');
  const authority = await loadPreparedCustody(selection, request.bundles);
  const { batchId: _settlementBatch, ...settledIdentity } = identity;
  requireFact(same(authority.capsule.identity, settledIdentity), 'Prepared origin differs from the segment capsule');
  return authority;
}

/** Dependency ancestors determine which semantic changes invalidate a task. */
function ancestors(authority: PreparedAuthority, taskId: string): Set<string> {
  const found = new Set([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of authority.capsule.graph.dependencies) {
      if (found.has(edge.to) && !found.has(edge.from)) { found.add(edge.from); changed = true; }
    }
    if (authority.kind === 'typed') for (const task of authority.snapshot.tasks) {
      if (found.has(task.id)) for (const blocker of task.blockedBy) {
        if (!found.has(blocker)) { found.add(blocker); changed = true; }
      }
    }
  }
  return found;
}

/** Source offsets change when unrelated tasks move, but execution terms remain comparable. */
function taskTerms(authority: PreparedAuthority, taskId: string): unknown {
  if (authority.kind !== 'typed') return undefined;
  const task = authority.snapshot.tasks.find(entry => entry.id === taskId);
  if (task === undefined) return undefined;
  const { span: _span, ...terms } = task;
  const node = authority.capsule.graph.tasks.find(entry => entry.taskId === taskId);
  return { terms, definitionVersion: authority.capsule.identity.definitionVersion, stage: node?.stage, stepId: node?.stepId,
    verificationMode: authority.capsule.settlementContract.verificationMode,
    skipPhases: authority.capsule.settlementContract.skipPhases, verification: authority.capsule.settlementContract.taskVerification?.[taskId],
    result: authority.capsule.contracts.taskResults[taskId], scope: authority.capsule.settlementContract.scope,
    profile: authority.capsule.settlementContract.verificationProfile };
}

/** Relevant failures and explicit revisions revoke proof without borrowing a later head. */
function invalidated(rows: readonly StandingRow[], taskIds: ReadonlySet<string>, after: number, completed = after): boolean {
  for (const row of rows) {
    if (row.sequence <= after) continue;
    if (row.type === 'design.revised') {
      if (DesignRevisedData.parse(row.data).affectedTasks.some(id => taskIds.has(id))) return true;
    } else if (row.sequence > completed && (row.type === 'task.failed' || row.type === 'gate.executed')) {
      const data = dataOf(row);
      if (row.type === 'task.failed' && typeof data.taskId === 'string' && taskIds.has(data.taskId)) return true;
      if (row.type === 'gate.executed') {
        const details = z.record(z.string(), z.unknown()).parse(data.details ?? {});
        if (typeof details.taskId === 'string' && taskIds.has(details.taskId) && data.passed === false
          && details.verdict === 'fail' && details.skipped !== true) return true;
      }
    }
  }
  return false;
}

/** The pure fence pins selected rows and claims while ignoring unrelated task activity. */
function fence(request: StandingRequest, claims: Map<string, string>, selected: readonly StandingRow[], relevant: ReadonlySet<string>, after: number, completed: number) {
  const rowIdentities = selected.map(row => ({ sequence: row.sequence, value: canonicalJson(row) }));
  const authority = selectPreparedAuthority(request.rows, request.streamId)?.identity;
  const acceptances = (rows: readonly StandingRow[]) => canonicalJson(rows.filter(row => {
    if (row.type !== 'execution.settled') return false;
    const data = dataOf(row);
    return Array.isArray(data.acceptedTasks) && data.acceptedTasks.some(id => typeof id === 'string' && relevant.has(id));
  }));
  const selectedAcceptances = acceptances(request.rows);
  return (rows: readonly StandingRow[], lookupClaim: ClaimLookup): boolean => {
    try {
      if (rows.some(row => row.streamId !== request.streamId)
        || selectPreparedAuthority(rows, request.streamId)?.identity !== authority || acceptances(rows) !== selectedAcceptances
        || invalidated(rows, relevant, after, completed)) return false;
      for (const item of rowIdentities) {
        const matches = rows.filter(row => row.sequence === item.sequence);
        if (matches.length !== 1 || canonicalJson(matches[0]) !== item.value) return false;
      }
      for (const [operationId, value] of claims) if (canonicalJson(lookupClaim(operationId)) !== value) return false;
      return true;
    } catch { return false; }
  };
}

/** Resolve a successful segment and its earlier leaf effects independently of the terminal claim members. */
async function segmentProof(request: StandingRequest, current: PreparedAuthority, identity: SettledCapsuleIdentity, outerId: string,
  claims: Map<string, string>, selected: StandingRow[], trace?: { operationId?: string | undefined; coordinate?: Coordinate | undefined; treeCommit?: string | undefined; bundleRefs?: unknown; fields?: unknown }): Promise<StandingProof> {
  const segmentId = verificationOperationId(outerId, request.taskId);
  requireFact(trace === undefined || trace.operationId === segmentId, 'Settlement names another segment operation');
  const held = terminalRows(request, segmentId, claims);
  if (held === undefined) throw new StandingFault('missing', 'The segment has no actual operation claim');
  const receipt = IntentExecutedOutputSchema.options[0].shape.data.parse(held.claim.result);
  requireFact(receipt.operationId === segmentId && receipt.intent === 'task-completion' && receipt.requestDigest === held.claim.requestDigest,
    'Segment receipt identity mismatch');
  if (receipt.outcome !== 'committed') throw new StandingFault('invalidated', 'The segment failed');
  const terminals = held.rows.filter(row => row.type === 'orchestrate.intent_executed');
  requireFact(terminals.length === 1, 'Segment terminal membership is ambiguous');
  const terminal = terminals[0];
  requireFact(terminal !== undefined, 'Missing segment terminal');
  const record = OrchestrateIntentExecutedData.parse(terminal.data);
  requireFact(record.operationId === segmentId && record.intent === receipt.intent && record.outcome === receipt.outcome
    && record.requestDigest === held.claim.requestDigest && same(record.bundleRefs, receipt.bundleRefs)
    && same(record.leaves, receipt.leaves.map(leaf => ({ action: leaf.action, status: leaf.status, sequences: leaf.events.map(event => event.sequence) }))),
  'Segment terminal differs from its receipt');
  const ref = BundleRefV1Schema.parse(record.bundleRefs[0]);
  if (trace !== undefined) requireFact(same(trace.bundleRefs, record.bundleRefs), 'Settlement references another run bundle');
  const run = decodeExecuteIntentBundle(await request.bundles.resolve(ref.digest));
  requireFact(run.operationId === segmentId && run.streamId === request.streamId && run.intent === receipt.intent
    && run.requestDigest === held.claim.requestDigest && run.outcome === 'committed', 'Run custody identity mismatch');
  requireFact(same(receiptLeavesOfRun(run),
    receipt.leaves), 'Run leaves differ from receipt');
  const origin = await originOf(request, identity);
  const coordinate = run.input?.args.coordinate;
  if (coordinate === undefined) throw new StandingFault(origin.capsule.provenance.compilerVersion === 'exarchos-prepare-8' ? 'corrupt' : 'missing', 'Segment lacks a complete immutable coordinate');
  requireFact(same(coordinate.capsule, origin.capsule.identity) && coordinate.taskId === request.taskId, 'Coordinate identity mismatch');
  if (trace !== undefined) requireFact(same(trace.coordinate, coordinate) && trace.treeCommit === coordinate.observedHeadCommit, 'Settlement coordinate mismatch');
  const input = run.input;
  requireFact(input !== undefined, 'Missing segment input');
  if (trace !== undefined) requireFact(same(input.args.result, trace.fields), 'Segment result differs from accepted caller fields');
  const digest = normalizedExecuteRequestDigest(input.intent, input.streamId, input.args);
  requireFact(digest === held.claim.requestDigest, 'Stored segment input does not reproduce its request digest');
  for (const action of ['check_static_analysis', 'task_complete']) {
    const leaves = run.leaves.filter(leaf => leaf.action === action);
    const leaf = leaves[0];
    requireFact(leaves.length === 1 && leaf !== undefined && leaf.args.taskId === request.taskId
      && leaf.verdict.status === 'passed' && leaf.disposition.kind !== 'not-invoked'
      && (leaf.disposition.kind !== 'invoked' || leaf.disposition.handler.success), 'Required leaf did not verify this task');
  }
  const completionEvents = receipt.leaves.filter(leaf => leaf.action === 'task_complete' && leaf.status === 'passed').flatMap(leaf => leaf.events).filter(event => event.type === 'task.completed');
  const staticEvents = receipt.leaves.filter(leaf => leaf.action === 'check_static_analysis' && leaf.status === 'passed').flatMap(leaf => leaf.events).filter(event => event.type === 'gate.executed');
  requireFact(completionEvents.length === 1 && staticEvents.length === 1, 'Segment must name one completion and static-analysis row');
  const effects = [...staticEvents, ...completionEvents].map(event => {
    const rows = request.rows.filter(row => row.streamId === event.streamId && row.sequence === event.sequence && row.type === event.type);
    const row = rows[0];
    requireFact(event.streamId === request.streamId && rows.length === 1 && row !== undefined && typeof row.eventId === 'string'
      && row.sequence < terminal.sequence, 'Segment effect row is missing or outside its stream');
    return row;
  });
  const staticRow = effects[0]; const completeRow = effects[1];
  requireFact(staticRow !== undefined && completeRow !== undefined && staticRow.sequence < completeRow.sequence, 'Effect order is invalid');
  const gate = dataOf(staticRow); const completion = dataOf(completeRow);
  const details = z.record(z.string(), z.unknown()).parse(gate.details);
  requireFact(details.taskId === request.taskId && gate.gateName === 'static-analysis' && gate.passed === true
    && details.verdict === 'pass' && details.skipped !== true
    && details.worktree === input.args.worktreePath && completion.worktreePath === input.args.worktreePath
    && typeof input.args.worktreePath === 'string' && input.args.worktreePath.length > 0
    && details.head === coordinate.observedHeadCommit && completion.taskId === request.taskId && completion.commit === coordinate.observedHeadCommit,
  'Static-analysis and completion do not prove the selected head');
  requireFact(origin.capsule.settlementContract.scope?.repository === coordinate.repository
    && origin.capsule.settlementContract.taskVerification?.[request.taskId]?.baseCommit === coordinate.rootBaseCommit,
  'Coordinate differs from pinned repository or base');
  const relevant = new Set([...ancestors(origin, request.taskId), ...ancestors(current, request.taskId)]);
  for (const taskId of relevant) {
    const before = taskTerms(origin, taskId); const now = taskTerms(current, taskId);
    if (before === undefined || now === undefined || !same(before, now)) throw new StandingFault('invalidated', 'Task or blocker execution terms changed');
  }
  if (invalidated(request.rows, relevant, origin.selection.sequence, completeRow.sequence)) throw new StandingFault('invalidated', 'A later failure or revision invalidated the task');
  const originRow = request.rows.find(row => row.sequence === origin.selection.sequence);
  requireFact(originRow !== undefined, 'Prepared origin row disappeared');
  selected.push(...held.rows, ...effects, originRow);
  const blockers = origin.capsule.graph.dependencies.filter(edge => edge.to === request.taskId).map(edge => edge.from);
  requireFact(blockers.length === 0 ? coordinate.diffBaseCommit === coordinate.rootBaseCommit
    : z.record(z.string(), z.unknown()).parse(input.args.result).forkCommit === coordinate.diffBaseCommit,
  'Coordinate diff base differs from the pinned root or caller fork');
  requireFact(same(coordinate.blockers.map(proof => proof.taskId), blockers), 'Coordinate omits or reorders direct blocker proofs');
  const blockerChecks: StandingProof['recheck'][] = [];
  for (const blocker of coordinate.blockers) {
    if (blocker.kind === 'provisional') requireFact(blocker.outerOperationId === outerId, 'Provisional blocker belongs to another operation');
    const { provisional: _provisional, pinnedProvisional: _pinned, acceptedOperationId: _accepted, ...childRequest } = request;
    const resolved = await resolveTaskStanding({ ...childRequest, taskId: blocker.taskId,
      ...(blocker.kind === 'provisional' ? { pinnedProvisional: { outerOperationId: outerId, capsule: identity } } : { acceptedOperationId: blocker.outerOperationId }) });
    if ((resolved.kind !== 'accepted' && resolved.kind !== 'provisional') || !same(resolved.proof.reference, blocker)) {
      throw new StandingFault('invalidated', 'The pinned blocker proof is no longer eligible');
    }
    blockerChecks.push(resolved.proof.recheck);
  }
  const ownCheck = fence(request, claims, selected, relevant, origin.selection.sequence, completeRow.sequence);
  return { taskId: request.taskId, headCommit: coordinate.observedHeadCommit, coordinate, outerOperationId: outerId,
    segmentOperationId: segmentId, segmentRecordSequence: terminal.sequence,
    segmentRecord: { eventId: z.string().min(1).parse(terminal.eventId), sequence: terminal.sequence, timestamp: terminal.timestamp }, completionSequence: completeRow.sequence,
    staticAnalysisSequence: staticRow.sequence, worktreePath: input.args.worktreePath, runBundle: ref,
    recheck: (rows, lookup) => ownCheck(rows, lookup) && blockerChecks.every(check => check(rows, lookup)) };
}

/** Discover actual accepted claims from rows, then authenticate each link before exporting standing. */
export async function resolveTaskStanding(request: StandingRequest): Promise<StandingResult> {
  try {
    requireFact(request.rows.every(row => row.streamId === request.streamId), 'Standing snapshot contains another stream');
    if (request.pinnedProvisional !== undefined && request.lookupClaim(request.pinnedProvisional.outerOperationId) !== undefined) {
      const { pinnedProvisional, provisional: _provisional, ...acceptedRequest } = request;
      const accepted = await resolveTaskStanding({ ...acceptedRequest, acceptedOperationId: pinnedProvisional.outerOperationId });
      if (accepted.kind !== 'accepted' || accepted.proof.reference?.kind !== 'accepted'
        || accepted.proof.segmentOperationId !== verificationOperationId(pinnedProvisional.outerOperationId, request.taskId)) {
        throw new StandingFault('invalidated', 'The terminal outer operation did not accept this pinned provisional blocker');
      }
      const { outerRecordSequence: _record, settlementBundle: _bundle, ...reference } = accepted.proof.reference;
      return { kind: 'provisional', proof: { ...accepted.proof, outerOperationId: pinnedProvisional.outerOperationId,
        reference: { ...reference, kind: 'provisional', outerOperationId: pinnedProvisional.outerOperationId } } };
    }
    const selection = selectPreparedAuthority(request.rows, request.streamId);
    if (selection === undefined) throw new StandingFault('missing', 'No prepared authority exists');
    const current = await loadPreparedCustody(selection, request.bundles);
    requireFact(current.kind === 'typed', 'Current standing requires approved typed custody');
    let promotion: { operationId: string; receipt: z.infer<typeof SettlementReceiptData>; bundle: SettlementBundleV1;
      row: StandingRow; ref: z.infer<typeof BundleRefV1Schema>; rows: StandingRow[]; claims: Map<string, string> } | undefined;
    let acceptingDecisionId: string | undefined;
    if (request.acceptedOperationId !== undefined) {
      const held = request.lookupClaim(request.acceptedOperationId);
      if (held !== undefined) {
        const receipt = SettlementReceiptData.parse(held.result);
        if (receipt.operationId === request.acceptedOperationId && receipt.outcome === 'deviation-pending' && (receipt.round ?? 0) === 0) {
          acceptingDecisionId = settlementClaimKey(request.streamId, receipt.capsule, 1);
        }
      }
    }
    const candidates = request.rows.filter(row => request.provisional === undefined && request.pinnedProvisional === undefined && row.type === 'execution.settled').sort((a, b) => b.sequence - a.sequence);
    for (const hint of candidates) {
      const raw = dataOf(hint);
      if (request.acceptedOperationId !== undefined && raw.operationId !== request.acceptedOperationId && raw.operationId !== acceptingDecisionId && promotion?.operationId !== raw.operationId) continue;
      if (!Array.isArray(raw.acceptedTasks) || !raw.acceptedTasks.includes(request.taskId)) continue;
      requireFact(typeof raw.operationId === 'string', 'Settlement hint has no operation identity');
      const accepting = promotion?.operationId === raw.operationId ? promotion : undefined;
      const claims = new Map<string, string>(accepting?.claims);
      const held = terminalRows(request, raw.operationId, claims);
      if (held === undefined) continue;
      const receipt = SettlementReceiptData.parse(held.claim.result);
      requireFact(receipt.operationId === raw.operationId && receipt.streamId === request.streamId && receipt.requestDigest === held.claim.requestDigest
        && settlementClaimKey(request.streamId, receipt.capsule, receipt.round ?? 0) === raw.operationId, 'Outer claim identity mismatch');
      const terminals = held.rows.filter(row => row.type === 'execution.settled');
      requireFact(terminals.length === 1 && terminals[0]?.sequence === hint.sequence, 'Settlement row is not the actual claim member');
      const record = ExecutionSettledData.parse(hint.data);
      requireFact(record.requestDigest === held.claim.requestDigest && record.outcome === receipt.outcome
        && same(record.acceptedTasks, receipt.acceptedTasks) && same(record.bundleRefs, receipt.bundleRefs)
        && record.capsuleVersion === receipt.capsule.capsuleVersion && record.batchId === receipt.capsule.batchId
        && record.workflowId === receipt.capsule.workflowId && record.definitionVersion === receipt.capsule.definitionVersion
        && (record.round ?? 0) === (receipt.round ?? 0), 'Settlement record differs from its claim');
      if (receipt.outcome !== 'settled' && receipt.outcome !== 'accepted-with-rationale' && receipt.outcome !== 'corrective-capsule'
        && !(accepting !== undefined && receipt.outcome === 'deviation-pending' && (receipt.round ?? 0) === 0)) continue;
      const ref = BundleRefV1Schema.parse(record.bundleRefs[0]);
      const bundle = decodeSettlementBundle(await request.bundles.resolve(ref.digest));
      requireFact(bundle.operationId === receipt.operationId && bundle.streamId === request.streamId && bundle.requestDigest === held.claim.requestDigest
        && same(bundle.capsule, receipt.capsule) && bundle.outcome === receipt.outcome && same(bundle.acceptedTasks, receipt.acceptedTasks)
        && (bundle.round ?? 0) === (receipt.round ?? 0), 'Settlement custody differs from its actual claim');
      const recoveredDigest = bundle.round === undefined
        ? canonicalRequestDigest({ streamId: request.streamId, identity: bundle.capsule, claims: bundle.claims, deviations: bundle.deviations })
        : canonicalRequestDigest({ streamId: request.streamId, identity: bundle.capsule, round: bundle.round, decisions: bundle.decisions });
      requireFact(recoveredDigest === held.claim.requestDigest, 'Settlement custody does not reproduce its request digest');
      const traces = bundle.verification?.filter(trace => trace.taskId === request.taskId) ?? [];
      requireFact(traces.length === 1, 'Accepted task has no unique verification trace');
      const trace = traces[0];
      requireFact(trace !== undefined, 'Missing verification trace');
      if (request.acceptedOperationId !== undefined && raw.operationId === acceptingDecisionId && trace.outcome !== 'already-complete') continue;
      if (trace.outcome === 'already-complete') {
        if (receipt.round === 1) {
          requireFact(bundle.decisions !== undefined && bundle.decisions.length > 0, 'Accepting decision has no decisions');
          promotion = { operationId: settlementClaimKey(request.streamId, receipt.capsule), receipt, bundle, row: hint, ref, rows: held.rows, claims };
        }
        continue;
      }
      if (accepting !== undefined) {
        requireFact(same(receipt.capsule, accepting.receipt.capsule) && receipt.pendingDeviations !== undefined
          && same([...receipt.pendingDeviations.map(item => item.deviationId)].sort(), [...(accepting.bundle.decisions ?? []).map(item => item.deviationId)].sort())
          && new Set((accepting.bundle.decisions ?? []).map(item => item.deviationId)).size === accepting.bundle.decisions?.length,
        'Accepting decision does not resolve the actual held batch');
      }
      requireFact(trace.outcome === 'verified', 'Accepted task has a failed verification');
      const taskClaims = bundle.claims.filter(claim => claim.taskId === request.taskId && claim.status === undefined);
      requireFact(taskClaims.length === 1, 'Verified task has no unique completed caller claim');
      const proof = await segmentProof(request, current, receipt.capsule, receipt.operationId, claims,
        [...held.rows, ...(accepting?.rows ?? [])], { ...trace, fields: taskClaims[0]?.fields });
      const acceptance = accepting?.receipt ?? receipt;
      return { kind: 'accepted', proof: { ...proof, outerOperationId: acceptance.operationId,
        reference: { kind: 'accepted', taskId: request.taskId, headCommit: proof.headCommit,
          capsule: proof.coordinate.capsule, outerOperationId: acceptance.operationId,
          outerRecordSequence: accepting?.row.sequence ?? hint.sequence, settlementBundle: accepting?.ref ?? ref,
          segmentOperationId: proof.segmentOperationId, segmentRecord: proof.segmentRecord, runBundle: proof.runBundle,
          completionSequence: proof.completionSequence, staticAnalysisSequence: proof.staticAnalysisSequence } } };
    }
    const provisional = request.pinnedProvisional ?? request.provisional;
    if (provisional !== undefined) {
      const { outerOperationId, capsule } = provisional;
      requireFact(settlementClaimKey(request.streamId, capsule) === outerOperationId
        || settlementClaimKey(request.streamId, capsule, 1) === outerOperationId, 'Provisional outer identity mismatch');
      const claims = new Map<string, string>();
      if (request.pinnedProvisional === undefined && request.lookupClaim(outerOperationId) !== undefined) throw new StandingFault('missing', 'A terminal outer outcome cannot grant provisional standing');
      const proof = await segmentProof(request, current, capsule, outerOperationId, claims, []);
      const check = proof.recheck;
      return { kind: 'provisional', proof: { ...proof, reference: { kind: 'provisional', taskId: proof.taskId, headCommit: proof.headCommit,
        capsule: proof.coordinate.capsule, outerOperationId, segmentOperationId: proof.segmentOperationId, segmentRecord: proof.segmentRecord,
        runBundle: proof.runBundle, completionSequence: proof.completionSequence, staticAnalysisSequence: proof.staticAnalysisSequence },
        recheck: (rows, lookup) => (request.pinnedProvisional !== undefined || lookup(outerOperationId) === undefined) && check(rows, lookup) } };
    }
    throw new StandingFault('missing', 'No eligible accepted origin exists for this task');
  } catch (error) {
    return { kind: error instanceof StandingFault ? error.kind : 'corrupt', code: 'MISSING_ACCEPTED_STANDING',
      message: error instanceof Error ? error.message : String(error) };
  }
}
