/** Actual claims and custody authenticate standing. Copied records remain discovery hints only.
 * @oracle-sources: SQLite operation claim membership, immutable prepared/run/settlement custody, persisted effect rows and explicit per-node read budgets.
 */
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, requestDigest as canonicalRequestDigest } from '../../src/contract/request-context.js';
import { capsuleDigest, contentDigest } from '../../src/contract/capsule/capsule-digest.js';
import { profiledValidCapsule } from '../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { encodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { TaskVerificationCoordinateSchema } from '../../src/contract/capsule/exarchos-capsule.js';
import { EventStore } from '../../src/events/store.js';
import { ExecutionSettledData, OrchestrateIntentExecutedData, type WorkflowEvent } from '../../src/events/schemas.js';
import { ArtifactIdSchema } from '../../src/workflow/admission/types.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import { encodeExecuteIntentBundle } from '../../src/verbs/execute/run-bundle.js';
import { encodeSettlementBundle, type SettlementBundleV1 } from '../../src/verbs/settle/settlement-bundle.js';
import { fixture as preparedFixture, prepared, task, textOf } from '../helpers/capsule/prepared-authority.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const HEAD = 'b'.repeat(40);
const ROOT = 'a'.repeat(40);
const TIME = '2026-11-14T00:00:00.000Z';
const closes: (() => Promise<void>)[] = [];

/** Baseline source lacks the resolver, which yields no proof rather than an import failure. */
async function resolver() {
  try { return await import('../../src/verbs/settle/task-standing.js'); }
  catch (error) {
    if (error instanceof Error && /Cannot find module|Failed to load url|ERR_MODULE_NOT_FOUND/.test(error.message)) return undefined;
    throw error;
  }
}

afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

/** Independent key fixtures preserve the exact preexisting operation identity formulas. */
function keys(streamId: string, capsule: { workflowId: string; capsuleVersion: number }, batchId: string, taskId: string) {
  const outer = `settle:${createHash('sha256').update(canonicalJson({ streamId, workflowId: capsule.workflowId, capsuleVersion: capsule.capsuleVersion, batchId })).digest('hex')}`;
  return { outer, segment: `settle-task:${createHash('sha256').update(`${outer}\u0000${taskId}`).digest('hex')}` };
}

/** The fixture stores complete approved custody, real leaf appends and actual terminal operation claims. */
async function setup(chain = false, graph?: Readonly<Record<string, readonly string[]>>) {
  const root = makeTempDir('standing-proof-');
  const events = new EventStore(root); await events.initialize();
  closes.push(async () => { events.close(); await rmrfAsync(root); });
  const dependencies = graph ?? { root: [], child: ['root'], spare: chain ? ['child'] : [] };
  const taskIds = Object.keys(dependencies);
  const text = textOf(taskIds.map(id => task(id, { blockedBy: [...(dependencies[id] ?? [])] })));
  const bundle = preparedFixture(text);
  const streamId = bundle.capsule.identity.workflowId;
  const read = readDesignRecord(Buffer.from(text), bundle.designRecord?.reference ?? 'plan.md');
  if (read.kind !== 'typed') throw new Error('Invalid fixture plan');
  const capsule = bundle.capsule;
  capsule.provenance.compilerVersion = 'exarchos-prepare-8';
  capsule.graph.tasks = read.snapshot.tasks.map(entry => ({ taskId: entry.id, title: entry.title, stepId: 'delegate',
    stage: { kind: 'task-batch', stepId: 'delegate' }, taskContext: {
      taskId: entry.id, title: entry.title, instructions: entry.instructions, files: [...entry.files], testFiles: [...entry.testFiles],
      acceptance: [...entry.acceptance], riskTier: entry.riskTier, boundaryTouching: entry.boundaryTouching, testLayer: entry.testLayer,
      blockedBy: [...entry.blockedBy], resultContractRef: entry.id,
      source: { reference: read.snapshot.reference, digest: read.snapshot.digest, span: { ...entry.span } },
      knowledgeSlice: { invariantIds: [], adrRefs: [], symbols: [], files: [] },
    } }));
  capsule.graph.dependencies = Object.entries(dependencies).flatMap(([to, parents]) => parents.map(from => ({ from, to })));
  capsule.graph.joins = Object.entries(dependencies).filter(([, parents]) => parents.length > 1)
    .map(([id, parents]) => ({ joinId: `join-${id}`, forTaskId: id, waitsFor: [...parents], mode: 'all' }));
  capsule.contracts.taskInputs = {};
  capsule.contracts.taskResults = Object.fromEntries(taskIds.map(id => [id,
    (dependencies[id]?.length ?? 0) > 0 ? [{ name: 'forkCommit', type: 'string' as const, required: true }] : [{ name: 'passed', type: 'boolean' as const, required: true }],
  ]));
  capsule.settlementContract = { ...profiledValidCapsule().settlementContract, requiredResults: taskIds, skipPhases: [],
    verificationMode: 'immutable-task-diff-v1', scope: { repository: '/repo/.git', checkout: '/repo', configDigest: 'c'.repeat(64) },
    taskVerification: Object.fromEntries(taskIds.map(id => [id, { riskTier: 'low', boundaryTouching: false, baseRef: 'main', baseCommit: ROOT }])) };
  const preparedDigest = await events.bundleStore.put(encodePreparedBundle(bundle));
  const initial = prepared(bundle);
  await events.append(streamId, { type: 'workflow.prepared', schemaVersion: '1.0', timestamp: TIME, data: {
    ...initial.data, capsuleDigest: capsuleDigest(capsule), bundleRefs: [{ artifactId: 'run-bundle:prepared', digest: preparedDigest }],
  } });
  const backend = events.getAppender().ensureSqliteBackendSync();
  const lookup = (operationId: string) => backend.lookupOperationClaim(operationId);
  const input = async (taskId = 'root') => ({ streamId, taskId, rows: await events.query(streamId), lookupClaim: lookup, bundles: events.bundleStore });
  const resolve = async (taskId = 'root') => (await resolver())?.resolveTaskStanding(await input(taskId));
  const append = async (type: string, data: Record<string, unknown>) => events.append(streamId, { type, timestamp: TIME, data });
  const batchSegments = new Map<string, { claim: SettlementBundleV1['claims'][number]; trace: NonNullable<SettlementBundleV1['verification']>[number] }[]>();
  const commit = async (options: { batch?: string; taskId?: string; outer?: boolean; outcome?: 'settled' | 'corrective-capsule' | 'deviation-pending'; head?: string; legacy?: boolean; provisional?: boolean; acceptBatch?: boolean; roundZero?: boolean; blockers?: ReturnType<typeof TaskVerificationCoordinateSchema.parse>['blockers'] } = {}) => {
    const batch = options.batch ?? 'accepted'; const taskId = options.taskId ?? 'root'; const head = options.head ?? HEAD;
    const identity = { ...capsule.identity, batchId: batch }; const ids = keys(streamId, identity, batch, taskId);
    const blockerId = dependencies[taskId]?.[0];
    const prior = blockerId === undefined || options.blockers !== undefined ? undefined : options.provisional
      ? await (await resolver())?.resolveTaskStanding({ ...await input(blockerId), provisional: { outerOperationId: ids.outer, capsule: identity } })
      : await resolve(blockerId);
    const blockers = options.blockers ?? ((prior?.kind === 'accepted' || prior?.kind === 'provisional') && prior.proof.reference !== undefined ? [prior.proof.reference] : []);
    const coordinate = TaskVerificationCoordinateSchema.parse({ protocolVersion: '1', taskId, capsule: capsule.identity,
      repository: '/repo/.git', rootBaseCommit: ROOT, diffBaseCommit: blockerId !== undefined ? HEAD : ROOT, observedHeadCommit: head, blockers });
    const args = JSON.parse(canonicalJson({ taskId, capsuleVersion: capsule.identity.capsuleVersion, worktreePath: '/repo/task', result: { passed: true, worktreePath: '/repo/task', ...(blockerId !== undefined ? { forkCommit: HEAD } : {}) }, coordinate }));
    const requestDigest = `sha256:${createHash('sha256').update(JSON.stringify({ intent: 'task-completion', streamId,
      args: Object.keys(args).sort().map(key => [key, args[key]]) })).digest('hex')}`;
    const gate = await append('gate.executed', { gateName: 'static-analysis', layer: 'L1', passed: true,
      details: { taskId, head, worktree: '/repo/task', verdict: 'pass' } });
    const completion = await append('task.completed', { taskId, commit: head, worktreePath: '/repo/task' });
    const leaves = [
      { action: 'check_static_analysis', status: 'passed' as const, events: [{ type: 'gate.executed', streamId, sequence: gate.sequence }] },
      { action: 'task_complete', status: 'passed' as const, events: [{ type: 'task.completed', streamId, sequence: completion.sequence }] },
    ];
    const interaction = { leavesExecuted: 2, eventsAppended: 2, requests: 1, deferred: [] };
    const run = { bundleVersion: '1.0' as const, kind: 'execute-intent-run' as const, operationId: ids.segment, streamId,
      intent: 'task-completion', requestDigest, outcome: 'committed' as const, tailSequence: completion.sequence, interaction,
      ...(options.legacy ? {} : { input: { intent: 'task-completion', streamId, args } }),
      leaves: leaves.map((leaf, index) => ({ index, action: leaf.action, tool: 'exarchos_orchestrate', onFail: 'stop' as const,
        observationStreamId: streamId, args: { taskId }, events: leaf.events, startedAt: TIME, endedAt: TIME,
        disposition: { kind: 'invoked' as const, handler: { success: true } }, verdict: { status: leaf.status } })),
    };
    const runDigest = await events.bundleStore.put(encodeExecuteIntentBundle(run));
    const runRef = { artifactId: ArtifactIdSchema.parse('run-bundle:segment'), digest: runDigest };
    const receipt = { operationId: ids.segment, intent: run.intent, outcome: run.outcome, leaves, tailSequence: completion.sequence, requestDigest, interaction, bundleRefs: [runRef] };
    await events.getAppender().decideOnce(ids.segment, requestDigest, () => ({ streamId, events: [{ type: 'orchestrate.intent_executed', timestamp: TIME, schemaVersion: '1.0',
      data: OrchestrateIntentExecutedData.parse({ operationId: ids.segment, intent: run.intent, outcome: run.outcome, requestDigest,
        bundleRefs: [runRef], leaves: leaves.map(leaf => ({ action: leaf.action, status: leaf.status, sequences: leaf.events.map(event => event.sequence) })) }) }], result: receipt }));
    const outcome = options.outcome ?? 'settled';
    const census = { claims: 1, requiredResults: 1, fields: 1, evidence: 0, deviations: 0, verification: 1 };
    let claims: SettlementBundleV1['claims'] = [{ taskId, fields: { passed: true, worktreePath: '/repo/task', ...(blockerId !== undefined ? { forkCommit: HEAD } : {}) }, evidence: [] }];
    const trace = { taskId, outcome: 'verified' as const, operationId: ids.segment, bundleRefs: [runRef], treeCommit: head, coordinate };
    const previous = batchSegments.get(batch) ?? [];
    previous.push({ claim: { taskId, fields: claims[0]?.fields ?? {}, evidence: [] }, trace }); batchSegments.set(batch, previous);
    if (options.acceptBatch) claims = previous.map(entry => entry.claim);
    const verification = options.acceptBatch ? previous.map(entry => entry.trace) : [trace];
    const acceptedTasks = claims.map(claim => claim.taskId);
    const outerDigest = canonicalRequestDigest({ streamId, identity, claims, deviations: [] });
    const settlement = { bundleVersion: '1.0' as const, kind: 'settlement-adjudication' as const, operationId: ids.outer, streamId,
      requestDigest: outerDigest, capsule: identity, outcome, acceptedTasks, findings: [], claims, deviations: [], adjudicated: census,
      verification, settledAt: TIME };
    const outerRef = { artifactId: ArtifactIdSchema.parse('run-bundle:settlement'), digest: await events.bundleStore.put(encodeSettlementBundle(settlement)) };
    if (options.outer !== false) await events.getAppender().decideOnce(ids.outer, outerDigest, () => ({ streamId, events: [{ type: 'execution.settled', timestamp: TIME, schemaVersion: '1.0',
      data: ExecutionSettledData.parse({ operationId: ids.outer, workflowId: streamId, capsuleVersion: capsule.identity.capsuleVersion,
        definitionVersion: capsule.identity.definitionVersion, batchId: batch, outcome, acceptedTasks, findingCounts: [], adjudicated: census,
        requestDigest: outerDigest, bundleRefs: [outerRef] }) }],
      result: { operationId: ids.outer, streamId, capsule: identity, ...(options.roundZero ? { round: 0 } : {}), outcome, acceptedTasks, findings: [], adjudicated: census,
        requestDigest: outerDigest, tailSequence: completion.sequence + 2, verification, bundleRefs: [outerRef],
        ...(outcome === 'deviation-pending' ? { pendingDeviations: [{ deviationId: 'held-change', deviationKind: 'implementation', statement: 'Held choice' }] } : {}) } }));
    return { ...ids, identity, gate, completion, outerRef, runRef, settlement };
  };
  return { events, streamId, bundle, capsule, input, resolve, commit, append, lookup };
}

type StoredStanding = Awaited<ReturnType<typeof setup>>;
type WrittenStanding = Awaited<ReturnType<StoredStanding['commit']>>;
type BlockerReference = ReturnType<typeof TaskVerificationCoordinateSchema.parse>['blockers'][number];

/** References come from actual persisted identities, never from the resolver under measurement. */
async function writtenReference(s: StoredStanding, written: WrittenStanding, kind: 'accepted' | 'provisional'): Promise<BlockerReference> {
  const claim = s.lookup(written.segment);
  const rows = await s.events.query(s.streamId);
  const terminal = rows.find(row => row.sequence === claim?.sequences[0]);
  if (terminal === undefined || !('eventId' in terminal) || typeof terminal.eventId !== 'string') throw new Error('Missing actual segment member');
  const common = { taskId: written.settlement.claims.at(-1)?.taskId ?? '', headCommit: written.settlement.verification?.at(-1)?.treeCommit ?? HEAD,
    capsule: s.capsule.identity, outerOperationId: written.outer, segmentOperationId: written.segment,
    segmentRecord: { eventId: terminal.eventId, sequence: terminal.sequence, timestamp: terminal.timestamp },
    runBundle: written.runRef, completionSequence: written.completion.sequence, staticAnalysisSequence: written.gate.sequence };
  if (kind === 'provisional') return { kind, ...common };
  const outer = s.lookup(written.outer);
  if (outer?.sequences[0] === undefined) throw new Error('Missing actual outer member');
  return { kind, ...common, outerRecordSequence: outer.sequences[0], settlementBundle: written.outerRef };
}

/** Each new task depends on the previous two: linear stored edges and exponentially many paths. */
async function reconvergentFixture(count: number, provisional: boolean) {
  const ids = Array.from({ length: count }, (_, index) => `node-${index}`);
  const graph = Object.fromEntries(ids.map((id, index) => [id, ids.slice(Math.max(0, index - 2), index)]));
  const s = await setup(false, graph); const refs = new Map<string, BlockerReference>();
  const written = new Map<string, WrittenStanding>();
  for (const id of ids) {
    const blockers = (graph[id] ?? []).map(parent => { const ref = refs.get(parent); if (ref === undefined) throw new Error('Fixture is not topological'); return ref; });
    const node = await s.commit({ taskId: id, batch: provisional ? 'shared' : id, outer: !provisional, blockers });
    written.set(id, node); refs.set(id, await writtenReference(s, node, provisional ? 'provisional' : 'accepted'));
  }
  const target = ids.at(-1); if (target === undefined) throw new Error('Empty graph');
  const last = written.get(target); if (last === undefined) throw new Error('Missing terminal task');
  return { ...s, ids, graph, refs, written, target, last };
}

/**
 * Sticky limits bound old-source failure unwinding. Every admitted call delegates to real custody.
 * Each selection needs prepared, run and outer loads plus claim checks. Sixteen calls per node leave headroom.
 */
function countedStanding(input: Awaited<ReturnType<StoredStanding['input']>>, nodes: number) {
  const budget = nodes * 16; let reads = 0; let claims = 0; let exceeded = false;
  const step = () => { if (exceeded || reads + claims > budget) { exceeded = true; throw new Error('Standing work budget exceeded'); } };
  return { budget, counts: () => ({ reads, claims, exceeded }), input: { ...input,
    lookupClaim: (id: string) => { step(); claims += 1; return input.lookupClaim(id); },
    bundles: { resolve: async (...args: Parameters<typeof input.bundles.resolve>) => { step(); reads += 1; return input.bundles.resolve(...args); } },
  } };
}

describe('authenticated task standing', () => {
  it('AcceptedSubset_ExactHeadAndPureFence', async () => {
    const s = await setup(); const committed = await s.commit(); const result = await s.resolve();
    expect(result?.kind, JSON.stringify(result)).toBe('accepted');
    if (result?.kind !== 'accepted') return;
    expect(result.proof.headCommit).toBe(HEAD);
    const selected = await s.events.query(s.streamId);
    const changed = selected.map(row => row.sequence === committed.completion.sequence ? { ...row, data: { ...row.data, commit: 'f'.repeat(40) } } : row);
    expect(result.proof.recheck(changed, s.lookup)).toBe(false);
    expect(result.proof.reference).toMatchObject({ outerOperationId: committed.outer, segmentOperationId: committed.segment,
      completionSequence: committed.completion.sequence, staticAnalysisSequence: committed.gate.sequence });
    await s.append('task.completed', { taskId: 'spare', commit: 'e'.repeat(40) });
    expect(result.proof.recheck(await s.events.query(s.streamId), s.lookup)).toBe(true);
    await s.append('task.failed', { taskId: 'root', error: 'reopened' });
    expect(result.proof.recheck(await s.events.query(s.streamId), s.lookup)).toBe(false);
    expect((await s.resolve())?.kind).toBe('invalidated');
  });

  it('BareCompletion_AndOrphanBundle_NoStanding', async () => {
    const s = await setup(); await s.append('task.completed', { taskId: 'root', commit: HEAD });
    expect((await s.resolve())?.kind).toBe('missing');
    await s.commit({ outer: false });
    expect((await s.resolve())?.kind).toBe('missing');
  });

  it('OuterCommitFailed_OnlySameOperation', async () => {
    const s = await setup(); const commit = await s.commit({ outer: false }); const module = await resolver();
    const result = await module?.resolveTaskStanding({ ...await s.input(), provisional: { outerOperationId: commit.outer, capsule: commit.identity } });
    expect(result?.kind).toBe('provisional');
    expect((await s.resolve())?.kind).toBe('missing');
    const identity = { ...commit.identity, batchId: 'another' };
    expect((await module?.resolveTaskStanding({ ...await s.input(), provisional: { outerOperationId: keys(s.streamId, identity, 'another', 'root').outer, capsule: identity } }))?.kind).toBe('missing');
  });

  it('CopiedRows_NoActualClaim_AndHeldOutcome_NoExport', async () => {
    const s = await setup(); await s.commit(); const module = await resolver();
    expect((await module?.resolveTaskStanding({ ...await s.input(), lookupClaim: () => undefined }))?.kind).toBe('missing');
    const held = await setup(); await held.commit({ outcome: 'deviation-pending' });
    expect((await held.resolve())?.kind).toBe('missing');
  });

  it('TerminalClaimMembership_RejectsEveryChangedEnvelopeField', async () => {
    const s = await setup(); const commit = await s.commit(); const module = await resolver(); const input = await s.input();
    for (const operationId of [commit.outer, commit.segment]) for (const key of ['eventIds', 'sequences', 'timestamps', 'streamId', 'requestDigest'] as const) {
      const lookupClaim = (id: string) => {
        const claim = s.lookup(id); if (id !== operationId || claim === undefined) return claim;
        return { ...claim, [key]: key === 'eventIds' ? ['other'] : key === 'sequences' ? [999] : key === 'timestamps' ? ['other'] : 'other' };
      };
      expect((await module?.resolveTaskStanding({ ...input, lookupClaim }))?.kind, `${operationId}:${key}`).toBe('corrupt');
    }
  });

  it('LeafEffects_MissingForeignHeadAndPath_Refuse', async () => {
    const s = await setup(); const commit = await s.commit(); const module = await resolver(); const input = await s.input();
    for (const fault of ['missing', 'foreign', 'head', 'path', 'task']) {
      const rows = input.rows.flatMap(row => {
        if (row.sequence !== commit.completion.sequence) return [row];
        if (fault === 'missing') return [];
        const changed: WorkflowEvent = { ...row, ...(fault === 'foreign' ? { streamId: 'other' } : {}),
          data: { ...row.data, ...(fault === 'head' ? { commit: 'e'.repeat(40) } : {}), ...(fault === 'path' ? { worktreePath: '/other' } : {}),
            ...(fault === 'task' ? { taskId: 'spare' } : {}) } };
        return [changed];
      });
      expect((await module?.resolveTaskStanding({ ...input, rows }))?.kind, fault).toBe('corrupt');
    }
  });

  it('LaterGatePolicySkip_PreservesProof_ButActualFailureInvalidates', async () => {
    const s = await setup(); await s.commit();
    await s.append('gate.executed', { gateName: 'mock-boundary', layer: 'L1', passed: false, details: { taskId: 'root', verdict: 'indeterminate', skipped: true } });
    expect((await s.resolve())?.kind).toBe('accepted');
    await s.append('gate.executed', { gateName: 'static-analysis', layer: 'L1', passed: false, details: { taskId: 'root', verdict: 'fail' } });
    expect((await s.resolve())?.kind).toBe('invalidated');
  });

  it('LaterForeignCompletion_CannotReplaceOriginalHead', async () => {
    const s = await setup(); await s.commit(); await s.append('task.completed', { taskId: 'root', commit: 'e'.repeat(40), worktreePath: '/other' });
    const result = await s.resolve(); expect(result?.kind, JSON.stringify(result)).toBe('accepted');
    if (result?.kind === 'accepted') expect(result.proof.headCommit).toBe(HEAD);
  });

  it('MissingInputAndCustody_RefuseWithoutLegacyFallback', async () => {
    const s = await setup(); await s.commit({ legacy: true }); expect((await s.resolve())?.kind).toBe('corrupt');
    const good = await setup(); const valid = await good.commit(); const module = await resolver();
    expect((await module?.resolveTaskStanding({ ...await good.input(), bundles: { resolve: async digest => {
      if (digest.value === valid.runRef.digest.value) throw new Error('Missing run custody');
      return good.events.bundleStore.resolve(digest);
    } } }))?.kind).toBe('corrupt');
    expect((await module?.resolveTaskStanding({ ...await good.input(), bundles: { resolve: async digest => {
      if (digest.value === valid.runRef.digest.value) return Buffer.from('{}');
      return good.events.bundleStore.resolve(digest);
    } } }))?.kind).toBe('corrupt');
  });
  it('Revision_InvalidatesDescendantsAndPreservesUnrelatedStanding', async () => {
    const s = await setup(); const root = await s.commit(); await s.commit({ taskId: 'child', batch: 'child' });
    await s.commit({ taskId: 'spare', batch: 'spare' });
    await s.append('design.revised', { operationId: 'revision', workflowId: s.streamId,
      capsuleVersion: s.capsule.identity.capsuleVersion, batchId: 'revision', priorDesignVersion: 1, nextDesignVersion: 2,
      deviationIds: ['revise-root'], affectedTasks: ['root'], bundleRefs: [root.outerRef] });
    expect((await s.resolve('root'))?.kind).toBe('invalidated');
    expect((await s.resolve('child'))?.kind).toBe('invalidated');
    expect((await s.resolve('spare'))?.kind).toBe('accepted');
  });

  it('ChangedPreparedTaskSemantics_InvalidateOnlyItsDescendants', async () => {
    for (const change of ['instructions', 'definition', 'skips', 'unchanged']) {
      const s = await setup(); await s.commit(); const module = await resolver(); const original = await s.input();
      const proof = await module?.resolveTaskStanding(original);
      const text = textOf([task('root', change === 'instructions' ? { instructions: 'Changed requirement.' } : {}), task('child', { blockedBy: ['root'] }), task('spare')]);
      const next = structuredClone(s.bundle);
      const read = readDesignRecord(Buffer.from(text), next.designRecord?.reference ?? 'plan.md');
      if (read.kind !== 'typed') throw new Error('Invalid new plan');
      next.designRecord = { reference: read.snapshot.reference, text };
      next.capsule.identity.capsuleVersion += 1;
      next.capsule.provenance.sources = next.capsule.provenance.sources.map(source => source.sourceId === 'design-record' ? { ...source, digest: read.snapshot.digest } : source);
      for (const node of next.capsule.graph.tasks) {
        const entry = read.snapshot.tasks.find(task => task.id === node.taskId);
        if (entry === undefined || node.taskContext === undefined) throw new Error('Missing context');
        node.taskContext.instructions = entry.instructions;
        node.taskContext.source = { reference: read.snapshot.reference, digest: read.snapshot.digest, span: { ...entry.span } };
      }
      if (change === 'skips') next.capsule.settlementContract.skipPhases = ['review'];
      if (change === 'definition') {
        next.definition = { ...next.definition, steps: next.definition.steps.map(step => ({ ...step, stepName: `${step.stepName} changed` })) };
        next.capsule.identity.definitionVersion = contentDigest(next.definition);
        next.capsule.provenance.sources = next.capsule.provenance.sources.map(source => source.sourceId === 'workflow-definition'
          ? { ...source, digest: contentDigest(next.definition) } : source);
      }
      const digest = await s.events.bundleStore.put(encodePreparedBundle(next));
      const row = prepared(next);
      await s.append('workflow.prepared', { ...row.data, bundleRefs: [{ artifactId: 'run-bundle:next', digest }] });
      const result = await s.resolve();
      expect(result?.kind, `${change}: ${JSON.stringify(result)}`).toBe(change === 'unchanged' ? 'accepted' : 'invalidated');
      if (proof?.kind === 'accepted') expect(proof.proof.recheck(await s.events.query(s.streamId), s.lookup)).toBe(false);
    }
  });

  it('AlreadyComplete_RequiresAnAuthenticatedEarlierOrigin', async () => {
    for (const initialOutcome of ['settled', 'deviation-pending'] satisfies ('settled' | 'deviation-pending')[]) {
      const s = await setup(); const original = await s.commit({ outcome: initialOutcome });
      const identity = { ...s.capsule.identity, batchId: 'again' }; const ids = keys(s.streamId, identity, 'again', 'root');
      const requestDigest = canonicalRequestDigest({ streamId: s.streamId, identity, claims: original.settlement.claims, deviations: [] });
      const verification = [{ taskId: 'root', outcome: 'already-complete' as const }];
      const bundle = { ...original.settlement, outcome: 'settled' as const, operationId: ids.outer, capsule: identity, requestDigest, verification };
      const ref = { artifactId: ArtifactIdSchema.parse('run-bundle:again'), digest: await s.events.bundleStore.put(encodeSettlementBundle(bundle)) };
      await s.events.getAppender().decideOnce(ids.outer, requestDigest, () => ({ streamId: s.streamId,
        events: [{ type: 'execution.settled', schemaVersion: '1.0', timestamp: TIME,
          data: ExecutionSettledData.parse({ operationId: ids.outer, workflowId: s.streamId, capsuleVersion: identity.capsuleVersion,
            definitionVersion: identity.definitionVersion, batchId: identity.batchId, outcome: 'settled', acceptedTasks: ['root'],
            findingCounts: [], adjudicated: bundle.adjudicated, requestDigest, bundleRefs: [ref] }) }],
        result: { operationId: ids.outer, streamId: s.streamId, capsule: identity, outcome: 'settled', acceptedTasks: ['root'], findings: [],
          adjudicated: bundle.adjudicated, requestDigest, tailSequence: 9, verification, bundleRefs: [ref] } }));
      const result = await s.resolve(); expect(result?.kind, JSON.stringify(result)).toBe(initialOutcome === 'settled' ? 'accepted' : 'missing');
      if (result?.kind === 'accepted') expect(result.proof.reference?.outerOperationId).toBe(original.outer);
      const module = await resolver();
      expect((await module?.resolveTaskStanding({ ...await s.input(), lookupClaim: id => id === original.outer ? undefined : s.lookup(id) }))?.kind).toBe('missing');
    }
  });

  it('StandingFence_ModelIgnoresUnrelatedRowsAndRejectsRelevantFailure', async () => {
    const s = await setup(); await s.commit(); const result = await s.resolve(); const input = await s.input();
    expect(result?.kind).toBe('accepted'); if (result?.kind !== 'accepted') return;
    fc.assert(fc.property(fc.integer({ min: 1, max: 30 }), count => {
      const tail = Math.max(...input.rows.map(row => row.sequence));
      const extras = Array.from({ length: count }, (_, index) => ({ streamId: s.streamId, sequence: tail + index + 1,
        timestamp: TIME, eventId: `extra-${index}`, type: 'task.failed', data: { taskId: 'spare', error: 'unrelated' } }));
      expect(result.proof.recheck([...input.rows, ...extras], s.lookup)).toBe(true);
      const last = extras.at(-1); if (last === undefined) throw new Error('Missing generated row');
      expect(result.proof.recheck([...input.rows, ...extras.slice(0, -1), { ...last, data: { taskId: 'root', error: 'relevant' } }], s.lookup)).toBe(false);
    }), { seed: 192704, numRuns: 20 });
  });

  it('AcceptedDecision_OnlyItsActualHeldRoundCanSupplyTheSegment', async () => {
    const s = await setup(); const held = await s.commit({ outcome: 'deviation-pending' });
    expect((await s.resolve())?.kind).toBe('missing');
    const identity = held.identity; const round = 1;
    const outer = `settle:${createHash('sha256').update(canonicalJson({ streamId: s.streamId, workflowId: identity.workflowId,
      capsuleVersion: identity.capsuleVersion, batchId: identity.batchId, round })).digest('hex')}`;
    const decisions = [{ deviationId: 'held-change', decision: 'accepted' as const, actor: 'user', rationale: 'Approved' }];
    const requestDigest = canonicalRequestDigest({ streamId: s.streamId, identity, round, decisions });
    const verification = [{ taskId: 'root', outcome: 'already-complete' as const }];
    const bundle = { ...held.settlement, operationId: outer, requestDigest, outcome: 'settled' as const, round, decisions, verification };
    const ref = { artifactId: ArtifactIdSchema.parse('run-bundle:decision'), digest: await s.events.bundleStore.put(encodeSettlementBundle(bundle)) };
    await s.events.getAppender().decideOnce(outer, requestDigest, () => ({ streamId: s.streamId,
      events: [{ type: 'execution.settled', schemaVersion: '1.0', timestamp: TIME,
        data: ExecutionSettledData.parse({ operationId: outer, workflowId: s.streamId, capsuleVersion: identity.capsuleVersion,
          definitionVersion: identity.definitionVersion, batchId: identity.batchId, round, outcome: 'settled', acceptedTasks: ['root'],
          findingCounts: [], adjudicated: bundle.adjudicated, requestDigest, bundleRefs: [ref] }) }],
      result: { operationId: outer, streamId: s.streamId, capsule: identity, round, outcome: 'settled', acceptedTasks: ['root'], findings: [],
        adjudicated: bundle.adjudicated, requestDigest, tailSequence: 9, verification, bundleRefs: [ref] } }));
    const result = await s.resolve(); expect(result?.kind, JSON.stringify(result)).toBe('accepted');
    if (result?.kind === 'accepted') expect(result.proof.reference).toMatchObject({ outerOperationId: outer, segmentOperationId: held.segment });
    const module = await resolver();
    expect((await module?.resolveTaskStanding({ ...await s.input(), lookupClaim: id => id === held.outer ? undefined : s.lookup(id) }))?.kind).toBe('missing');
  });

  /** An accepted ancestor and same-operation provisional parent retain distinct proof modes after outer acceptance. */
  it('MixedBlockerModes_PinnedProvisionalSurvivesOuterAcceptance', async () => {
    const s = await setup(true); await s.commit({ batch: 'earlier' });
    const child = await s.commit({ batch: 'current', taskId: 'child', outer: false });
    const module = await resolver();
    const provisional = await module?.resolveTaskStanding({ ...await s.input('child'), provisional: { outerOperationId: child.outer, capsule: child.identity } });
    expect(provisional?.kind, JSON.stringify(provisional)).toBe('provisional');
    if (provisional?.kind !== 'provisional') return;
    expect(provisional.proof.coordinate.blockers[0]?.kind).toBe('accepted');
    expect(provisional.proof.reference).not.toHaveProperty('outerRecordSequence');
    expect(provisional.proof.reference).not.toHaveProperty('settlementBundle');
    const spare = await s.commit({ batch: 'current', taskId: 'spare', provisional: true, acceptBatch: true });
    expect(spare.settlement.verification).toHaveLength(2);
    const accepted = await s.resolve('spare'); expect(accepted?.kind, JSON.stringify(accepted)).toBe('accepted');
    if (accepted?.kind !== 'accepted') return;
    expect(accepted.proof.coordinate.blockers[0]).toEqual(provisional.proof.reference);
    expect(accepted.proof.recheck(await s.events.query(s.streamId), s.lookup)).toBe(true);
    const laterChild = await s.resolve('child'); expect(laterChild?.kind).toBe('accepted');
    if (laterChild?.kind === 'accepted') expect(laterChild.proof.reference?.kind).toBe('accepted');
  });

  /** A copied provisional reference cannot authorize another outer operation, even with a valid segment and head. */
  it('ProvisionalBlocker_WrongOuterRefuses', async () => {
    const s = await setup(true); await s.commit({ batch: 'earlier' });
    const child = await s.commit({ batch: 'current', taskId: 'child', outer: false }); const module = await resolver();
    const proof = await module?.resolveTaskStanding({ ...await s.input('child'), provisional: { outerOperationId: child.outer, capsule: child.identity } });
    expect(proof?.kind).toBe('provisional');
    if (proof?.kind === 'provisional') expect(proof.proof.reference?.kind).toBe('provisional');
    if (proof?.kind !== 'provisional' || proof.proof.reference === undefined) return;
    await s.commit({ batch: 'other', taskId: 'spare', blockers: [proof.proof.reference] });
    const result = await s.resolve('spare'); expect(result?.kind).toBe('corrupt');
    if (result?.kind === 'corrupt') expect(result.message).toContain('another operation');
  });

  /** A revised old acceptance cannot shadow the explicitly requested fresh same-outer segment. */
  it('ExplicitProvisional_IgnoresRevisedPriorAcceptance', async () => {
    const s = await setup(); const old = await s.commit();
    const same = await s.commit({ batch: 'fresh-before-revision', outer: false }); const currentModule = await resolver();
    expect((await s.resolve())?.kind).toBe('accepted');
    const sameOuter = await currentModule?.resolveTaskStanding({ ...await s.input(), provisional: { outerOperationId: same.outer, capsule: same.identity } });
    expect(sameOuter?.kind).toBe('provisional');
    if (sameOuter?.kind === 'provisional') expect(sameOuter.proof.segmentOperationId).toBe(same.segment);
    await s.append('design.revised', { operationId: 'revision-new', workflowId: s.streamId,
      capsuleVersion: 1, batchId: 'revision-new', priorDesignVersion: 1, nextDesignVersion: 2,
      deviationIds: ['revise-root'], affectedTasks: ['root'], bundleRefs: [old.outerRef] });
    s.capsule.identity.capsuleVersion += 1;
    const digest = await s.events.bundleStore.put(encodePreparedBundle(s.bundle)); const next = prepared(s.bundle);
    await s.events.append(s.streamId, { type: 'workflow.prepared', schemaVersion: '1.0', timestamp: TIME,
      data: { ...next.data, capsuleDigest: capsuleDigest(s.capsule), bundleRefs: [{ artifactId: 'run-bundle:revised', digest }] } });
    const current = await s.commit({ batch: 'revised', outer: false }); const module = await resolver();
    expect((await s.resolve())?.kind).toBe('invalidated');
    const exact = await module?.resolveTaskStanding({ ...await s.input(), provisional: { outerOperationId: current.outer, capsule: current.identity } });
    expect(exact?.kind, JSON.stringify(exact)).toBe('provisional');
    if (exact?.kind === 'provisional') expect(exact.proof.reference?.outerOperationId).toBe(current.outer);
  });

  /** A real accepting decision promotes its held batch without rewriting an already pinned provisional blocker coordinate. */
  it('HeldPromotion_PreservesPinnedProvisionalHistory', async () => {
    const s = await setup(true); await s.commit({ batch: 'ancestor' });
    const child = await s.commit({ batch: 'held', taskId: 'child', outer: false }); const module = await resolver();
    const pinned = await module?.resolveTaskStanding({ ...await s.input('child'), provisional: { outerOperationId: child.outer, capsule: child.identity } });
    expect(pinned?.kind).toBe('provisional'); if (pinned?.kind !== 'provisional') return;
    const held = await s.commit({ batch: 'held', taskId: 'spare', provisional: true, acceptBatch: true, outcome: 'deviation-pending', roundZero: true });
    const identity = held.identity; const round = 1;
    const outer = `settle:${createHash('sha256').update(canonicalJson({ streamId: s.streamId, workflowId: identity.workflowId,
      capsuleVersion: identity.capsuleVersion, batchId: identity.batchId, round })).digest('hex')}`;
    const decisions = [{ deviationId: 'held-change', decision: 'accepted' as const, actor: 'user', rationale: 'Approved' }];
    const requestDigest = canonicalRequestDigest({ streamId: s.streamId, identity, round, decisions });
    const verification = ['child', 'spare'].map(taskId => ({ taskId, outcome: 'already-complete' as const }));
    const bundle = { ...held.settlement, operationId: outer, requestDigest, outcome: 'settled' as const, round, decisions, verification };
    const ref = { artifactId: ArtifactIdSchema.parse('run-bundle:promotion'), digest: await s.events.bundleStore.put(encodeSettlementBundle(bundle)) };
    await s.events.getAppender().decideOnce(outer, requestDigest, () => ({ streamId: s.streamId,
      events: [{ type: 'execution.settled', schemaVersion: '1.0', timestamp: TIME,
        data: ExecutionSettledData.parse({ operationId: outer, workflowId: s.streamId, capsuleVersion: identity.capsuleVersion,
          definitionVersion: identity.definitionVersion, batchId: identity.batchId, round, outcome: 'settled', acceptedTasks: ['child', 'spare'],
          findingCounts: [], adjudicated: bundle.adjudicated, requestDigest, bundleRefs: [ref] }) }],
      result: { operationId: outer, streamId: s.streamId, capsule: identity, round, outcome: 'settled', acceptedTasks: ['child', 'spare'], findings: [],
        adjudicated: bundle.adjudicated, requestDigest, tailSequence: 20, verification, bundleRefs: [ref] } }));
    const result = await s.resolve('spare'); expect(result?.kind, JSON.stringify(result)).toBe('accepted');
    if (result?.kind === 'accepted') expect(result.proof.coordinate.blockers[0]).toEqual(pinned.proof.reference);
    expect((await module?.resolveTaskStanding({ ...await s.input('spare'), lookupClaim: id => id === held.outer ? undefined : s.lookup(id) }))?.kind).toBe('missing');
  });

  /** Actual thirty-task custody scales by selected nodes rather than exponentially many dependency paths. */
  it('ReconvergentCustody_ThirtyTasksBoundedAcceptedAndProvisional', async () => {
    const module = await resolver(); if (module === undefined) throw new Error('Missing standing resolver');
    for (const count of [30, 6]) for (const provisional of [false, true]) {
      const s = await reconvergentFixture(count, provisional);
      expect(s.capsule.graph.tasks).toHaveLength(count);
      expect(s.capsule.graph.dependencies).toHaveLength(2 * count - 3);
      const measured = countedStanding(await s.input(s.target), count);
      const result = await module.resolveTaskStanding({ ...measured.input,
        ...(provisional ? { provisional: { outerOperationId: s.last.outer, capsule: s.last.identity } } : {}) });
      expect(result.kind, JSON.stringify({ count, provisional, result, counts: measured.counts() })).toBe(provisional ? 'provisional' : 'accepted');
      expect(measured.counts().exceeded).toBe(false);
      expect(measured.counts().reads + measured.counts().claims).toBeLessThanOrEqual(measured.budget);
      if (result.kind !== 'accepted' && result.kind !== 'provisional') throw new Error('No authenticated proof');
      expect(result.proof.reference).toEqual(s.refs.get(s.target));
      const rows = await s.events.query(s.streamId); let fenceReads = 0;
      const fenceBudget = count * 8;
      expect(result.proof.recheck(rows, id => {
        fenceReads += 1; if (fenceReads > fenceBudget) throw new Error('Fence work budget exceeded'); return s.lookup(id);
      })).toBe(true);
      expect(fenceReads).toBeLessThanOrEqual(fenceBudget);
      const root = s.written.get(s.ids[0] ?? ''); if (root === undefined) throw new Error('Missing shared ancestor');
      expect(result.proof.recheck(rows, id => id === root.segment ? undefined : s.lookup(id))).toBe(false);
      expect(result.proof.recheck(rows, s.lookup)).toBe(true);
      const damaged = rows.map(row => row.sequence === root.completion.sequence ? { ...row, data: { ...row.data, commit: 'e'.repeat(40) } } : row);
      expect(result.proof.recheck(damaged, s.lookup)).toBe(false);
      expect(result.proof.recheck(rows, s.lookup)).toBe(true);
      const fresh = await module.resolveTaskStanding({ ...await s.input(s.target), lookupClaim: id => id === root.segment ? undefined : s.lookup(id),
        ...(provisional ? { provisional: { outerOperationId: s.last.outer, capsule: s.last.identity } } : {}) });
      expect(['accepted', 'provisional']).not.toContain(fresh.kind);
    }
  });

  /** One traversal must retain two authentic selections of the same task and compare every named reference. */
  it('SharedAncestor_DistinctOuterModesAndNamedReferences', async () => {
    const module = await resolver(); if (module === undefined) throw new Error('Missing standing resolver');
    for (const reverse of [false, true]) for (const mixed of [false, true]) {
      const s = await setup(false, { root: [], left: ['root'], right: ['root'], tip: reverse ? ['right', 'left'] : ['left', 'right'] });
      const old = await s.commit({ taskId: 'root', batch: 'old', blockers: [] });
      const oldRef = await writtenReference(s, old, 'accepted');
      const current = await s.commit({ taskId: 'root', batch: 'current', outer: !mixed, blockers: [] });
      const currentRef = await writtenReference(s, current, mixed ? 'provisional' : 'accepted');
      const left = await s.commit({ taskId: 'left', batch: mixed ? 'current' : 'left', outer: !mixed, blockers: [oldRef] });
      const right = await s.commit({ taskId: 'right', batch: mixed ? 'current' : 'right', outer: !mixed, blockers: [currentRef] });
      const refs = [await writtenReference(s, left, mixed ? 'provisional' : 'accepted'), await writtenReference(s, right, mixed ? 'provisional' : 'accepted')];
      if (reverse) refs.reverse();
      const tip = await s.commit({ taskId: 'tip', batch: mixed ? 'current' : 'tip', outer: !mixed, blockers: refs });
      const input = await s.input('tip');
      const malformed = { ...input }; const cyclic = { value: 'invalid-selector' };
      Reflect.set(cyclic, 'cycle', cyclic); Reflect.set(malformed, 'acceptedOperationId', cyclic);
      expect((await module.resolveTaskStanding(malformed)).kind).toBe('corrupt');
      const result = await module.resolveTaskStanding({ ...input, ...(mixed ? { provisional: { outerOperationId: tip.outer, capsule: tip.identity } } : {}) });
      expect(result.kind, JSON.stringify({ reverse, mixed, result })).toBe(mixed ? 'provisional' : 'accepted');
      if (result.kind !== 'accepted' && result.kind !== 'provisional') throw new Error('Missing exact selection');
      expect(result.proof.coordinate.blockers).toEqual(refs);
      expect(result.proof.recheck(input.rows, id => id === old.segment ? undefined : s.lookup(id))).toBe(false);
      expect(result.proof.recheck(input.rows, id => id === current.segment ? undefined : s.lookup(id))).toBe(false);
      expect(result.proof.recheck(input.rows, s.lookup)).toBe(true);
    }
  });

  /** Cached selector equality never substitutes for the exact stored blocker reference comparison. */
  it('SharedAncestor_FullNamedReferenceDamageRefusesInEitherOrder', async () => {
    const changes: readonly { name: string; apply: (ref: BlockerReference) => BlockerReference }[] = [
      { name: 'head', apply: ref => ({ ...ref, headCommit: 'e'.repeat(40) }) },
      { name: 'member-id', apply: ref => ({ ...ref, segmentRecord: { ...ref.segmentRecord, eventId: 'foreign-member' } }) },
      { name: 'member-sequence', apply: ref => ({ ...ref, segmentRecord: { ...ref.segmentRecord, sequence: ref.segmentRecord.sequence + 1 } }) },
      { name: 'member-timestamp', apply: ref => ({ ...ref, segmentRecord: { ...ref.segmentRecord, timestamp: '2026-11-15T00:00:00.000Z' } }) },
      { name: 'run-bundle', apply: ref => ({ ...ref, runBundle: { ...ref.runBundle, digest: { ...ref.runBundle.digest, value: 'e'.repeat(64) } } }) },
      { name: 'static', apply: ref => ({ ...ref, staticAnalysisSequence: ref.staticAnalysisSequence + 1 }) },
      { name: 'completion', apply: ref => ({ ...ref, completionSequence: ref.completionSequence + 1 }) },
      { name: 'capsule', apply: ref => ({ ...ref, capsule: { ...ref.capsule, capsuleVersion: ref.capsule.capsuleVersion + 1 } }) },
    ];
    for (const reverse of [false, true]) for (const change of changes) {
      const s = await setup(false, { root: [], left: ['root'], right: ['root'], tip: reverse ? ['right', 'left'] : ['left', 'right'] });
      const root = await s.commit({ taskId: 'root', batch: 'origin', blockers: [] });
      const reference = await writtenReference(s, root, 'accepted');
      const left = await s.commit({ taskId: 'left', batch: 'left', blockers: [reference] });
      const right = await s.commit({ taskId: 'right', batch: 'right', blockers: [change.apply(reference)] });
      const blockers = [await writtenReference(s, left, 'accepted'), await writtenReference(s, right, 'accepted')];
      if (reverse) blockers.reverse();
      await s.commit({ taskId: 'tip', batch: 'tip', blockers });
      const result = await s.resolve('tip');
      expect(result?.kind, `${change.name}, reversed=${reverse}: ${JSON.stringify(result)}`).toBe('invalidated');
    }
  });

});
