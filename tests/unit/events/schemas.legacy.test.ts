import { describe, it, expect } from 'vitest';
import {
  WorkflowEventBase,
  WorkflowStartedData,
  TaskAssignedData,
  TaskClaimedData,
  TaskProgressedData,
  TaskCompletedData,
  TaskFailedData,
  GateExecutedData,
  StackPositionFilledData,
  StackRestackedData,
  StackEnqueuedData,
  WorkflowTransitionData,
  WorkflowFixCycleData,
  WorkflowGuardFailedData,
  WorkflowCheckpointData,
  WorkflowCompoundEntryData,
  WorkflowCompoundExitData,
  WorkflowCancelData,
  WorkflowCompensationData,
  WorkflowCircuitOpenData,
  BenchmarkCompletedData,
  EventTypes,
  PhaseBlockedKindSchema,
  PhaseEnteredResolverSchema,
  ResolvedGateFamilySchema,
  PhaseEnteredPostureSchema,
  type EventType,
} from '../../../src/events/schemas.js';
import { extendWorkflowTypeEnum, unextendWorkflowTypeEnum } from '../../../src/workflow/schemas.js';
import { KIND_OBLIGATIONS, resolveGateSet, type PhaseKind } from '../../../src/workflow/phase-kind.js';

describe('WorkflowEventBase', () => {
  it('should parse a valid base event with all fields', () => {
    const event = {
      streamId: 'my-workflow',
      sequence: 1,
      timestamp: '2025-01-15T10:00:00.000Z',
      type: 'workflow.started',
      correlationId: 'corr-123',
      causationId: 'cause-456',
      agentId: 'agent-1',
      agentRole: 'orchestrator',
      source: 'exarchos',
      schemaVersion: '1.0',
      data: { featureId: 'my-feature' },
    };

    const parsed = WorkflowEventBase.parse(event);
    expect(parsed.streamId).toBe('my-workflow');
    expect(parsed.sequence).toBe(1);
    expect(parsed.type).toBe('workflow.started');
    expect(parsed.correlationId).toBe('corr-123');
    expect(parsed.causationId).toBe('cause-456');
    expect(parsed.agentId).toBe('agent-1');
    expect(parsed.agentRole).toBe('orchestrator');
    expect(parsed.source).toBe('exarchos');
    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.data).toEqual({ featureId: 'my-feature' });
  });

  it('should reject event missing required fields', () => {
    expect(() => WorkflowEventBase.parse({ sequence: 1, type: 'test' })).toThrow();
    expect(() => WorkflowEventBase.parse({ streamId: 'x', type: 'test' })).toThrow();
    expect(() => WorkflowEventBase.parse({ streamId: 'x', sequence: 1 })).toThrow();
  });

  it('should reject empty streamId', () => {
    expect(() =>
      WorkflowEventBase.parse({ streamId: '', sequence: 1, type: 'test' }),
    ).toThrow();
  });

  it('should reject non-positive sequence', () => {
    expect(() =>
      WorkflowEventBase.parse({ streamId: 'x', sequence: 0, type: 'test' }),
    ).toThrow();
    expect(() =>
      WorkflowEventBase.parse({ streamId: 'x', sequence: -1, type: 'test' }),
    ).toThrow();
  });

  it('should default schemaVersion to 1.0', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.started',
    });
    expect(event.schemaVersion).toBe('1.0');
  });

  it('should set default timestamp when not provided', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.started',
    });
    expect(event.timestamp).toBeDefined();
    expect(() => new Date(event.timestamp)).not.toThrow();
  });

  it('should accept event with only required fields', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.started',
    });
    expect(event.correlationId).toBeUndefined();
    expect(event.causationId).toBeUndefined();
    expect(event.agentId).toBeUndefined();
    expect(event.agentRole).toBeUndefined();
    expect(event.source).toBeUndefined();
  });
});

describe('WorkflowStartedData', () => {
  it('should parse valid WorkflowStarted data', () => {
    const data = WorkflowStartedData.parse({
      featureId: 'my-feature',
      workflowType: 'feature',
      designPath: 'docs/designs/my-feature.md',
    });
    expect(data.featureId).toBe('my-feature');
    expect(data.workflowType).toBe('feature');
    expect(data.designPath).toBe('docs/designs/my-feature.md');
  });

  it('should accept all workflow types', () => {
    for (const wfType of ['feature', 'debug', 'refactor']) {
      const data = WorkflowStartedData.parse({
        featureId: 'test',
        workflowType: wfType,
      });
      expect(data.workflowType).toBe(wfType);
    }
  });

  it('should reject empty workflow type', () => {
    expect(() =>
      WorkflowStartedData.parse({
        featureId: 'test',
        workflowType: '',
      }),
    ).toThrow();
  });

  it('should reject unregistered workflow type', () => {
    expect(() =>
      WorkflowStartedData.parse({
        featureId: 'test',
        workflowType: 'unregistered-type',
      }),
    ).toThrow();
  });

  it('should accept registered custom workflow type', () => {
    extendWorkflowTypeEnum('deploy');
    try {
      const data = WorkflowStartedData.parse({
        featureId: 'test',
        workflowType: 'deploy',
      });
      expect(data.workflowType).toBe('deploy');
    } finally {
      unextendWorkflowTypeEnum('deploy');
    }
  });

  it('should allow optional designPath', () => {
    const data = WorkflowStartedData.parse({
      featureId: 'test',
      workflowType: 'debug',
    });
    expect(data.designPath).toBeUndefined();
  });
});

describe('TaskAssignedData', () => {
  it('should parse valid task assignment with worktree', () => {
    const data = TaskAssignedData.parse({
      taskId: 'task-001',
      title: 'Implement event store',
      branch: 'feat/event-store',
      worktree: '.worktrees/event-store',
      assignee: 'coder-agent',
    });
    expect(data.taskId).toBe('task-001');
    expect(data.title).toBe('Implement event store');
    expect(data.branch).toBe('feat/event-store');
    expect(data.worktree).toBe('.worktrees/event-store');
    expect(data.assignee).toBe('coder-agent');
  });

  it('should allow all optional fields', () => {
    const data = TaskAssignedData.parse({
      taskId: 'task-001',
      title: 'A task',
    });
    expect(data.branch).toBeUndefined();
    expect(data.worktree).toBeUndefined();
    expect(data.assignee).toBeUndefined();
  });
});

describe('TaskClaimedData', () => {
  it('should parse valid task claim', () => {
    const data = TaskClaimedData.parse({
      taskId: 'task-001',
      agentId: 'coder-1',
      claimedAt: '2025-01-15T10:00:00.000Z',
    });
    expect(data.taskId).toBe('task-001');
    expect(data.agentId).toBe('coder-1');
    expect(data.claimedAt).toBe('2025-01-15T10:00:00.000Z');
  });

  it('should require all fields', () => {
    expect(() => TaskClaimedData.parse({ taskId: 'task-001' })).toThrow();
    expect(() => TaskClaimedData.parse({ agentId: 'coder-1' })).toThrow();
  });
});

describe('TaskProgressedData', () => {
  it('should parse valid task progress with TDD phase', () => {
    const data = TaskProgressedData.parse({
      taskId: 'task-001',
      tddPhase: 'red',
      detail: 'Writing failing test for event store',
    });
    expect(data.taskId).toBe('task-001');
    expect(data.tddPhase).toBe('red');
    expect(data.detail).toBe('Writing failing test for event store');
  });

  it('should accept all TDD phases', () => {
    for (const phase of ['red', 'green', 'refactor']) {
      const data = TaskProgressedData.parse({
        taskId: 'task-001',
        tddPhase: phase,
      });
      expect(data.tddPhase).toBe(phase);
    }
  });

  it('should reject invalid TDD phase', () => {
    expect(() =>
      TaskProgressedData.parse({ taskId: 'task-001', tddPhase: 'invalid' }),
    ).toThrow();
  });

  it('should allow optional detail', () => {
    const data = TaskProgressedData.parse({
      taskId: 'task-001',
      tddPhase: 'green',
    });
    expect(data.detail).toBeUndefined();
  });
});

describe('TaskCompletedData', () => {
  it('should parse valid task completion with artifacts', () => {
    const data = TaskCompletedData.parse({
      taskId: 'task-001',
      artifacts: ['src/events/schemas.ts', 'src/__tests__/event-store/schemas.test.ts'],
      duration: 3600,
    });
    expect(data.taskId).toBe('task-001');
    expect(data.artifacts).toHaveLength(2);
    expect(data.duration).toBe(3600);
  });

  it('should allow optional fields', () => {
    const data = TaskCompletedData.parse({
      taskId: 'task-001',
    });
    expect(data.artifacts).toBeUndefined();
    expect(data.duration).toBeUndefined();
  });

  it('TaskCompletedData_WithProvenance_ParsesSuccessfully', () => {
    const data = {
      taskId: 'T-3',
      implements: ['DR-1', 'DR-2'],
      tests: [{ name: 'Reset_Valid_Resets', file: 'src/reset.test.ts' }],
      files: ['src/reset.ts'],
    };
    expect(TaskCompletedData.parse(data)).toMatchObject(data);
  });

  it('TaskCompletedData_WithoutProvenance_StillParsesSuccessfully', () => {
    const data = { taskId: 'T-1' };
    expect(TaskCompletedData.parse(data)).toMatchObject({ taskId: 'T-1' });
  });

  it('TaskCompletedData_PartialProvenance_ParsesSuccessfully', () => {
    const data = { taskId: 'T-2', implements: ['DR-1'] };
    expect(TaskCompletedData.parse(data)).toMatchObject(data);
  });
});

describe('TaskFailedData', () => {
  it('should parse valid task failure', () => {
    const data = TaskFailedData.parse({
      taskId: 'task-001',
      error: 'Build failed: type error in schemas.ts',
      diagnostics: { exitCode: 1, stderr: 'TS2322' },
    });
    expect(data.taskId).toBe('task-001');
    expect(data.error).toBe('Build failed: type error in schemas.ts');
    expect(data.diagnostics).toEqual({ exitCode: 1, stderr: 'TS2322' });
  });

  it('should allow optional diagnostics', () => {
    const data = TaskFailedData.parse({
      taskId: 'task-001',
      error: 'Unknown error',
    });
    expect(data.diagnostics).toBeUndefined();
  });
});

describe('GateExecutedData', () => {
  it('should parse valid gate execution', () => {
    const data = GateExecutedData.parse({
      gateName: 'build',
      layer: 'ci',
      passed: true,
      duration: 12.5,
      details: { exitCode: 0 },
    });
    expect(data.gateName).toBe('build');
    expect(data.layer).toBe('ci');
    expect(data.passed).toBe(true);
    expect(data.duration).toBe(12.5);
    expect(data.details).toEqual({ exitCode: 0 });
  });

  it('should allow optional fields', () => {
    const data = GateExecutedData.parse({
      gateName: 'lint',
      layer: 'local',
      passed: false,
    });
    expect(data.duration).toBeUndefined();
    expect(data.details).toBeUndefined();
  });
});

describe('StackPositionFilledData', () => {
  it('should parse valid stack position', () => {
    const data = StackPositionFilledData.parse({
      position: 1,
      taskId: 'task-001',
      branch: 'feat/event-store',
      prUrl: 'https://github.com/org/repo/pull/42',
    });
    expect(data.position).toBe(1);
    expect(data.taskId).toBe('task-001');
    expect(data.branch).toBe('feat/event-store');
    expect(data.prUrl).toBe('https://github.com/org/repo/pull/42');
  });

  it('should allow optional fields', () => {
    const data = StackPositionFilledData.parse({
      position: 1,
      taskId: 'task-001',
    });
    expect(data.branch).toBeUndefined();
    expect(data.prUrl).toBeUndefined();
  });
});

describe('StackRestackedData', () => {
  it('should parse valid restack event', () => {
    const data = StackRestackedData.parse({
      branches: ['feat/task-001', 'feat/task-002'],
      conflicts: false,
      reconstructed: true,
    });
    expect(data.branches).toEqual(['feat/task-001', 'feat/task-002']);
    expect(data.conflicts).toBe(false);
    expect(data.reconstructed).toBe(true);
  });
});

describe('StackEnqueuedData', () => {
  it('should parse valid enqueue event', () => {
    const data = StackEnqueuedData.parse({
      prNumbers: [42, 43, 44],
    });
    expect(data.prNumbers).toEqual([42, 43, 44]);
  });
});

describe('EventTypes', () => {
  /**
   * Pins the count of registered event types. When you register an event type in
   * `events/schemas.ts`, change the count in the same edit.
   * The membership assertions catch a swap of one type for a different type, which keeps the count.
   */
  it('EventTypes_CountMatchesRegisteredTypes', () => {
    expect(EventTypes).toHaveLength(184);
    expect(EventTypes).toContain('tool.budget_exceeded');
    expect(EventTypes).toContain('ci.check_observed');
    expect(EventTypes).toContain('merge.recovered');
    expect(EventTypes).toContain('merge.retry_attempt');
    expect(EventTypes).toContain('merge.executing_started');
    expect(EventTypes).toContain('subagent.tokens_used');
    expect(EventTypes).toContain('migration.correlation_backfill_progress');
    expect(EventTypes).toContain('admission.evidence-recorded');
    expect(EventTypes).toContain('admission.requirement-resolved');
    expect(EventTypes).toContain('admission.transition-decided');
    expect(EventTypes).toContain('admission.contradiction-recorded');
    expect(EventTypes).toContain('cancel.requested');
    expect(EventTypes).toContain('cancel.ready');
    expect(EventTypes).toContain('cancel.ownership-acquired');
    expect(EventTypes).toContain('cancel.compensation-requested');
    expect(EventTypes).toContain('cancel.compensation-completed');
    expect(EventTypes).toContain('cancel.compensation-failed');
    expect(EventTypes).toContain('cancel.compensation-retry-scheduled');
    expect(EventTypes).toContain('cancel.manual-intervention-required');
    expect(EventTypes).toContain('invariant.authored');
    expect(EventTypes).toContain('catalog.registered');
    expect(EventTypes).toContain('merge.completed');
    expect(EventTypes).toContain('onboard.requested');
    expect(EventTypes).toContain('onboard.executed');
    expect(EventTypes).toContain('mutation.executing_started');
    expect(EventTypes).toContain('mutation.executed');
    expect(EventTypes).toContain('phase.blocked');
    expect(EventTypes).toContain('phase.entered');
    expect(EventTypes).toContain('phase.exited');
    expect(EventTypes).toContain('worktree.adopted');
    expect(EventTypes).toContain('worktree.reserved');
    expect(EventTypes).toContain('worktree.released');
    expect(EventTypes).toContain('worktree.orphan_detected');
    expect(EventTypes).toContain('workflow.plan-revision');
    expect(EventTypes).toContain('prune.executing_started');
    expect(EventTypes).toContain('prune.executed');
    expect(EventTypes).toContain('export.requested');
    expect(EventTypes).toContain('export.executed');
    expect(EventTypes as readonly string[]).not.toContain('init.executed');
  });

  /**
   * `PhaseEnteredResolverSchema` is an inline `z.enum` in `events/schemas.ts`. The test pins it to
   * the resolver names that `KIND_OBLIGATIONS` uses, so a new binding without a schema edit fails.
   */
  it('PhaseEnteredResolver_MatchesKindObligationResolvers', () => {
    const resolversInUse = Array.from(
      new Set(
        Object.values(KIND_OBLIGATIONS)
          .map((o) => o.gates?.resolver)
          .filter((r): r is NonNullable<typeof r> => typeof r === 'string'),
      ),
    ).sort();
    expect([...PhaseEnteredResolverSchema.options].sort()).toEqual(resolversInUse);
  });

  /**
   * `ResolvedGateFamilySchema` is an inline `z.enum`. The test pins it to the families that
   * `resolveGateSet` returns across all kinds for a high-risk `feature` context.
   */
  it('ResolvedGateFamily_MatchesResolverOutput', () => {
    const ctx = { riskTier: 'high', boundaryTouching: true, workflowType: 'feature' } as const;
    const familiesEmitted = new Set<string>();
    for (const kind of Object.keys(KIND_OBLIGATIONS) as PhaseKind[]) {
      for (const g of resolveGateSet(kind, ctx)) {
        familiesEmitted.add(g.family);
      }
    }
    expect([...ResolvedGateFamilySchema.options].sort()).toEqual([...familiesEmitted].sort());
  });

  /**
   * `PhaseEnteredPostureSchema` is an inline `z.enum`, so `events/schemas.ts` does not import
   * `runtime/agents/spec.ts`. The test pins it to the postures that `KIND_OBLIGATIONS` declares.
   */
  it('PhaseEnteredPosture_MatchesKindObligationPostures', () => {
    const posturesInUse = Array.from(
      new Set(Object.values(KIND_OBLIGATIONS).map((o) => o.posture)),
    ).sort();
    expect([...PhaseEnteredPostureSchema.options].sort()).toEqual(posturesInUse);
  });

  /**
   * `PhaseBlockedKindSchema` is an inline copy of the `PhaseKind` union. The keys of
   * `KIND_OBLIGATIONS` are that union, so the test pins the schema to them.
   */
  it('PhaseBlockedKind_MatchesPhaseKindUnion', () => {
    expect([...PhaseBlockedKindSchema.options].sort()).toEqual(
      Object.keys(KIND_OBLIGATIONS).sort(),
    );
  });

  it('should include workflow-level types', () => {
    expect(EventTypes).toContain('workflow.started');
    expect(EventTypes).toContain('task.assigned');
  });

  it('should include task-level types', () => {
    expect(EventTypes).toContain('task.claimed');
    expect(EventTypes).toContain('task.progressed');
    expect(EventTypes).toContain('task.completed');
    expect(EventTypes).toContain('task.failed');
  });

  it('should include quality gate types', () => {
    expect(EventTypes).toContain('gate.executed');
  });

  it('should include stack types', () => {
    expect(EventTypes).toContain('stack.position-filled');
    expect(EventTypes).toContain('stack.restacked');
    expect(EventTypes).toContain('stack.enqueued');
  });

  it('should include workflow internal event types', () => {
    expect(EventTypes).toContain('workflow.transition');
    expect(EventTypes).toContain('workflow.fix-cycle');
    expect(EventTypes).toContain('workflow.guard-failed');
    expect(EventTypes).toContain('workflow.checkpoint');
    expect(EventTypes).toContain('workflow.compound-entry');
    expect(EventTypes).toContain('workflow.compound-exit');
    expect(EventTypes).toContain('workflow.cancel');
    expect(EventTypes).toContain('workflow.cleanup');
    expect(EventTypes).toContain('workflow.compensation');
    expect(EventTypes).toContain('workflow.circuit-open');
  });

  it('should include benchmark types', () => {
    expect(EventTypes).toContain('benchmark.completed');
  });

  it('should support type-safe assignment', () => {
    const eventType: EventType = 'workflow.started';
    expect(eventType).toBe('workflow.started');
  });
});

describe('WorkflowTransitionData', () => {
  it('WorkflowEventBase_WorkflowTransition_ParsesCorrectly', () => {
    const data = WorkflowTransitionData.parse({
      from: 'ideate',
      to: 'plan',
      trigger: 'design-approved',
      featureId: 'my-feature',
    });
    expect(data.from).toBe('ideate');
    expect(data.to).toBe('plan');
    expect(data.trigger).toBe('design-approved');
    expect(data.featureId).toBe('my-feature');
  });

  it('should parse event base with workflow.transition type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.transition',
      data: { from: 'ideate', to: 'plan', trigger: 'approved', featureId: 'test' },
    });
    expect(event.type).toBe('workflow.transition');
  });
});

describe('WorkflowFixCycleData', () => {
  it('WorkflowEventBase_WorkflowFixCycle_ParsesCorrectly', () => {
    const data = WorkflowFixCycleData.parse({
      compoundStateId: 'feature-delegate-review',
      count: 2,
      featureId: 'my-feature',
    });
    expect(data.compoundStateId).toBe('feature-delegate-review');
    expect(data.count).toBe(2);
    expect(data.featureId).toBe('my-feature');
  });

  it('should parse event base with workflow.fix-cycle type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.fix-cycle',
    });
    expect(event.type).toBe('workflow.fix-cycle');
  });
});

describe('WorkflowGuardFailedData', () => {
  it('WorkflowEventBase_WorkflowGuardFailed_ParsesCorrectly', () => {
    const data = WorkflowGuardFailedData.parse({
      guard: 'allTasksComplete',
      from: 'delegate',
      to: 'review',
      featureId: 'my-feature',
    });
    expect(data.guard).toBe('allTasksComplete');
    expect(data.from).toBe('delegate');
    expect(data.to).toBe('review');
    expect(data.featureId).toBe('my-feature');
  });

  it('should parse event base with workflow.guard-failed type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.guard-failed',
    });
    expect(event.type).toBe('workflow.guard-failed');
  });
});

describe('WorkflowCheckpointData', () => {
  it('WorkflowEventBase_WorkflowCheckpoint_ParsesCorrectly', () => {
    const data = WorkflowCheckpointData.parse({
      counter: 5,
      phase: 'delegate',
      featureId: 'my-feature',
    });
    expect(data.counter).toBe(5);
    expect(data.phase).toBe('delegate');
    expect(data.featureId).toBe('my-feature');
  });

  it('should parse event base with workflow.checkpoint type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.checkpoint',
    });
    expect(event.type).toBe('workflow.checkpoint');
  });
});

describe('WorkflowCompoundEntryData', () => {
  it('WorkflowEventBase_WorkflowCompoundEntry_ParsesCorrectly', () => {
    const data = WorkflowCompoundEntryData.parse({
      compoundStateId: 'feature-delegate-review',
      featureId: 'my-feature',
    });
    expect(data.compoundStateId).toBe('feature-delegate-review');
    expect(data.featureId).toBe('my-feature');
  });

  it('should parse event base with workflow.compound-entry type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.compound-entry',
    });
    expect(event.type).toBe('workflow.compound-entry');
  });
});

describe('WorkflowCompoundExitData', () => {
  it('should parse valid compound exit data with all fields', () => {
    const data = WorkflowCompoundExitData.parse({
      compoundStateId: 'thorough-track',
      featureId: 'my-feature',
      from: 'thorough-track',
      to: 'synthesize',
      trigger: 'execute-transition',
    });
    expect(data.compoundStateId).toBe('thorough-track');
    expect(data.featureId).toBe('my-feature');
    expect(data.from).toBe('thorough-track');
    expect(data.to).toBe('synthesize');
    expect(data.trigger).toBe('execute-transition');
  });

  it('should allow optional from, to, and trigger fields', () => {
    const data = WorkflowCompoundExitData.parse({
      compoundStateId: 'hotfix-track',
      featureId: 'my-feature',
    });
    expect(data.from).toBeUndefined();
    expect(data.to).toBeUndefined();
    expect(data.trigger).toBeUndefined();
  });

  it('should parse event base with workflow.compound-exit type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.compound-exit',
    });
    expect(event.type).toBe('workflow.compound-exit');
  });
});

describe('WorkflowCancelData', () => {
  it('should parse valid cancel data with all fields', () => {
    const data = WorkflowCancelData.parse({
      from: 'delegate',
      to: 'cancelled',
      trigger: 'user-cancel',
      featureId: 'my-feature',
      reason: 'Requirements changed',
    });
    expect(data.from).toBe('delegate');
    expect(data.to).toBe('cancelled');
    expect(data.trigger).toBe('user-cancel');
    expect(data.featureId).toBe('my-feature');
    expect(data.reason).toBe('Requirements changed');
  });

  it('should allow optional reason', () => {
    const data = WorkflowCancelData.parse({
      from: 'ideate',
      to: 'cancelled',
      trigger: 'user-cancel',
      featureId: 'my-feature',
    });
    expect(data.reason).toBeUndefined();
  });

  it('should parse event base with workflow.cancel type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.cancel',
    });
    expect(event.type).toBe('workflow.cancel');
  });
});

describe('WorkflowCompensationData', () => {
  it('should parse valid compensation data with all fields', () => {
    const data = WorkflowCompensationData.parse({
      featureId: 'my-feature',
      actionId: 'synthesize:close-pr',
      status: 'executed',
      message: 'Closed PR: https://github.com/org/repo/pull/42',
    });
    expect(data.featureId).toBe('my-feature');
    expect(data.actionId).toBe('synthesize:close-pr');
    expect(data.status).toBe('executed');
    expect(data.message).toBe('Closed PR: https://github.com/org/repo/pull/42');
  });

  it('should accept all valid status values', () => {
    for (const status of ['executed', 'skipped', 'failed', 'dry-run']) {
      const data = WorkflowCompensationData.parse({
        featureId: 'my-feature',
        actionId: 'test-action',
        status,
        message: 'test',
      });
      expect(data.status).toBe(status);
    }
  });

  it('should reject invalid status values', () => {
    expect(() =>
      WorkflowCompensationData.parse({
        featureId: 'my-feature',
        actionId: 'test-action',
        status: 'invalid',
        message: 'test',
      }),
    ).toThrow();
  });

  it('should parse event base with workflow.compensation type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.compensation',
    });
    expect(event.type).toBe('workflow.compensation');
  });
});

describe('WorkflowCircuitOpenData', () => {
  it('should parse valid circuit open data with all fields', () => {
    const data = WorkflowCircuitOpenData.parse({
      featureId: 'my-feature',
      compoundId: 'feature-delegate-review',
      fixCycleCount: 3,
      maxFixCycles: 3,
    });
    expect(data.featureId).toBe('my-feature');
    expect(data.compoundId).toBe('feature-delegate-review');
    expect(data.fixCycleCount).toBe(3);
    expect(data.maxFixCycles).toBe(3);
  });

  it('should allow optional fixCycleCount and maxFixCycles', () => {
    const data = WorkflowCircuitOpenData.parse({
      featureId: 'my-feature',
      compoundId: 'delegate',
    });
    expect(data.fixCycleCount).toBeUndefined();
    expect(data.maxFixCycles).toBeUndefined();
  });

  it('should parse event base with workflow.circuit-open type', () => {
    const event = WorkflowEventBase.parse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'workflow.circuit-open',
    });
    expect(event.type).toBe('workflow.circuit-open');
  });
});

describe('BenchmarkCompletedData', () => {
  it('BenchmarkCompletedData_ValidResults_ParsesCorrectly', () => {
    const data = BenchmarkCompletedData.parse({
      taskId: 'task-001',
      results: [{
        operation: 'event-store-query',
        metric: 'p99',
        value: 45.2,
        unit: 'ms',
        baseline: 42.0,
        regressionPercent: 7.6,
        passed: true,
      }],
    });
    expect(data.taskId).toBe('task-001');
    expect(data.results).toHaveLength(1);
    expect(data.results[0].operation).toBe('event-store-query');
    expect(data.results[0].passed).toBe(true);
  });

  it('BenchmarkCompletedData_EmptyResults_Rejects', () => {
    expect(() => BenchmarkCompletedData.parse({
      taskId: 'task-001',
      results: [],
    })).toThrow();
  });

  it('BenchmarkCompletedData_MissingOperation_Rejects', () => {
    expect(() => BenchmarkCompletedData.parse({
      taskId: 'task-001',
      results: [{ metric: 'p99', value: 10, unit: 'ms', passed: true }],
    })).toThrow();
  });

  it('BenchmarkCompletedData_OptionalBaselineFields', () => {
    const data = BenchmarkCompletedData.parse({
      taskId: 'task-001',
      results: [{
        operation: 'view-materialize',
        metric: 'throughput',
        value: 500,
        unit: 'ops/sec',
        passed: true,
      }],
    });
    expect(data.results[0].baseline).toBeUndefined();
    expect(data.results[0].regressionPercent).toBeUndefined();
  });
});

describe('Dead event types removed', () => {
  it('should not contain removed event types', () => {
    const removedTypes = [
      'phase.transitioned',
      'task.routed',
      'context.assembled',
      'gate.self-corrected',
      'remediation.started',
    ];
    for (const type of removedTypes) {
      expect(EventTypes).not.toContain(type);
    }
  });

});
