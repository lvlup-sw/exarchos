/** Typed preparation binds approved file bytes, ledger completion, and the accepted phase policy. */
import { createHash } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { coerceFlags } from '../../src/adapters/cli/schema-to-flags.js';
import { decodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import type { ExarchosConfig } from '../../src/config/define.js';
import { handleDescribe } from '../../src/describe/handler.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, runWithDispatchContext } from '../../src/dispatch/dispatch-context.js';
import { WorkflowPreparedData } from '../../src/events/schemas.js';
import { EventStore } from '../../src/events/store.js';
import { toEnvelope, type ToolResult } from '../../src/format.js';
import { buildRegistrationSchema, TOOL_REGISTRY } from '../../src/registry.js';
import { zodToJsonSchema } from '../../src/utils/json-schema.js';
import { handlePrepare, type PrepareDeps } from '../../src/verbs/prepare/handler.js';
import type { PreparedCapsuleReceipt } from '../../src/verbs/prepare/types.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { loadPreparedCustody, selectPreparedAuthority } from '../../src/workflow/capsule/prepared-custody.js';
import * as designReader from '../../src/workflow/design-record/read.js';
import * as designValidation from '../../src/workflow/design-record/validate.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { task, textOf } from '../helpers/capsule/prepared-authority.js';

const STREAM = 'typed-prepare';
const REF = 'design.md';
const A = 'T-01';
const B = 'T-1';
const BASE = 'codex/integration';
const HEAD = 'a'.repeat(40);
const CAPS = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos'];
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function compile(text: string, overrides: Record<string, unknown> = {}) {
  return { mode: 'compile', designRef: REF, approval: { decision: 'approved', designDigest: digest(text) }, ...overrides };
}

async function fixture(options: { readonly empty?: boolean; readonly withBranch?: boolean; readonly legacy?: boolean; readonly config?: ExarchosConfig; readonly workflowType?: string } = {}) {
  const root = makeTempDir('prepare-typed-');
  cleanup.push(() => rmrfAsync(root));
  const checkout = path.join(root, 'checkout');
  await mkdir(checkout);
  const stateDir = path.join(root, 'state');
  const events = new EventStore(stateDir);
  await events.initialize();
  cleanup.push(() => events.close());

  const patch = (values: Record<string, unknown>) => events.append(STREAM, { type: 'state.patched', data: { patch: values } });
  if (options.empty !== true) {
    if (options.legacy === true) {
      await events.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: options.workflowType ?? 'feature' } });
      await events.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
    } else {
      await events.append(STREAM, { type: 'workflow.started', schemaVersion: '1.1',
        data: { featureId: STREAM, workflowType: options.workflowType ?? 'feature', initialPhase: 'delegate' } });
    }
    await patch({
      ...(options.withBranch === false ? {} : { 'synthesis.integrationBranch': BASE }),
      'artifacts.plan': 'projected-plan.md',
      tasks: [{ id: 'fake', title: 'Projected task', status: 'pending', riskTier: 'high' }],
    });
  }

  const deps: PrepareDeps = {
    now: () => '2026-11-13T00:00:00.000Z',
    catalogInvariants: () => [],
    scopeGit: {
      observe: async () => ({ kind: 'repository', toplevel: checkout, repository: path.join(checkout, '.git') }),
      commitOf: async (_checkout, ref) => ref.startsWith('refs/tags/') ? { kind: 'absent' } : { kind: 'commit', commit: HEAD },
      isAncestor: async () => ({ kind: 'ancestor' }),
    },
  };
  const context: DispatchContext = { stateDir, eventStore: events, enableTelemetry: false, ...(options.config ? { config: options.config } : {}) };
  const call = (intent?: unknown, overrides: PrepareDeps = {}, capabilities = CAPS) => {
    const identity = deriveMcpCallerIdentity({ sessionId: 'prepare-typed' });
    const dispatch = mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(capabilities)));
    return runWithDispatchContext(dispatch, () => handlePrepare(
      { featureId: STREAM, repoRoot: checkout, ...(intent === undefined ? {} : { intent }) },
      stateDir, context, { ...deps, ...overrides },
    ));
  };
  const write = (text: string, ref = REF) => writeFile(path.join(checkout, ref), text);
  return { root, checkout, events, patch, call, write, deps };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function receipt(result: ToolResult): PreparedCapsuleReceipt {
  expect(result.success, JSON.stringify(result.error)).toBe(true);
  return result.data as PreparedCapsuleReceipt;
}

function ids(result: PreparedCapsuleReceipt): string[] {
  return result.capsule.graph.tasks.map((entry) => entry.taskId);
}

function source(result: PreparedCapsuleReceipt) {
  return result.capsule.provenance.sources.filter(({ sourceId }) => sourceId === 'design-record');
}

async function refuse(s: Fixture, intent: unknown, code: string, overrides?: PrepareDeps, capabilities?: string[]) {
  const rows = await s.events.query(STREAM);
  const put = vi.spyOn(s.events.bundleStore, 'putThenReference');
  const claim = vi.spyOn(s.events.getAppender(), 'decideOnce');
  try {
    const result = await s.call(intent, overrides, capabilities);
    expect(result).toMatchObject({ success: false, error: { code } });
    expect(await s.events.query(STREAM)).toEqual(rows);
    expect(put).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    return result;
  } finally {
    claim.mockRestore();
    put.mockRestore();
  }
}

describe('typed prepare', () => {
  it('Prepare_ApprovalAndParser_ShareBytes', async () => {
    const s = await fixture();
    const text = '\uFEFF' + textOf([task(A, { title: 'Misleading task 999' })]).replaceAll('\n', '\r\n');
    const changed = textOf([task(B)]);
    await s.write(text);
    const read = designReader.readDesignRecordAt;
    const capture = vi.spyOn(designReader, 'readDesignRecordAt').mockImplementationOnce(async (...args) => {
      const snapshot = await read(...args);
      await s.write(changed);
      return snapshot;
    });
    const compiled = receipt(await s.call(compile(text)));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(ids(compiled)).toEqual([A]);
    expect(source(compiled)).toEqual([{ sourceId: 'design-record', digest: digest(text) }]);
    const selection = selectPreparedAuthority(await s.events.query(STREAM), STREAM);
    expect(selection?.record.planRecordDigest).toBe(digest(text));
    if (selection === undefined) throw new Error('Missing prepared authority');
    const stored = await loadPreparedCustody(selection, s.events.bundleStore);
    expect(stored.kind).toBe('typed');
    expect(stored.designRecord).toEqual({ reference: REF, text });
    await refuse(s, compile(text), 'DESIGN_APPROVAL_MISMATCH');
  });

  it('Prepare_MountedDocsPath_Works', async () => {
    const s = await fixture();
    const mounted = path.join(s.root, 'docs-repository');
    const text = textOf([task(A)]);
    await mkdir(mounted);
    await writeFile(path.join(mounted, REF), text);
    await symlink(mounted, path.join(s.checkout, 'docs'), 'dir');
    const result = receipt(await s.call(compile(text, { designRef: 'docs/../docs/design.md' })));
    expect(ids(result)).toEqual([A]);
    expect(source(result)[0]?.digest).toBe(digest(text));
  });

  it('Prepare_LexicalEscape_Refuses', async () => {
    const s = await fixture();
    const text = textOf([task(A)]);
    await writeFile(path.join(s.root, REF), text);
    await s.write(text);
    await refuse(s, compile(text, { designRef: '../design.md' }), 'PLAN_UNSOUND');
    await refuse(s, compile(text, { designRef: path.join(s.checkout, REF) }), 'PLAN_UNSOUND');
    await refuse(s, compile(text, { designRef: 'C:\\checkout\\design.md' }), 'PLAN_UNSOUND');
  });

  it('Prepare_TypedThenLegacy_RefusesDowngrade', async () => {
    const s = await fixture({ legacy: true });
    const text = textOf([task(A)]);
    await s.write(text);
    await s.patch({ 'artifacts.plan': REF });
    await refuse(s, undefined, 'PREPARE_INTENT_REQUIRED');
    await s.write('## Technical Design\n### Legacy requirement\n', 'prose.md');
    await s.patch({ 'artifacts.plan': path.join(s.checkout, 'prose.md') });
    const legacy = receipt(await s.call());
    expect(legacy.capsule.settlementContract.skipPhases).toEqual([]);
    expect(ids(legacy)).toEqual(['fake']);
    const typed = receipt(await s.call(compile(text)));
    expect(typed.capsuleVersion).toBe(2);
    await refuse(s, undefined, 'PREPARE_INTENT_REQUIRED');
    const rows = (await s.events.query(STREAM)).filter(({ type }) => type === 'workflow.prepared');
    const [first, second] = rows.map(({ data }) => WorkflowPreparedData.parse(data));
    expect(first?.planRecordDigest).toBeUndefined();
    expect(second?.planRecordDigest).toBe(digest(text));
    const ref = first?.bundleRefs[0];
    if (ref === undefined) throw new Error('Missing legacy bundle ref');
    expect(decodePreparedBundle(await s.events.bundleStore.resolve(ref.digest)).designRecord).toBeUndefined();
  });

  it('Prepare_ChangedApprovedBytes_CompilesNext', async () => {
    const s = await fixture();
    const text = textOf([task(A)]);
    await s.write(text);
    const first = receipt(await s.call(compile(text)));
    const changed = text + '\nRevised rationale.\n';
    await s.write(changed);
    await refuse(s, compile(text), 'DESIGN_APPROVAL_MISMATCH');
    const next = receipt(await s.call(compile(changed)));
    expect(next.capsuleVersion).toBe(first.capsuleVersion + 1);
    expect(next.operationId).not.toBe(first.operationId);
    expect(next.capsule.identity.designVersion).toBe(first.capsule.identity.designVersion);
    expect(ids(next)).toEqual(ids(first));
    expect(source(next)[0]?.digest).toBe(digest(changed));
    const rows = await s.events.query(STREAM);
    expect(rows.map(({ type }) => type)).not.toContain('design.revised');
    const decide = vi.spyOn(s.events.getAppender(), 'decideOnce');
    await s.write(text);
    expect(receipt(await s.call(compile(text)))).toEqual(first);
    expect(decide).not.toHaveBeenCalled();
    expect(await s.events.query(STREAM)).toEqual(rows);
    expect(selectPreparedAuthority(rows, STREAM)?.record.planRecordDigest).toBe(digest(changed));
  });

  it('Prepare_UnchangedFullInputs_Replays', async () => {
    const s = await fixture({ withBranch: false });
    const text = textOf([task(A)]);
    await s.write(text);
    const first = receipt(await s.call(compile(text, { baseRef: BASE })));
    const resolve = vi.spyOn(s.events.bundleStore, 'resolve').mockRejectedValue(new Error('missing pin'));
    const tail = await s.events.query(STREAM);
    const replay = receipt(await s.call(compile(text, { designDepth: 'standard', workflowType: 'feature' })));
    expect(replay).toEqual(first);
    expect(resolve).not.toHaveBeenCalled();
    expect(await s.events.query(STREAM)).toEqual(tail);
    await refuse(s, compile(text, { designDepth: 'deep' }), 'PREPARED_AUTHORITY_INVALID');
    resolve.mockRestore();
    const changed = receipt(await s.call(compile(text, { designDepth: 'deep' })));
    expect(changed.operationId).not.toBe(first.operationId);
  });

  it('Prepare_DurableRowsAndExactIds_DetermineReadyTasks', async () => {
    const s = await fixture();
    const text = textOf([task(A, { riskTier: 'high', boundaryTouching: true, testFiles: ['test/a.ts'] }),
      task(B, { blockedBy: [A] }), task('later')]);
    await s.write(text);
    const query = vi.spyOn(s.events, 'query');
    const first = receipt(await s.call(compile(text)));
    expect(query).toHaveBeenCalledTimes(1);
    expect(ids(first)).toEqual([A, 'later']);
    expect(first.capsule.settlementContract.taskVerification?.[A]).toMatchObject({ riskTier: 'high', boundaryTouching: true });
    await s.patch({ tasks: [{ id: 'later', status: 'complete' }, { id: B, status: 'complete' }], 'synthesis.integrationBranch': 'forged' });
    await s.events.append(STREAM, { type: 'task.completed', data: { taskId: 'foreign' } });
    await s.events.append(STREAM, { type: 'task.completed', data: { taskId: A, commit: HEAD } });
    await s.events.append(STREAM, { type: 'task.failed', data: { taskId: A, error: 'Failed afterward' } });
    expect(receipt(await s.call(compile(text)))).toEqual(first);
    await s.events.append(STREAM, { type: 'task.completed', data: { taskId: A, commit: HEAD } });
    const ancestor = vi.fn(s.deps.scopeGit?.isAncestor);
    if (s.deps.scopeGit === undefined) throw new Error('Missing scope fixture');
    const next = receipt(await s.call(compile(text, { baseRef: BASE }), { scopeGit: { ...s.deps.scopeGit, isAncestor: ancestor } }));
    expect(ids(next)).toEqual([B, 'later']);
    expect(ancestor).toHaveBeenCalledWith(s.checkout, HEAD, HEAD);
    expect(next.capsule.settlementContract.taskVerification?.[B]?.baseRef).toBe(BASE);
  });

  it('Prepare_WholeGraphRefusesBeforeOverlay_AndFindingsReachEnvelope', async () => {
    const s = await fixture();
    await s.events.append(STREAM, { type: 'task.completed', data: { taskId: A } });
    await s.events.append(STREAM, { type: 'task.completed', data: { taskId: B } });
    const text = textOf([task('ready'), task(A, { title: 'DR-1', implements: ['DR-9'], blockedBy: [B] }), task(B, { blockedBy: [A] })]);
    await s.write(text);
    const result = await refuse(s, compile(text), 'PLAN_UNSOUND');
    expect(toEnvelope(result)).toMatchObject({ error: { code: 'PLAN_UNSOUND', planFindings: expect.arrayContaining([
      expect.objectContaining({ code: 'DEPENDENCY_CYCLE', taskIds: [A, B] }),
      expect.objectContaining({ taskIds: [A], requirementIds: ['DR-9'] }),
    ]) } });
    const malformed = textOf([task(A), task(A)]);
    await s.write(malformed);
    await s.patch({ 'artifacts.plan': REF });
    await refuse(s, compile(malformed), 'PLAN_UNSOUND');
    await refuse(s, undefined, 'PLAN_UNSOUND');
    const unknown = textOf([task('ready'), task(A, { blockedBy: ['unknown'] })]);
    await s.write(unknown);
    const missing = await refuse(s, compile(unknown), 'PLAN_UNSOUND');
    expect(missing.error?.planFindings?.some(({ code }) => code === 'UNKNOWN_DEPENDENCY')).toBe(true);
  });

  it('Prepare_UnsupportedBootstrapTypeBaseAndPolicy_LeaveNoWrites', async () => {
    const s = await fixture();
    const empty = await fixture({ empty: true });
    const text = textOf([task(A)]);
    await s.write(text);
    const bootstrap = compile(text, { mode: 'bootstrap', workflowType: 'feature', baseRef: BASE });
    await refuse(empty, bootstrap, 'BOOTSTRAP_UNSUPPORTED');
    await refuse(s, bootstrap, 'BOOTSTRAP_UNSUPPORTED');
    await refuse(empty, undefined, 'WORKFLOW_NOT_FOUND');
    await refuse(empty, compile(text), 'WORKFLOW_NOT_FOUND');
    await refuse(s, compile(text, { workflowType: 'debug' }), 'INVALID_INPUT');
    await refuse(s, compile(text, { baseRef: 'different' }), 'BASE_UNRESOLVED');
    await refuse(s, compile(text, { facts: {} }), 'INVALID_INPUT');
    await refuse(s, compile(text), 'RUNTIME_UNFIT', {}, []);
    await s.write('workflow:\n  skip-phases: [plan]\n', '.exarchos.yml');
    await refuse(s, compile(text), 'SCOPE_UNRESOLVED');
    await s.write('workflow:\n  skip-phases: [unknown, review, unknown]\n', '.exarchos.yml');
    const first = receipt(await s.call(compile(text)));
    expect(first.capsule.settlementContract.skipPhases).toEqual(['unknown', 'review', 'unknown']);
    await s.write('workflow:\n  skip-phases: [review, unknown, unknown]\n', '.exarchos.yml');
    const reordered = receipt(await s.call(compile(text)));
    expect(reordered.operationId).not.toBe(first.operationId);
    expect(reordered.capsule.settlementContract.skipPhases).toEqual(['review', 'unknown', 'unknown']);
  });

  it('Prepare_CorruptNewerMarker_RefusesEvenOnReplay', async () => {
    const s = await fixture();
    const text = textOf([task(A)]);
    await s.write(text);
    receipt(await s.call(compile(text)));
    const rows = await s.events.query(STREAM);
    const last = rows.at(-1);
    if (last === undefined) throw new Error('Missing prepared row');
    const { planRecordDigest: _removed, ...old } = WorkflowPreparedData.parse(last.data);
    await s.events.append(STREAM, { type: 'workflow.prepared', schemaVersion: '1.0', data: { ...old, capsuleVersion: 2 } });
    await refuse(s, compile(text), 'PREPARED_AUTHORITY_INVALID');
    await refuse(s, undefined, 'PREPARED_AUTHORITY_INVALID');
  });

  it('Prepare_ConfigWorkflowCollision_RefusesBeforeCheckout', async () => {
    const s = await fixture({ workflowType: 'custom-flow', config: { workflows: { 'custom-flow': {} } } as ExarchosConfig });
    const text = textOf([task(A)]);
    const scopeGit = s.deps.scopeGit;
    if (scopeGit === undefined) throw new Error('Missing scope fixture');
    const observe = vi.fn(scopeGit.observe);
    const read = vi.spyOn(designReader, 'readDesignRecordAt');
    await refuse(s, compile(text), 'WORKFLOW_TYPE_UNSUPPORTED', { scopeGit: { ...scopeGit, observe } });
    expect(observe).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('Prepare_ChangedLedgerTail_LeavesOnlyWinnerRows', async () => {
    const s = await fixture();
    const text = textOf([task(A)]);
    await s.write(text);
    const initial = await s.events.query(STREAM);
    const put = s.events.bundleStore.put.bind(s.events.bundleStore);
    const race = vi.spyOn(s.events.bundleStore, 'put').mockImplementationOnce(async (bytes) => {
      await s.events.append(STREAM, { type: 'task.completed', data: { taskId: A } });
      return put(bytes);
    });
    const result = await s.call(compile(text));
    expect(result).toMatchObject({ success: false, error: { code: 'CONCURRENCY_CONFLICT' } });
    expect(race).toHaveBeenCalledTimes(1);
    expect((await s.events.query(STREAM)).slice(initial.length).map(({ type }) => type)).toEqual(['task.completed']);
    await refuse(s, compile(text), 'NOTHING_TO_PREPARE');
  });

  it('Prepare_UnexpectedSoundnessFailure_RefusesBeforeEffects', async () => {
    const s = await fixture();
    const text = textOf([task(A)]);
    await s.write(text);
    vi.spyOn(designValidation, 'validateDesignRecord').mockImplementationOnce(() => { throw new Error('checker failure'); });
    const result = await refuse(s, compile(text), 'INTERNAL_ERROR');
    expect(result.error?.message).toContain('checker failure');
  });

  it('Prepare_IntentSchemaAndFlags_ExposeBothClosedModes', async () => {
    const tool = TOOL_REGISTRY.find(({ name }) => name === 'exarchos_orchestrate');
    const action = tool?.actions.find(({ name }) => name === 'prepare');
    const execute = tool?.actions.find(({ name }) => name === 'execute_intent');
    if (tool === undefined || action === undefined || execute === undefined) throw new Error('Missing orchestrate actions');
    const text = textOf([task(A)]);
    const intent = compile(text);
    const flags = coerceFlags({ repoRoot: '/tmp/checkout', intent: JSON.stringify(intent) }, action.schema);
    expect(action.schema.parse(flags).intent).toEqual(intent);
    expect(action.schema.safeParse({ ...flags, intent: { ...intent, approval: { ...intent.approval, facts: {} } } }).success).toBe(false);
    expect(action.schema.safeParse({ ...flags, intent: { ...intent, mode: 'bootstrap' } }).success).toBe(false);
    const registration = buildRegistrationSchema(tool.actions);
    expect(registration.safeParse({ action: 'prepare', ...flags }).success).toBe(true);
    expect(registration.safeParse({ action: 'execute_intent', intent: 'task-completion' }).success).toBe(true);
    expect(action.schema.safeParse({ ...flags, intent: 'task-completion' }).success).toBe(false);
    expect(execute.schema.safeParse({ intent, args: {} }).error?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['intent'] }),
    ]));
    expect(zodToJsonSchema(registration).properties?.intent).toMatchObject({
      anyOf: expect.arrayContaining([expect.objectContaining({ type: 'string' })]),
    });
    for (const third of [{ ...execute, name: 'third' }, { ...action, name: 'third' }]) {
      for (const actions of [[execute, action, third], [action, execute, third], [third, execute, action],
        [action, third, execute], [execute, third, action], [third, action, execute]]) {
        expect(() => buildRegistrationSchema(actions)).toThrow(/collides/);
      }
    }
    const described = await handleDescribe({ actions: ['prepare'] }, [action]);
    const printed = JSON.stringify(described.data);
    expect(described.success).toBe(true);
    for (const term of ['bootstrap', 'compile', 'designDigest', 'designDepth', 'scopeAssessment', 'additionalProperties']) {
      expect(printed).toContain(term);
    }
  });

  it('Prepare_GeneratedDocumentChangesAndRawBytes_PreserveOnlyApprovedIdentity', async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: 999 }), { minLength: 1, maxLength: 12 }),
      fc.array(fc.record({ id: fc.string(), status: fc.constantFrom('complete', 'pending'), riskTier: fc.constantFrom('low', 'high') })),
      fc.string({ minLength: 1, maxLength: 24 }),
      async (numbers, projected, prose) => {
        const s = await fixture();
        const authored = numbers.map((n) => 'T-' + n.toString().padStart(3, '0'));
        const text = textOf(authored.map((id) => task(id)));
        await s.write(text);
        const first = receipt(await s.call(compile(text)));
        expect(ids(first)).toEqual(authored);
        await s.patch({ tasks: projected, 'artifacts.plan': 'changed-projected-reference.md' });
        const replay = receipt(await s.call(compile(text, { designDepth: 'standard', baseRef: BASE, workflowType: 'feature' })));
        expect(replay).toEqual(first);
        const changed = text + '\n' + JSON.stringify(prose);
        await s.write(changed);
        const next = receipt(await s.call(compile(changed)));
        expect(ids(next)).toEqual(authored);
        expect(source(next)).toEqual([{ sourceId: 'design-record', digest: digest(changed) }]);
        expect(next.operationId).not.toBe(first.operationId);
      },
    ), { numRuns: 20, seed: 192709 });
  });

  it('Prepare_BoundedCompleteCompileBenchmark_ReportsFreshAndReplay', async () => {
    const timings = [];
    const sizes = process.env['EXARCHOS_BENCH_PREPARE_LARGE'] === '1' ? [10, 100, 1000] : [10, 100];
    for (const taskCount of sizes) {
      const s = await fixture();
      const text = textOf(Array.from({ length: taskCount }, (_, n) => task(`T-${n}`)));
      await s.write(text);
      const intent = compile(text);
      const started = performance.now();
      const first = receipt(await s.call(intent));
      const compiled = performance.now();
      const replay = receipt(await s.call(intent));
      const replayed = performance.now();
      expect(ids(first)).toHaveLength(taskCount);
      expect(replay).toEqual(first);
      timings.push({ taskCount, bytes: Buffer.byteLength(text), freshMs: compiled - started, replayMs: replayed - compiled });
    }
    console.info(JSON.stringify(timings));
  });
});
