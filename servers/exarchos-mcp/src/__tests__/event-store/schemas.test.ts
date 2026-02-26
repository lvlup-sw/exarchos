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
  type EventType,
} from '../../event-store/schemas.js';

// ─── Base Event Schema ──────────────────────────────────────────────────────

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
    // Missing streamId
    expect(() => WorkflowEventBase.parse({ sequence: 1, type: 'test' })).toThrow();
    // Missing sequence
    expect(() => WorkflowEventBase.parse({ streamId: 'x', type: 'test' })).toThrow();
    // Missing type
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
    // Should be a valid ISO datetime
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

// ─── Workflow-Level Events ──────────────────────────────────────────────────

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

  it('should reject invalid workflow type', () => {
    expect(() =>
      WorkflowStartedData.parse({
        featureId: 'test',
        workflowType: 'invalid',
      }),
    ).toThrow();
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

// ─── Task-Level Events (A02) ────────────────────────────────────────────────

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
      artifacts: ['src/event-store/schemas.ts', 'src/__tests__/event-store/schemas.test.ts'],
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

// ─── Quality Gate Events (A03) ──────────────────────────────────────────────

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

// ─── Stack Events (A03) ─────────────────────────────────────────────────────

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
      affectedPositions: [2, 3, 4],
    });
    expect(data.affectedPositions).toEqual([2, 3, 4]);
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

// ─── EventTypes Discriminated Union (A03) ───────────────────────────────────

describe('EventTypes', () => {
  it('EventTypes_AllEventTypes_CountIs46', () => {
    expect(EventTypes).toHaveLength(47);
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

// ─── B3: Workflow Transition Event Data Schemas ─────────────────────────────

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

// ─── B3: Workflow Compound Exit Event Data Schema ────────────────────────────

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

// ─── B3: Workflow Cancel Event Data Schema ───────────────────────────────────

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

// ─── B3: Workflow Compensation Event Data Schema ─────────────────────────────

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

// ─── B3: Workflow Circuit Open Event Data Schema ─────────────────────────────

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

// ─── Benchmark Event Data ────────────────────────────────────────────────────

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

// ─── Dead Event Types Removal Verification ──────────────────────────────────

describe('Dead event types removed', () => {
  it('should not contain removed event types', () => {
    const removedTypes = [
      'phase.transitioned',
      'task.routed',
      'context.assembled',
      'test.result',
      'gate.self-corrected',
      'remediation.started',
    ];
    for (const type of removedTypes) {
      expect(EventTypes).not.toContain(type);
    }
  });

});
