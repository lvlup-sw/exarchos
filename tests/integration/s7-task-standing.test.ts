/** Actual claims and custody authenticate standing. Copied records remain discovery hints only. */
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
import { encodeSettlementBundle } from '../../src/verbs/settle/settlement-bundle.js';
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
async function setup() {
  const root = makeTempDir('standing-proof-');
  const events = new EventStore(root); await events.initialize();
  closes.push(async () => { events.close(); await rmrfAsync(root); });
  const text = textOf([task('root'), task('child', { blockedBy: ['root'] }), task('spare')]);
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
  capsule.graph.dependencies = [{ from: 'root', to: 'child' }]; capsule.graph.joins = [];
  capsule.contracts.taskInputs = {};
  capsule.contracts.taskResults = Object.fromEntries(['root', 'child', 'spare'].map(id => [id,
    id === 'child' ? [{ name: 'forkCommit', type: 'string' as const, required: true }] : [{ name: 'passed', type: 'boolean' as const, required: true }],
  ]));
  capsule.settlementContract = { ...profiledValidCapsule().settlementContract, requiredResults: ['root', 'child', 'spare'], skipPhases: [],
    verificationMode: 'immutable-task-diff-v1', scope: { repository: '/repo/.git', checkout: '/repo', configDigest: 'c'.repeat(64) },
    taskVerification: Object.fromEntries(['root', 'child', 'spare'].map(id => [id, { riskTier: 'low', boundaryTouching: false, baseRef: 'main', baseCommit: ROOT }])) };
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
  const commit = async (options: { batch?: string; taskId?: string; outer?: boolean; outcome?: 'settled' | 'corrective-capsule' | 'deviation-pending'; head?: string; legacy?: boolean } = {}) => {
    const batch = options.batch ?? 'accepted'; const taskId = options.taskId ?? 'root'; const head = options.head ?? HEAD;
    const identity = { ...capsule.identity, batchId: batch }; const ids = keys(streamId, identity, batch, taskId);
    const prior = taskId === 'child' ? await resolve('root') : undefined;
    const blockers = prior?.kind === 'accepted' && prior.proof.reference !== undefined ? [prior.proof.reference] : [];
    const coordinate = TaskVerificationCoordinateSchema.parse({ protocolVersion: '1', taskId, capsule: capsule.identity,
      repository: '/repo/.git', rootBaseCommit: ROOT, diffBaseCommit: taskId === 'child' ? HEAD : ROOT, observedHeadCommit: head, blockers });
    const args = JSON.parse(canonicalJson({ taskId, capsuleVersion: capsule.identity.capsuleVersion, worktreePath: '/repo/task', result: { passed: true, worktreePath: '/repo/task', ...(taskId === 'child' ? { forkCommit: HEAD } : {}) }, coordinate }));
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
    const claims = [{ taskId, fields: { passed: true, worktreePath: '/repo/task', ...(taskId === 'child' ? { forkCommit: HEAD } : {}) }, evidence: [] }];
    const outerDigest = canonicalRequestDigest({ streamId, identity, claims, deviations: [] });
    const trace = { taskId, outcome: 'verified' as const, operationId: ids.segment, bundleRefs: [runRef], treeCommit: head, coordinate };
    const settlement = { bundleVersion: '1.0' as const, kind: 'settlement-adjudication' as const, operationId: ids.outer, streamId,
      requestDigest: outerDigest, capsule: identity, outcome, acceptedTasks: [taskId], findings: [], claims, deviations: [], adjudicated: census,
      verification: [trace], settledAt: TIME };
    const outerRef = { artifactId: ArtifactIdSchema.parse('run-bundle:settlement'), digest: await events.bundleStore.put(encodeSettlementBundle(settlement)) };
    if (options.outer !== false) await events.getAppender().decideOnce(ids.outer, outerDigest, () => ({ streamId, events: [{ type: 'execution.settled', timestamp: TIME, schemaVersion: '1.0',
      data: ExecutionSettledData.parse({ operationId: ids.outer, workflowId: streamId, capsuleVersion: capsule.identity.capsuleVersion,
        definitionVersion: capsule.identity.definitionVersion, batchId: batch, outcome, acceptedTasks: [taskId], findingCounts: [], adjudicated: census,
        requestDigest: outerDigest, bundleRefs: [outerRef] }) }],
      result: { operationId: ids.outer, streamId, capsule: identity, outcome, acceptedTasks: [taskId], findings: [], adjudicated: census,
        requestDigest: outerDigest, tailSequence: completion.sequence + 2, verification: [trace], bundleRefs: [outerRef],
        ...(outcome === 'deviation-pending' ? { pendingDeviations: [{ deviationId: 'held-change', deviationKind: 'implementation', statement: 'Held choice' }] } : {}) } }));
    return { ...ids, identity, gate, completion, outerRef, runRef, settlement };
  };
  return { events, streamId, bundle, capsule, input, resolve, commit, append, lookup };
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
    const held = await setup(); await held.commit({ outcome: 'corrective-capsule' });
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

});
