/**
 * `prepare` compiles the task-batch step of each built-in definition, and it refuses each other step with its finding.
 *
 * Each case seeds one built-in stream in a phase and calls the handler against a real event store.
 * A seam answers the three git reads of the scope at a temp checkout.
 * The class of each seeded step comes from the table in this file, which is written by hand from the five built-in definition files.
 *
 * @oracle-sources: ../../../../src/verbs/prepare/handler.ts, the class table of the five built-in steps written in this file
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { handlePrepare } from '../../../../src/verbs/prepare/handler.js';
import type { ScopeGit } from '../../../../src/verbs/prepare/prepare-scope.js';
import { canonicalPath } from '../../../../src/utils/git-tree.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

/** The stream of each case. */
const STREAM = 'feat-prepare-steps';

/** The capabilities of a runtime that can settle what it dispatches. */
const FIT_CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'subagent:spawn'];

/** The commit that the seam resolves for the base. */
const BASE_COMMIT = 'c'.repeat(40);

/** The integration branch of each seeded stream. */
const INTEGRATION_BRANCH = 'feat/prepare-steps';

/** Two ready tasks with no blocker. */
const PLAN: readonly Record<string, unknown>[] = [
  { id: 'T-1', title: 'first', status: 'pending', blockedBy: [] },
  { id: 'T-2', title: 'second', status: 'pending', blockedBy: [] },
];

/** One built-in step that prepare refuses, with its type, its finding and the phrases of its message. */
interface RefusedStep {
  readonly workflowType: string;
  readonly phase: string;
  readonly finding: string;
  /** The compilable steps that the message names. An empty list means that the definition has none. */
  readonly compilable: readonly string[];
  readonly singleAgent: boolean;
}

/** The four single-agent steps and one step that is not an implement step, from the five built-in definition files. */
const REFUSED_STEPS: readonly RefusedStep[] = [
  { workflowType: 'refactor', phase: 'polish-implement', finding: 'single-agent-step', compilable: ['overhaul-delegate'], singleAgent: true },
  { workflowType: 'debug', phase: 'debug-implement', finding: 'single-agent-step', compilable: [], singleAgent: true },
  { workflowType: 'debug', phase: 'hotfix-implement', finding: 'single-agent-step', compilable: [], singleAgent: true },
  { workflowType: 'oneshot', phase: 'implementing', finding: 'single-agent-step', compilable: [], singleAgent: true },
  { workflowType: 'discovery', phase: 'gathering', finding: 'not-an-implement-step', compilable: [], singleAgent: false },
];

let stateDir: string;
let store: EventStore;
let checkout: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'prepare-steps-'));
  checkout = canonicalPath(await mkdtemp(path.join(tmpdir(), 'prepare-steps-checkout-')));
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
  await rmrfAsync(checkout);
});

/** True when the value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the value as an object, or throws with its path. */
function recordAt(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${at} is not an object`);
  return value;
}

/** Returns the value as a list, or throws with its path. */
function listAt(value: unknown, at: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at} is not a list`);
  return value;
}

/** Returns the value as a string, or throws with its path. */
function textAt(value: unknown, at: string): string {
  if (typeof value !== 'string') throw new Error(`${at} is not a string`);
  return value;
}

/** The git reads of the scope. The repository is the temp checkout, and the base resolves to {@link BASE_COMMIT}. */
function scopeGit(): ScopeGit {
  return {
    observe: async () => ({ kind: 'repository', toplevel: checkout, repository: `${checkout}/.git` }),
    commitOf: async (_checkout, ref) =>
      ref.startsWith('refs/tags/') ? { kind: 'absent' } : { kind: 'commit', commit: BASE_COMMIT },
    isAncestor: async () => ({ kind: 'ancestor' }),
  };
}

/** The wiring of each call. */
function wiring(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false };
}

/** One `prepare` call of the seeded stream, as a fit runtime. */
async function prepare(): Promise<ToolResult> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'prepare-steps' });
  const context = mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(FIT_CAPABILITIES)));
  return runWithDispatchContext(context, () =>
    handlePrepare({ featureId: STREAM, repoRoot: checkout }, stateDir, wiring(), {
      catalogInvariants: () => [],
      now: () => '2026-11-11T00:00:00.000Z',
      scopeGit: scopeGit(),
    }),
  );
}

/** Seeds one stream of the type in the phase, with an integration branch and two ready tasks. */
async function seed(workflowType: string, phase: string): Promise<void> {
  await store.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType } });
  await store.append(STREAM, { type: 'workflow.transition', data: { from: 'seeded', to: phase } });
  await store.append(STREAM, {
    type: 'state.patched',
    data: { patch: { 'synthesis.integrationBranch': INTEGRATION_BRANCH, tasks: PLAN } },
  });
}

/** The code and the message of a refused call. */
function refusalOf(result: ToolResult): { readonly code: string; readonly message: string } {
  expect(result.success, JSON.stringify(result)).toBe(false);
  if (result.error === undefined) throw new Error('the refused call holds no error');
  return { code: result.error.code, message: result.error.message };
}

/** The number of `workflow.prepared` rows of the stream. */
async function preparedRowCount(): Promise<number> {
  return (await store.query(STREAM)).filter((row) => row.type === 'workflow.prepared').length;
}

/** The number of blobs in the bundle store. */
async function bundleBlobCount(): Promise<number> {
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if ((await stat(full)).isDirectory()) await walk(full);
      else count += 1;
    }
  };
  await walk(store.bundleStore.root);
  return count;
}

describe('prepare compiles the task-batch step of each built-in definition', () => {
  it('PrepareSteps_ARefactorInOverhaulDelegate_CompilesThatStep', async () => {
    await seed('refactor', 'overhaul-delegate');

    const result = await prepare();

    expect(result.success, JSON.stringify(result.error)).toBe(true);
    const capsule = recordAt(recordAt(result.data, 'receipt').capsule, 'capsule');
    const tasks = listAt(recordAt(capsule.graph, 'graph').tasks, 'graph.tasks');
    expect(tasks.map((task, index) => textAt(recordAt(task, `task ${index}`).stepId, `task ${index}.stepId`))).toStrictEqual([
      'overhaul-delegate',
      'overhaul-delegate',
    ]);
    const nonGoals = listAt(recordAt(capsule.intent, 'intent').nonGoals, 'intent.nonGoals');
    expect(nonGoals.map((goal, index) => textAt(recordAt(goal, `nonGoal ${index}`).statement, 'statement'))).toStrictEqual([
      "The work of the 'overhaul-review' step, which follows this batch.",
    ]);
    expect(await preparedRowCount()).toBe(1);
  });

  it.each(REFUSED_STEPS.map((step): [string, RefusedStep] => [step.phase, step]))(
    'PrepareSteps_%s_RefusesWithItsFinding',
    async (_phase, step) => {
      await seed(step.workflowType, step.phase);

      const refusal = refusalOf(await prepare());

      expect(refusal.code).toBe('PHASE_NOT_PREPARABLE');
      expect(refusal.message).toContain(`'${step.phase}'`);
      expect(refusal.message).toContain(`(finding: ${step.finding})`);
      for (const stepId of step.compilable) expect(refusal.message).toContain(`'${stepId}'`);
      if (step.compilable.length === 0) expect(refusal.message).toContain('no task-batch step');
      else expect(refusal.message).not.toContain('no task-batch step');
      if (step.singleAgent) expect(refusal.message).toContain('primitive path');
      else expect(refusal.message).not.toContain('primitive path');
      expect(await preparedRowCount()).toBe(0);
      expect(await bundleBlobCount()).toBe(0);
    },
  );

  it('PrepareSteps_AFeatureInPlan_NamesDelegate', async () => {
    await seed('feature', 'plan');

    const refusal = refusalOf(await prepare());

    expect(refusal.code).toBe('PHASE_NOT_PREPARABLE');
    expect(refusal.message).toContain('(finding: not-an-implement-step)');
    expect(refusal.message).toContain("prepare compiles the steps 'delegate'");
    expect(refusal.message).not.toContain('primitive path');
  });

  it('PrepareSteps_ARefactorInExplore_NamesOverhaulDelegate', async () => {
    await seed('refactor', 'explore');

    const refusal = refusalOf(await prepare());

    expect(refusal.code).toBe('PHASE_NOT_PREPARABLE');
    expect(refusal.message).toContain("'explore'");
    expect(refusal.message).toContain('(finding: not-an-implement-step)');
    expect(refusal.message).toContain("prepare compiles the steps 'overhaul-delegate'");
  });
});
