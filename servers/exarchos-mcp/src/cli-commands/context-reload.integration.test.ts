import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handlePreCompact } from './pre-compact.js';
import { handleSessionStart } from './session-start.js';
import { resetMaterializerCache } from '../views/tools.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────

async function writeMockState(
  stateDir: string,
  featureId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const state = {
    version: '1.1',
    featureId,
    workflowType: 'feature',
    phase: 'delegate',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    _version: 1,
    artifacts: { design: 'docs/designs/test.md', plan: 'docs/plans/test.md', pr: null },
    tasks: [
      { id: 'T1', title: 'Task one', status: 'complete' },
      { id: 'T2', title: 'Task two', status: 'in_progress' },
    ],
    worktrees: {},
    reviews: {},
    synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
    _history: {},
    _checkpoint: {
      timestamp: '2026-01-01T00:00:00Z',
      phase: 'delegate',
      summary: '',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: '2026-01-01T00:00:00Z',
      staleAfterMinutes: 120,
    },
    ...overrides,
  };
  await fs.writeFile(path.join(stateDir, `${featureId}.state.json`), JSON.stringify(state, null, 2));
}

async function writeMockEvents(
  stateDir: string,
  streamId: string,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  const lines = events.map((e, i) =>
    JSON.stringify({
      ...e,
      streamId,
      sequence: i + 1,
      timestamp: e.timestamp || '2026-01-01T00:00:00Z',
    }),
  );
  await fs.writeFile(path.join(stateDir, `${streamId}.events.jsonl`), lines.join('\n') + '\n');
}

// ─── Integration Tests ─────────────────────────────────────────────────────

describe('context-reload integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-reload-integration-'));
    resetMaterializerCache();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('fullReloadCycle_DelegatePhase_PreCompact_SessionStart_ProducesRichContext', async () => {
    // Arrange: workflow in delegate phase with tasks + events
    await writeMockState(tmpDir, 'test-feature', {
      phase: 'delegate',
      tasks: [
        { id: 'T1', title: 'Setup types', status: 'complete' },
        { id: 'T2', title: 'Implement handler', status: 'in_progress' },
        { id: 'T3', title: 'Write tests', status: 'pending' },
      ],
    });
    await writeMockEvents(tmpDir, 'test-feature', [
      { type: 'workflow.started', data: { featureId: 'test-feature', workflowType: 'feature' } },
      { type: 'workflow.transition', data: { featureId: 'test-feature', from: 'ideate', to: 'delegate' } },
      { type: 'task.assigned', data: { taskId: 'T1', title: 'Setup types' } },
    ]);

    // Act: PreCompact with auto trigger
    const preCompactResult = await handlePreCompact({ event: 'PreCompact', type: 'auto' }, tmpDir);

    // Assert PreCompact
    expect(preCompactResult.continue).toBe(false);
    expect(preCompactResult.stopReason).toContain('/clear');

    // Verify checkpoint + context.md exist
    const checkpointPath = path.join(tmpDir, 'test-feature.checkpoint.json');
    const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf-8'));
    expect(checkpoint.featureId).toBe('test-feature');
    expect(checkpoint.contextFile).toBeDefined();

    const contextPath = path.join(tmpDir, 'test-feature.context.md');
    const contextContent = await fs.readFile(contextPath, 'utf-8');
    expect(contextContent).toContain('Workflow Context');
    expect(contextContent).toContain('test-feature');

    // Act: SessionStart reads the checkpoint + context
    resetMaterializerCache(); // Reset between calls
    const sessionResult = await handleSessionStart({}, tmpDir);

    // Assert SessionStart
    expect(sessionResult.workflows).toBeDefined();
    expect(sessionResult.workflows).toHaveLength(1);
    expect(sessionResult.workflows![0].featureId).toBe('test-feature');
    expect(sessionResult.contextDocument).toBeDefined();
    expect(sessionResult.contextDocument).toContain('Workflow Context');
    expect(sessionResult.contextDocument).toContain('delegate');

    // Verify cleanup: checkpoint and context.md deleted
    await expect(fs.access(checkpointPath)).rejects.toThrow();
    await expect(fs.access(contextPath)).rejects.toThrow();
  });

  it('manualCompact_PreCompact_ReturnsContinueTrue_StillWritesCheckpoint', async () => {
    // Arrange
    await writeMockState(tmpDir, 'manual-feature', { phase: 'review' });
    await writeMockEvents(tmpDir, 'manual-feature', [
      { type: 'workflow.started', data: { featureId: 'manual-feature', workflowType: 'feature' } },
    ]);

    // Act: PreCompact with manual trigger
    const preCompactResult = await handlePreCompact({ event: 'PreCompact', type: 'manual' }, tmpDir);

    // Assert: manual trigger allows compaction
    expect(preCompactResult.continue).toBe(true);

    // Verify checkpoint still written
    const checkpointPath = path.join(tmpDir, 'manual-feature.checkpoint.json');
    const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf-8'));
    expect(checkpoint.featureId).toBe('manual-feature');

    // Act: SessionStart can still read the checkpoint
    resetMaterializerCache();
    const sessionResult = await handleSessionStart({}, tmpDir);

    // Assert: contextDocument present
    expect(sessionResult.workflows).toBeDefined();
    expect(sessionResult.contextDocument).toBeDefined();
  });

  it('noWorkflow_SessionStart_ReturnsMinimalResponse', async () => {
    // Arrange: empty stateDir (no workflows)

    // Act
    const result = await handleSessionStart({}, tmpDir);

    // Assert
    expect(result.workflows).toBeUndefined();
    expect(result.contextDocument).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('multiWorkflow_BothGetContextDocuments', async () => {
    // Arrange: two active workflows
    await writeMockState(tmpDir, 'feature-alpha', { phase: 'delegate' });
    await writeMockState(tmpDir, 'feature-beta', { phase: 'review' });
    await writeMockEvents(tmpDir, 'feature-alpha', [
      { type: 'workflow.started', data: { featureId: 'feature-alpha', workflowType: 'feature' } },
    ]);
    await writeMockEvents(tmpDir, 'feature-beta', [
      { type: 'workflow.started', data: { featureId: 'feature-beta', workflowType: 'feature' } },
    ]);

    // Act: PreCompact checkpoints both
    const preCompactResult = await handlePreCompact({ event: 'PreCompact', type: 'auto' }, tmpDir);
    expect(preCompactResult.continue).toBe(false);

    // Act: SessionStart reads both
    resetMaterializerCache();
    const sessionResult = await handleSessionStart({}, tmpDir);

    // Assert: both workflows present
    expect(sessionResult.workflows).toBeDefined();
    expect(sessionResult.workflows!.length).toBe(2);

    // Assert: contextDocument contains both
    expect(sessionResult.contextDocument).toBeDefined();
    expect(sessionResult.contextDocument).toContain('feature-alpha');
    expect(sessionResult.contextDocument).toContain('feature-beta');
    expect(sessionResult.contextDocument).toContain('---'); // separator
  });

  it('contextBudget_LargeWorkflow_Under8000Chars', async () => {
    // Arrange: workflow with 25 tasks in state file + 25 task.assigned events
    // The CQRS task-detail-view materializes tasks from task.assigned events.
    // We need >10 task.assigned events so the MAX_TASK_ROWS=10 limit in
    // assemble-context triggers the overflow indicator.
    const taskCount = 25;
    const tasks = Array.from({ length: taskCount }, (_, i) => ({
      id: `T${i + 1}`,
      title: `Task number ${i + 1} with a moderately long description for testing`,
      status: i < 10 ? 'complete' : i < 15 ? 'in_progress' : 'pending',
    }));

    const events: Array<Record<string, unknown>> = [
      { type: 'workflow.started', data: { featureId: 'large-feature', workflowType: 'feature' } },
      { type: 'workflow.transition', data: { featureId: 'large-feature', from: 'ideate', to: 'delegate' } },
    ];
    // Emit task.assigned for all 25 tasks so CQRS view has >10 entries
    for (let i = 0; i < taskCount; i++) {
      events.push({
        type: 'task.assigned',
        timestamp: `2026-01-01T${String(i).padStart(2, '0')}:00:00Z`,
        data: {
          featureId: 'large-feature',
          taskId: `T${i + 1}`,
          title: `Task number ${i + 1} with a moderately long description for testing`,
        },
      });
    }

    await writeMockState(tmpDir, 'large-feature', {
      phase: 'delegate',
      tasks,
    });
    await writeMockEvents(tmpDir, 'large-feature', events);

    // Act
    const preCompactResult = await handlePreCompact({ event: 'PreCompact', type: 'auto' }, tmpDir);
    expect(preCompactResult.continue).toBe(false);

    // Read the context.md directly to check budget
    const contextPath = path.join(tmpDir, 'large-feature.context.md');
    const contextContent = await fs.readFile(contextPath, 'utf-8');

    // Assert: under 8000 char budget
    expect(contextContent.length).toBeLessThanOrEqual(8000);
    // Should contain task table (at least some tasks shown)
    expect(contextContent).toContain('Task Progress');
    // Should contain overflow indicator for truncated tasks
    expect(contextContent).toContain('more tasks not shown');
  });
});
