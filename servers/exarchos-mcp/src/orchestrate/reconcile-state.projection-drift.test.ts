/**
 * #1359 / PR4 T16 — reconcile_state projection-drift check tests.
 *
 * Distinct file from `reconcile-state.test.ts` because the existing tests
 * `vi.mock('node:fs')` globally, which prevents using a real EventStore
 * (which writes to disk) and a real state file. Here we keep `node:fs`
 * real and stub out the git checks via env-controlled execFileSync mocks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Mock execFileSync — git-touching checks should pass-through trivially
// since the canonical state we craft below has no branches/worktrees.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('')),
}));

import { EventStore } from '../event-store/store.js';
import { handleReconcileState } from './reconcile-state.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'reconcile-projdrift-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('handleReconcileState — projection-drift check (#1359 / PR4 T16)', () => {
  it('ReconcileState_PipelineCountVsCanonicalDisagree_ReportsDrift', async () => {
    // GIVEN: a canonical state.json with three `complete` tasks
    const featureId = 'recon-drift';
    const stateFile = path.join(tempDir, `${featureId}.state.json`);
    const canonical = {
      featureId,
      workflowType: 'feature',
      phase: 'delegate',
      tasks: [
        { id: 'T001', status: 'complete' },
        { id: 'T002', status: 'complete' },
        { id: 'T003', status: 'complete' },
      ],
      worktrees: {},
    };
    await writeFile(stateFile, JSON.stringify(canonical));

    // AND: an event store carrying only ONE task.completed event (and a
    // workflow.started so the pipeline view records the workflow at all).
    // Pre-#1359 the pipeline view would see completedCount=1 — diverging
    // from canonical=3.
    const store = new EventStore(tempDir);
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'T001' },
    });

    // WHEN: reconcile runs with both state file and event store wired
    const result = await handleReconcileState({
      stateFile,
      featureId,
      eventStore: store,
      repoRoot: tempDir,
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(false);
    expect(data.report).toContain('projection-drift');
    expect(data.report).toContain('canonical=3');
    expect(data.report).toContain('projected=1');
    expect(data.report).toContain('delta=2');
  });

  it('ReconcileState_PipelineCountAgreesWithCanonical_PassesDriftCheck', async () => {
    // Inverse: when state.tasks marks one complete and one task.completed
    // event matches, the check passes.
    const featureId = 'recon-agree';
    const stateFile = path.join(tempDir, `${featureId}.state.json`);
    const canonical = {
      featureId,
      workflowType: 'feature',
      phase: 'delegate',
      tasks: [
        { id: 'T001', status: 'complete' },
        { id: 'T002', status: 'pending' },
      ],
      worktrees: {},
    };
    await writeFile(stateFile, JSON.stringify(canonical));

    const store = new EventStore(tempDir);
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'state.patched',
      data: {
        featureId,
        fields: ['tasks'],
        patch: { tasks: canonical.tasks },
      },
    });

    const result = await handleReconcileState({
      stateFile,
      featureId,
      eventStore: store,
      repoRoot: tempDir,
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    // The drift check passes; other checks (phase validity etc.) should
    // also pass given the canonical state we constructed.
    expect(data.report).toContain('Projection drift');
    expect(data.report).not.toContain('FAIL: Projection drift');
  });
});
