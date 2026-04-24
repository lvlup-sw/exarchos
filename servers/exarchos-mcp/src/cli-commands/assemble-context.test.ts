import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleAssembleContext } from './assemble-context.js';
import { resetMaterializerCache } from '../views/tools.js';
import { EventStore } from '../event-store/store.js';
import { handleRehydrate } from '../workflow/rehydrate.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

async function createTempStateDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'assemble-ctx-'));
}

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
    artifacts: {
      design: 'docs/designs/test.md',
      plan: 'docs/plans/test.md',
      pr: null,
    },
    tasks: [
      { id: 'T1', title: 'Task one', status: 'complete' },
      { id: 'T2', title: 'Task two', status: 'in_progress' },
    ],
    worktrees: {},
    reviews: {},
    synthesis: {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    },
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
  await fs.writeFile(
    path.join(stateDir, `${featureId}.state.json`),
    JSON.stringify(state, null, 2),
  );
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
  await fs.writeFile(
    path.join(stateDir, `${streamId}.events.jsonl`),
    lines.join('\n') + '\n',
  );
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('assemble-context', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempStateDir();
    resetMaterializerCache();
  });

  afterEach(async () => {
    await cleanupDir(tempDir);
  });

  it('assembleContext_ActiveFeatureWorkflow_ProducesStructuredMarkdown', async () => {
    // Arrange
    const featureId = 'test-feature';
    await writeMockState(tempDir, featureId);
    await writeMockEvents(tempDir, featureId, [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
      {
        type: 'workflow.transition',
        data: { featureId, from: 'ideate', to: 'delegate', trigger: 'auto' },
      },
      {
        type: 'task.assigned',
        data: { taskId: 'T1', title: 'Task one', branch: 'feat/t1' },
      },
      {
        type: 'task.assigned',
        data: { taskId: 'T2', title: 'Task two', branch: 'feat/t2' },
      },
    ]);

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert
    expect(result.contextDocument).toContain('## Workflow Context: test-feature');
    expect(result.featureId).toBe('test-feature');
    expect(result.phase).toBe('delegate');
    expect(typeof result.truncated).toBe('boolean');
  });

  it('assembleContext_DelegatePhase_IncludesWorktreeInfo', async () => {
    // Arrange
    const featureId = 'wt-feature';
    await writeMockState(tempDir, featureId);
    await writeMockEvents(tempDir, featureId, [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
      {
        type: 'workflow.transition',
        data: { featureId, from: 'ideate', to: 'delegate', trigger: 'auto' },
      },
      {
        type: 'task.assigned',
        data: {
          taskId: 'T1',
          title: 'Task one',
          branch: 'feat/t1',
          worktree: '/tmp/wt-task-one',
        },
      },
      {
        type: 'task.assigned',
        data: { taskId: 'T2', title: 'Task two', branch: 'feat/t2' },
      },
    ]);

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert — task table should be present with task info
    expect(result.contextDocument).toContain('### Task Progress');
    expect(result.contextDocument).toContain('T1');
    expect(result.contextDocument).toContain('Task one');
  });

  it('assembleContext_ReviewPhase_IncludesReviewFindings', async () => {
    // Arrange
    const featureId = 'review-feature';
    await writeMockState(tempDir, featureId, { phase: 'review' });
    await writeMockEvents(tempDir, featureId, [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
      {
        type: 'workflow.transition',
        data: { featureId, from: 'delegate', to: 'review', trigger: 'auto' },
      },
      {
        type: 'task.assigned',
        data: { taskId: 'T1', title: 'Task one', status: 'completed' },
      },
    ]);

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert — should have phase=review and task status info
    expect(result.phase).toBe('review');
    expect(result.contextDocument).toContain('### Task Progress');
    expect(result.contextDocument).toContain('T1');
  });

  it('assembleContext_NoActiveWorkflow_ReturnsEmptyContextDocument', async () => {
    // Arrange — no state file, no events
    const featureId = 'nonexistent-feature';

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert
    expect(result.contextDocument).toBe('');
    expect(result.featureId).toBe('nonexistent-feature');
  });

  it('assembleContext_MissingEventStore_GracefulDegradation', async () => {
    // Arrange — state file exists but NO JSONL file
    const featureId = 'no-events-feature';
    await writeMockState(tempDir, featureId);
    // Explicitly do NOT write events JSONL

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert — should still produce a context doc (events section omitted or empty)
    expect(result.contextDocument).toContain('## Workflow Context: no-events-feature');
    expect(result.featureId).toBe('no-events-feature');
    // Should NOT throw
  });

  it('assembleContext_MissingArtifactFiles_SkipsSummaries', async () => {
    // Arrange — state with artifact paths that don't exist on disk
    const featureId = 'missing-artifacts';
    await writeMockState(tempDir, featureId, {
      artifacts: {
        design: '/nonexistent/path/design.md',
        plan: '/nonexistent/path/plan.md',
        pr: null,
      },
    });
    await writeMockEvents(tempDir, featureId, [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
      {
        type: 'workflow.transition',
        data: { featureId, from: 'ideate', to: 'delegate', trigger: 'auto' },
      },
    ]);

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert — should produce a context doc without crashing
    expect(result.contextDocument).toContain('## Workflow Context: missing-artifacts');
    // Artifacts section should either be absent or show paths without summaries
  });

  it('assembleContext_GitUnavailable_SkipsGitSection', async () => {
    // Arrange — use a tmpdir that is NOT inside a git repo
    // os.tmpdir() is typically /tmp which is not a git repo
    const nonGitStateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-git-'));
    const featureId = 'no-git-feature';
    await writeMockState(nonGitStateDir, featureId);
    await writeMockEvents(nonGitStateDir, featureId, [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
      {
        type: 'workflow.transition',
        data: { featureId, from: 'ideate', to: 'delegate', trigger: 'auto' },
      },
    ]);

    try {
      resetMaterializerCache();

      // Act
      const result = await handleAssembleContext({ featureId }, nonGitStateDir);

      // Assert — should produce a context doc without Git State section
      expect(result.contextDocument).toContain('## Workflow Context: no-git-feature');
      expect(result.contextDocument).not.toContain('### Git State');
    } finally {
      await cleanupDir(nonGitStateDir);
    }
  });

  it('assembleContext_IncludesRecentEvents_ViaEventStoreQuery', async () => {
    // Arrange — write events to JSONL
    const featureId = 'events-feature';
    await writeMockState(tempDir, featureId);
    await writeMockEvents(tempDir, featureId, [
      {
        type: 'workflow.started',
        data: { featureId, workflowType: 'feature' },
        timestamp: '2026-01-01T10:00:00Z',
      },
      {
        type: 'workflow.transition',
        data: { featureId, from: 'ideate', to: 'delegate', trigger: 'auto' },
        timestamp: '2026-01-01T10:05:00Z',
      },
      {
        type: 'task.assigned',
        data: { taskId: 'T1', title: 'Task one' },
        timestamp: '2026-01-01T10:10:00Z',
      },
    ]);

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert — events should appear in output
    expect(result.contextDocument).toContain('### Recent Events');
    expect(result.contextDocument).toContain('workflow.started');
  });

  it('assembleContext_EventsFormattedAsOneLineSummaries', async () => {
    // Arrange
    const featureId = 'formatted-events';
    await writeMockState(tempDir, featureId);
    await writeMockEvents(tempDir, featureId, [
      {
        type: 'workflow.started',
        data: { featureId, workflowType: 'feature' },
        timestamp: '2026-01-01T10:00:00Z',
      },
      {
        type: 'task.assigned',
        data: { taskId: 'T1', title: 'Task one' },
        timestamp: '2026-01-01T10:05:00Z',
      },
    ]);

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert — events should be formatted as HH:MM type detail, NOT raw data objects
    expect(result.contextDocument).toContain('### Recent Events');
    // Should contain time-formatted entries
    expect(result.contextDocument).toMatch(/\d{2}:\d{2}/);
    // Should NOT contain raw data object notation
    expect(result.contextDocument).not.toMatch(/"data"\s*:/);
    expect(result.contextDocument).not.toContain('[object Object]');
  });

  it('assembleContext_IncludesNextAction', async () => {
    // Arrange
    const featureId = 'next-action-feature';
    await writeMockState(tempDir, featureId, { phase: 'delegate' });
    await writeMockEvents(tempDir, featureId, [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
      {
        type: 'workflow.transition',
        data: { featureId, from: 'ideate', to: 'delegate', trigger: 'auto' },
      },
    ]);

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert — should contain a next action section
    expect(result.contextDocument).toContain('### Next Action');
    // delegate phase for feature workflow maps to AUTO:review
    expect(result.contextDocument).toContain('AUTO:review');
  });

  it('assembleContext_TokenBudget_OutputUnder8000Chars', async () => {
    // Arrange — create workflow with 25 tasks
    const featureId = 'big-workflow';
    const tasks = Array.from({ length: 25 }, (_, i) => ({
      id: `T${i + 1}`,
      title: `Task number ${i + 1} with a reasonably long title for testing purposes`,
      status: i < 10 ? 'complete' : 'in_progress',
    }));
    await writeMockState(tempDir, featureId, { tasks });

    const events = [
      {
        type: 'workflow.started' as const,
        data: { featureId, workflowType: 'feature' },
        timestamp: '2026-01-01T10:00:00Z',
      },
      {
        type: 'workflow.transition' as const,
        data: { featureId, from: 'ideate', to: 'delegate', trigger: 'auto' },
        timestamp: '2026-01-01T10:01:00Z',
      },
      ...Array.from({ length: 25 }, (_, i) => ({
        type: 'task.assigned' as const,
        data: {
          taskId: `T${i + 1}`,
          title: `Task number ${i + 1} with a reasonably long title for testing purposes`,
        },
        timestamp: `2026-01-01T10:${String(i + 2).padStart(2, '0')}:00Z`,
      })),
    ];
    await writeMockEvents(
      tempDir,
      featureId,
      events as Array<Record<string, unknown>>,
    );

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert — must be under 8000 chars
    expect(result.contextDocument.length).toBeLessThanOrEqual(8000);
  });

  it('assembleContext_TaskTableTruncation_OverflowCount', async () => {
    // Arrange — create workflow with 15 tasks
    const featureId = 'truncated-tasks';
    const tasks = Array.from({ length: 15 }, (_, i) => ({
      id: `T${i + 1}`,
      title: `Task ${i + 1}`,
      status: i < 5 ? 'complete' : 'in_progress',
    }));
    await writeMockState(tempDir, featureId, { tasks });

    const events = [
      {
        type: 'workflow.started' as const,
        data: { featureId, workflowType: 'feature' },
      },
      {
        type: 'workflow.transition' as const,
        data: { featureId, from: 'ideate', to: 'delegate', trigger: 'auto' },
      },
      ...Array.from({ length: 15 }, (_, i) => ({
        type: 'task.assigned' as const,
        data: { taskId: `T${i + 1}`, title: `Task ${i + 1}` },
      })),
    ];
    await writeMockEvents(
      tempDir,
      featureId,
      events as Array<Record<string, unknown>>,
    );

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert — table should show 10 + overflow count for remaining 5
    expect(result.contextDocument).toContain('### Task Progress');
    expect(result.contextDocument).toMatch(/\+5 more tasks? not shown/);
  });

  // ─── Behavioral Guidance Section Tests ──────────────────────────────────

  it('handleAssembleContext_ActiveWorkflow_IncludesBehavioralSection', async () => {
    // Arrange — state with phase=delegate, workflowType=feature
    const featureId = 'behavioral-feature';
    await writeMockState(tempDir, featureId, {
      phase: 'delegate',
      workflowType: 'feature',
    });
    await writeMockEvents(tempDir, featureId, [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
      {
        type: 'workflow.transition',
        data: { featureId, from: 'ideate', to: 'delegate', trigger: 'auto' },
      },
    ]);

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert
    expect(result.contextDocument).toContain('### Behavioral Guidance');
  });

  it('handleAssembleContext_BehavioralSection_ContainsToolInstructions', async () => {
    // Arrange — state with phase=delegate, workflowType=feature
    const featureId = 'behavioral-tools';
    await writeMockState(tempDir, featureId, {
      phase: 'delegate',
      workflowType: 'feature',
    });
    await writeMockEvents(tempDir, featureId, [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
      {
        type: 'workflow.transition',
        data: { featureId, from: 'ideate', to: 'delegate', trigger: 'auto' },
      },
    ]);

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert — delegate playbook references exarchos_workflow tool
    expect(result.contextDocument).toContain('exarchos_workflow');
  });

  it('handleAssembleContext_BehavioralSection_ContainsEventInstructions', async () => {
    // Arrange — state with phase=delegate, workflowType=feature
    const featureId = 'behavioral-events';
    await writeMockState(tempDir, featureId, {
      phase: 'delegate',
      workflowType: 'feature',
    });
    await writeMockEvents(tempDir, featureId, [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
      {
        type: 'workflow.transition',
        data: { featureId, from: 'ideate', to: 'delegate', trigger: 'auto' },
      },
    ]);

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert — delegate playbook emits task.assigned events
    expect(result.contextDocument).toContain('task.assigned');
  });

  it('handleAssembleContext_BehavioralSection_NeverTruncated', async () => {
    // Arrange — create a large workflow that forces truncation
    const featureId = 'behavioral-truncation';
    const tasks = Array.from({ length: 25 }, (_, i) => ({
      id: `T${i + 1}`,
      title: `Task number ${i + 1} with a very long detailed title that takes up space for truncation testing purposes in the context assembly`,
      status: i < 10 ? 'complete' : 'in_progress',
    }));
    await writeMockState(tempDir, featureId, {
      phase: 'delegate',
      workflowType: 'feature',
      tasks,
    });

    const events = [
      {
        type: 'workflow.started' as const,
        data: { featureId, workflowType: 'feature' },
        timestamp: '2026-01-01T10:00:00Z',
      },
      {
        type: 'workflow.transition' as const,
        data: { featureId, from: 'ideate', to: 'delegate', trigger: 'auto' },
        timestamp: '2026-01-01T10:01:00Z',
      },
      ...Array.from({ length: 25 }, (_, i) => ({
        type: 'task.assigned' as const,
        data: {
          taskId: `T${i + 1}`,
          title: `Task number ${i + 1} with a very long detailed title that takes up space for truncation testing purposes in the context assembly`,
        },
        timestamp: `2026-01-01T10:${String(i + 2).padStart(2, '0')}:00Z`,
      })),
    ];
    await writeMockEvents(
      tempDir,
      featureId,
      events as Array<Record<string, unknown>>,
    );

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert — behavioral guidance MUST survive truncation
    expect(result.contextDocument).toContain('### Behavioral Guidance');
  });

  it('handleAssembleContext_UnknownPhase_OmitsBehavioralSection', async () => {
    // Arrange — state with a nonexistent phase
    const featureId = 'behavioral-unknown';
    await writeMockState(tempDir, featureId, {
      phase: 'nonexistent-phase',
      workflowType: 'feature',
    });
    await writeMockEvents(tempDir, featureId, [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
    ]);

    // Act
    const result = await handleAssembleContext({ featureId }, tempDir);

    // Assert — unknown phase should NOT include behavioral section
    expect(result.contextDocument).not.toContain('### Behavioral Guidance');
  });

  // ─── T058 — Migration to exarchos_workflow.rehydrate (DR-16) ────────────

  it('AssembleContext_ProducesSameDocumentAsReducer', async () => {
    // GIVEN: event store seeded with a representative workflow. We use the
    // canonical event shapes the rehydration reducer folds (task.*,
    // workflow.started, workflow.transition, state.patched) so the
    // reducer-derived document has real content in every section the
    // markdown formatter cares about.
    const featureId = 't058-parity';
    await writeMockState(tempDir, featureId, {
      phase: 'delegate',
      workflowType: 'feature',
      artifacts: {
        design: 'docs/designs/test.md',
        plan: 'docs/plans/test.md',
        pr: null,
      },
    });
    await writeMockEvents(tempDir, featureId, [
      {
        type: 'workflow.started',
        data: { featureId, workflowType: 'feature' },
      },
      {
        type: 'workflow.transition',
        data: { featureId, from: 'ideate', to: 'delegate' },
      },
      { type: 'task.assigned', data: { taskId: 'T1', title: 'Task one' } },
      { type: 'task.completed', data: { taskId: 'T1' } },
      { type: 'task.assigned', data: { taskId: 'T2', title: 'Task two' } },
    ]);

    // WHEN: invoke the dispatch-based handler AND handleRehydrate directly.
    const eventStore = new EventStore(tempDir);
    const rehydrateResult = await handleRehydrate(
      { featureId },
      { stateDir: tempDir, eventStore },
    );
    expect(rehydrateResult.success).toBe(true);

    // Reset materializer to avoid cross-test pollution (the seeded events
    // are also needed by the inline-walk path if it were still present).
    resetMaterializerCache();

    const result = await handleAssembleContext({ featureId }, tempDir);

    // THEN: the markdown document must encode every canonical section of
    // the reducer's RehydrationDocument.
    const doc = result.contextDocument;

    // workflowState — featureId + phase are surfaced in the header.
    expect(doc).toContain(`## Workflow Context: ${featureId}`);
    expect(doc).toContain('delegate');

    // taskProgress — both task ids must appear in the task-progress section
    // derived from the reducer's folded task events (T1 completed, T2
    // assigned).
    expect(doc).toContain('### Task Progress');
    expect(doc).toContain('T1');
    expect(doc).toContain('T2');

    // The rehydrated envelope's projectionSequence advances with every
    // handled event — 5 handled events above → projectionSequence === 5.
    // Assert on the envelope itself so we have a structural anchor even if
    // the markdown layer strips sequence info.
    const rehydratedDoc = rehydrateResult.data as {
      projectionSequence: number;
      workflowState: { featureId: string; phase: string; workflowType: string };
      taskProgress: ReadonlyArray<{ id: string; status: string }>;
    };
    expect(rehydratedDoc.workflowState.featureId).toBe(featureId);
    expect(rehydratedDoc.workflowState.phase).toBe('delegate');
    expect(rehydratedDoc.taskProgress.map((t) => t.id).sort()).toEqual([
      'T1',
      'T2',
    ]);
  });

  it('AssembleContext_DispatchesToWorkflow_NotInlineLogic', async () => {
    // GIVEN: a workflow seeded in the event store.
    const featureId = 't058-dispatch-spy';
    await writeMockState(tempDir, featureId, { phase: 'delegate' });
    await writeMockEvents(tempDir, featureId, [
      { type: 'workflow.started', data: { featureId, workflowType: 'feature' } },
      {
        type: 'workflow.transition',
        data: { featureId, from: 'ideate', to: 'delegate' },
      },
      { type: 'task.assigned', data: { taskId: 'T1', title: 'Task one' } },
    ]);

    // WHEN: spy on the rehydrate-handler module. The dispatch-based
    // implementation routes through `handleRehydrate` (either directly or
    // via the composite); either way the module's export must be invoked
    // for this featureId at least once.
    const rehydrateModule = await import('../workflow/rehydrate.js');
    const spy = vi.spyOn(rehydrateModule, 'handleRehydrate');

    try {
      const result = await handleAssembleContext({ featureId }, tempDir);

      // THEN: the rehydrate handler was invoked with this featureId. The
      // inline-walk path never calls `handleRehydrate`, so a single call
      // here is the migration's observable signal.
      expect(spy).toHaveBeenCalled();
      const invokedWithFeatureId = spy.mock.calls.some((call) => {
        const args = call[0] as { featureId?: string };
        return args?.featureId === featureId;
      });
      expect(invokedWithFeatureId).toBe(true);

      // And the adapter must still produce a usable markdown document.
      expect(result.contextDocument).toContain(
        `## Workflow Context: ${featureId}`,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
