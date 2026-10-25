// The base of the three diff gates of the task-completion segment.
//
// The runbook binds the capsule `baseRef` to the kill probe, contract drift and mock boundary, and not to static analysis.
// A segment thus measures contract drift and mock boundary from that base, not from `main`.
// A direct run of either gate with no base does not guess one. Contract drift blocks with `base-missing`.
// Mock boundary is advisory, so it reports `base-missing` and does not block.
//
// A pass-through spy over the default git runner records each git call, so a case can name the diff range that a gate read.

import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULTS, type ResolvedProjectConfig } from '../../../../src/config/resolve.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext as HandlerContext } from '../../../../src/dispatch/core/dispatch.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
  type DispatchContext as CorrelationContext,
} from '../../../../src/dispatch/dispatch-context.js';
import { AdmissionEvidenceRecordedData, GateExecutedData } from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { TASK_COMPLETION } from '../../../../src/runbooks/definitions.js';
import type { RunbookStep } from '../../../../src/runbooks/types.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { compileIntent, PRODUCTION_COMPILE_DEPS } from '../../../../src/verbs/execute/compile.js';
import { handleExecuteIntent, productionExecuteDeps } from '../../../../src/verbs/execute/executor.js';
import { selectSubject } from '../../../../src/verbs/gates/durable-gate-producer.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt, withTrustedCaller } from '../../../../tools/test-helpers/trusted-context.js';

/** The argument list of each call of the default git runner, in call order. The spy keeps the real git result. */
const { gitCalls } = vi.hoisted(() => {
  const calls: string[][] = [];
  return { gitCalls: calls };
});

vi.mock('../../../../src/verbs/gates/gate-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/gates/gate-utils.js')>();
  return {
    ...actual,
    defaultGitExec: (repoRoot: string, args: readonly string[]) => {
      gitCalls.push([...args]);
      return actual.defaultGitExec(repoRoot, args);
    },
  };
});

/** The three gates of the segment that measure a diff. */
const DIFF_GATES = ['check_test_adequacy', 'check_contract_drift', 'check_mock_boundary'];

/** The two gates under test in the segment, each with its gate class. */
const MEASURED_GATES: readonly (readonly [string, 'contract-drift' | 'mock-boundary'])[] = [
  ['check_contract_drift', 'contract-drift'],
  ['check_mock_boundary', 'mock-boundary'],
];

/** The integration branch that the task forked from. `main` is one commit behind it. */
const BASE = 'feature/wave';

const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'isolation:worktree', 'mcp:exarchos'];

/** The cheapest npm script that exits 0. */
const OK = 'node -e ""';

let stateDir: string;
let store: EventStore;
const scratchDirs: string[] = [];

beforeEach(async () => {
  gitCalls.splice(0);
  stateDir = await mkdtemp(path.join(tmpdir(), 'segment-gate-base-state-'));
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
  for (const dir of scratchDirs.splice(0)) await rmrfAsync(dir);
});

/** A scratch directory with its real path. The test removes it after each case. */
async function scratchDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

/** True for an object record. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The data record of a result, or an empty record. */
function dataOf(result: ToolResult): Readonly<Record<string, unknown>> {
  return isRecord(result.data) ? result.data : {};
}

/** The evidence records of one stream that one action produced. */
async function evidenceOf(streamId: string, action: string) {
  return (await store.query(streamId, { type: 'admission.evidence-recorded' }))
    .map((row) => AdmissionEvidenceRecordedData.parse(row.data))
    .filter((record) => record.evidence.producer.providerRef === action);
}

/** The `gate.executed` rows of one stream for one gate class, parsed. */
async function signalsOf(streamId: string, gateClass: string) {
  return (await store.query(streamId, { type: 'gate.executed' }))
    .map((row) => GateExecutedData.parse(row.data))
    .filter((row) => row.gateName === gateClass);
}

/** The diff range of each `git diff` call that the spy recorded. */
function diffRanges(): string[] {
  return gitCalls.flatMap((args) => (args[0] === 'diff' ? [args.at(-1) ?? ''] : []));
}

/** A correlation context with a trusted caller identity, as the dispatch entry mints it. */
function correlation(sessionId: string): CorrelationContext {
  return mintDispatchContext(
    undefined,
    snapshotCallerAuthorization(deriveMcpCallerIdentity({ sessionId }), createInMemoryResolver(CAPABILITIES)),
  );
}

/** The dispatch context of one started workflow. */
async function startedWorkflow(featureId: string): Promise<HandlerContext> {
  const ctx = withTrustedCaller({ stateDir, eventStore: store, enableTelemetry: false });
  const init = await dispatch('exarchos_workflow', { action: 'init', featureId, workflowType: 'feature' }, ctx);
  expect(init.success, JSON.stringify(init.error)).toBe(true);
  return ctx;
}

/** The project config that disables the kill probe, so the segment reaches the two gates under test. */
function killProbeDisabled(): ResolvedProjectConfig {
  const entry = { enabled: false, blocking: true, params: {} };
  return {
    ...DEFAULTS,
    review: { ...DEFAULTS.review, gates: { ...DEFAULTS.review.gates, check_test_adequacy: entry } },
  };
}

/**
 * A repository with three branches. `main` holds the first commit. The integration branch adds a prerequisite commit.
 * The task branch adds the task commit and stays checked out. A diff from `main` thus holds the prerequisite file too.
 */
async function taskWorktree(): Promise<string> {
  const dir = await scratchDir('segment-gate-base-worktree-');
  const git = async (args: readonly string[]): Promise<void> => {
    await execFileAsync('git', args, { cwd: dir, timeout: 30_000 });
  };
  const scripts = { 'test:run': 'node --test', lint: OK, typecheck: OK, 'quality-check': OK };
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'segment-gate-base', version: '1.0.0', private: true, scripts }, null, 2),
    'utf-8',
  );
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'answer.mjs'), 'export const answer = 41;\n', 'utf-8');
  await git(['init', '--initial-branch=main', '-q']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'commit.gpgsign', 'false']);
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'base']);
  await git(['checkout', '-q', '-b', BASE]);
  await writeFile(path.join(dir, 'src', 'prior.mjs'), 'export const prior = 1;\n', 'utf-8');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'land the prerequisite']);
  await git(['checkout', '-q', '-b', 'task/segment']);
  await writeFile(path.join(dir, 'src', 'answer.mjs'), 'export const answer = 42;\n', 'utf-8');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'the task change']);
  return dir;
}

/** The status of each leaf of an executor receipt, by action. */
function leafStatuses(result: ToolResult): ReadonlyMap<string, string> {
  const leaves = dataOf(result).leaves;
  return new Map(
    Array.isArray(leaves)
      ? leaves.flatMap((leaf: unknown): [string, string][] =>
          isRecord(leaf) && typeof leaf.action === 'string' && typeof leaf.status === 'string'
            ? [[leaf.action, leaf.status]]
            : [],
        )
      : [],
  );
}

describe('the base of the diff gates in the task-completion segment', () => {
  /** Each diff gate step binds the base placeholder, and the compiled leaf carries the frozen base. Static analysis gets neither. */
  it('SegmentGateBase_TheRunbook_BindsTheBaseToTheThreeDiffGates', () => {
    const steps: readonly RunbookStep[] = TASK_COMPLETION.steps;
    const paramsOf = new Map(steps.map((step) => [step.action, step.params]));
    for (const gate of DIFF_GATES) {
      expect(paramsOf.get(gate), gate).toMatchObject({ baseBranch: '<baseRef>' });
    }
    expect(paramsOf.get('check_static_analysis')).not.toHaveProperty('baseBranch');

    const outcome = compileIntent(
      'task-completion',
      { streamId: 'wf-segment-base' },
      { taskId: 'task-base', worktreePath: '/tmp/agent-wt', riskTier: 'medium', boundaryTouching: true, baseRef: BASE },
      PRODUCTION_COMPILE_DEPS,
    );
    if (!outcome.ok) throw new Error(`expected a segment, got ${outcome.refusal.code}: ${outcome.refusal.message}`);
    const argsOf = new Map(outcome.segment.leaves.map((leaf) => [leaf.action, leaf.args]));
    for (const gate of DIFF_GATES) {
      expect(argsOf.get(gate), gate).toMatchObject({ baseBranch: BASE });
    }
    expect(argsOf.get('check_static_analysis')).not.toHaveProperty('baseBranch');
  });

  /**
   * A boundary-touching medium task runs both gates. Each records its evidence on the subject of the frozen base.
   * The mock-boundary diff reads the range from that base, so the prerequisite commit stays out of it.
   * The config disables the kill probe, so its blocking verdict does not stop the segment before the two gates.
   */
  it('SegmentGateBase_ASegment_MeasuresContractDriftAndMockBoundaryFromTheBase', async () => {
    const streamId = 'segment-gate-base';
    const taskId = 'task-segment';
    const worktreePath = await taskWorktree();
    await seedActivePhaseAttempt(store, streamId);
    const ctx: HandlerContext = {
      stateDir,
      eventStore: store,
      enableTelemetry: false,
      projectConfig: killProbeDisabled(),
    };

    const result = await runWithDispatchContext(correlation('segment-gate-base'), () =>
      handleExecuteIntent(
        {
          intent: 'task-completion',
          streamId,
          args: { taskId, worktreePath, riskTier: 'medium', boundaryTouching: true, baseRef: BASE, result: { worktreePath } },
        },
        stateDir,
        ctx,
        productionExecuteDeps(ACTION_HANDLERS, 'exarchos_orchestrate'),
      ),
    );

    const statuses = leafStatuses(result);
    expect(statuses.get('check_contract_drift')).toBe('passed');
    expect(statuses.get('check_mock_boundary')).toBe('passed');
    for (const [action, gateClass] of MEASURED_GATES) {
      const scope = { gateClass, featureId: streamId, taskId, repoRoot: worktreePath };
      const fromBase = selectSubject({ ...scope, baseRef: BASE }, 'unused');
      const fromMain = selectSubject({ ...scope, baseRef: 'main' }, 'unused');
      expect(fromBase.digest).not.toEqual(fromMain.digest);
      const subjects = (await evidenceOf(streamId, action)).map((record) => record.evidence.subject);
      expect(subjects, action).toEqual([fromBase]);
    }
    expect(diffRanges()).toContain(`${BASE}...HEAD`);
    expect(diffRanges()).not.toContain('main...HEAD');
  }, 120_000);
});

describe('a direct diff-gate run with no base', () => {
  /**
   * The policy runs contract drift for this task, so the base check decides. The run blocks with `base-missing`, and it is not a skip.
   * Its evidence and its signal row are indeterminate. The control: the same run with a base gives no `base-missing`.
   */
  it('ContractDrift_ADirectRunWithNoBase_BlocksWithBaseMissing', async () => {
    const featureId = 'contract-drift-no-base';
    const repoRoot = await scratchDir('segment-gate-base-drift-');
    const ctx = await startedWorkflow(featureId);
    const args = { action: 'check_contract_drift', featureId, repoRoot, riskTier: 'medium', boundaryTouching: true };

    const control = await dispatch('exarchos_orchestrate', { ...args, taskId: 'task-with-base', baseBranch: 'main' }, ctx);
    expect(control.success).toBe(true);
    expect(dataOf(control).discriminant).toBeUndefined();

    const result = await dispatch('exarchos_orchestrate', { ...args, taskId: 'task-no-base' }, ctx);

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(dataOf(result)).toMatchObject({ passed: false, verdict: 'indeterminate', discriminant: 'base-missing' });
    expect(dataOf(result).skipped).toBeUndefined();
    const verdicts = (await evidenceOf(featureId, 'check_contract_drift')).map((record) => record.evidence.verdict);
    expect(verdicts.at(-1)).toBe('indeterminate');
    const rows = await signalsOf(featureId, 'contract-drift');
    expect(rows.at(-1)?.passed).toBe(false);
    expect(rows.at(-1)?.details?.skipped).toBeUndefined();
  }, 60_000);

  /**
   * The policy runs mock boundary for this task, so the base check decides. The run reports `base-missing`, passes, and reads no diff.
   * Its evidence is indeterminate, because it measured nothing. The control: the same run with a base reads the diff from that base.
   */
  it('MockBoundary_ADirectRunWithNoBase_ReportsBaseMissingAndDoesNotBlock', async () => {
    const featureId = 'mock-boundary-no-base';
    const repoRoot = await scratchDir('segment-gate-base-mock-');
    const ctx = await startedWorkflow(featureId);
    const args = { action: 'check_mock_boundary', featureId, repoRoot, riskTier: 'medium', boundaryTouching: true };

    const control = await dispatch('exarchos_orchestrate', { ...args, taskId: 'task-with-base', baseBranch: 'main' }, ctx);
    expect(control.success).toBe(true);
    expect(dataOf(control).discriminant).toBeUndefined();
    expect(diffRanges()).toEqual(['main...HEAD']);

    const result = await dispatch('exarchos_orchestrate', { ...args, taskId: 'task-no-base' }, ctx);

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(dataOf(result)).toMatchObject({ passed: true, findings: [], discriminant: 'base-missing' });
    expect(dataOf(result).skipped).toBeUndefined();
    expect(diffRanges()).toEqual(['main...HEAD']);
    const verdicts = (await evidenceOf(featureId, 'check_mock_boundary')).map((record) => record.evidence.verdict);
    expect(verdicts.at(-1)).toBe('indeterminate');
  }, 60_000);
});
