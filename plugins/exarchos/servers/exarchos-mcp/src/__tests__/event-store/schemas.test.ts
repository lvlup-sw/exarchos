import { describe, it, expect } from 'vitest';
import {
  WorkflowEventBase,
  WorkflowStartedData,
  TeamFormedData,
  PhaseTransitionedData,
  TaskAssignedData,
  TaskClaimedData,
  TaskProgressedData,
  TestResultData,
  TaskCompletedData,
  TaskFailedData,
  AgentMessageData,
  AgentHandoffData,
  GateExecutedData,
  GateSelfCorrectedData,
  StackPositionFilledData,
  StackRestackedData,
  StackEnqueuedData,
  ContextAssembledData,
  TaskRoutedData,
  RemediationStartedData,
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

describe('TeamFormedData', () => {
  it('should parse valid TeamFormed with teammates array', () => {
    const data = TeamFormedData.parse({
      teammates: [
        { name: 'orchestrator', role: 'orchestrator', model: 'opus-4' },
        { name: 'coder', role: 'specialist' },
      ],
    });
    expect(data.teammates).toHaveLength(2);
    expect(data.teammates[0].name).toBe('orchestrator');
    expect(data.teammates[0].model).toBe('opus-4');
    expect(data.teammates[1].model).toBeUndefined();
  });

  it('should accept empty teammates array', () => {
    const data = TeamFormedData.parse({ teammates: [] });
    expect(data.teammates).toHaveLength(0);
  });

  it('should reject teammate missing name', () => {
    expect(() =>
      TeamFormedData.parse({
        teammates: [{ role: 'specialist' }],
      }),
    ).toThrow();
  });
});

describe('PhaseTransitionedData', () => {
  it('should parse valid phase transition', () => {
    const data = PhaseTransitionedData.parse({
      from: 'ideate',
      to: 'plan',
      trigger: 'design-approved',
    });
    expect(data.from).toBe('ideate');
    expect(data.to).toBe('plan');
    expect(data.trigger).toBe('design-approved');
  });

  it('should allow optional trigger', () => {
    const data = PhaseTransitionedData.parse({
      from: 'ideate',
      to: 'plan',
    });
    expect(data.trigger).toBeUndefined();
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

describe('TestResultData', () => {
  it('should parse valid test result', () => {
    const data = TestResultData.parse({
      taskId: 'task-001',
      passed: true,
      testCount: 42,
      failCount: 0,
      coverage: 95.5,
    });
    expect(data.taskId).toBe('task-001');
    expect(data.passed).toBe(true);
    expect(data.testCount).toBe(42);
    expect(data.failCount).toBe(0);
    expect(data.coverage).toBe(95.5);
  });

  it('should allow optional fields', () => {
    const data = TestResultData.parse({
      taskId: 'task-001',
      passed: false,
      testCount: 10,
      failCount: 3,
    });
    expect(data.coverage).toBeUndefined();
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

// ─── Inter-Agent Events (A02) ───────────────────────────────────────────────

describe('AgentMessageData', () => {
  it('should parse valid agent message', () => {
    const data = AgentMessageData.parse({
      from: 'orchestrator',
      to: 'coder-1',
      content: 'Start implementing task-001',
      messageType: 'direct',
    });
    expect(data.from).toBe('orchestrator');
    expect(data.to).toBe('coder-1');
    expect(data.content).toBe('Start implementing task-001');
    expect(data.messageType).toBe('direct');
  });

  it('should accept broadcast message type', () => {
    const data = AgentMessageData.parse({
      from: 'orchestrator',
      to: 'all',
      content: 'Workflow paused',
      messageType: 'broadcast',
    });
    expect(data.messageType).toBe('broadcast');
  });

  it('should reject invalid message type', () => {
    expect(() =>
      AgentMessageData.parse({
        from: 'a',
        to: 'b',
        content: 'test',
        messageType: 'invalid',
      }),
    ).toThrow();
  });
});

describe('AgentHandoffData', () => {
  it('should parse valid agent handoff', () => {
    const data = AgentHandoffData.parse({
      from: 'coder-1',
      to: 'reviewer-1',
      context: 'Completed task-001, ready for review',
      reason: 'task-completed',
    });
    expect(data.from).toBe('coder-1');
    expect(data.to).toBe('reviewer-1');
    expect(data.context).toBe('Completed task-001, ready for review');
    expect(data.reason).toBe('task-completed');
  });

  it('should allow optional fields', () => {
    const data = AgentHandoffData.parse({
      from: 'coder-1',
      to: 'reviewer-1',
    });
    expect(data.context).toBeUndefined();
    expect(data.reason).toBeUndefined();
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

describe('GateSelfCorrectedData', () => {
  it('should parse valid self-correction', () => {
    const data = GateSelfCorrectedData.parse({
      gateName: 'format',
      attempt: 2,
      correction: 'Auto-formatted 3 files',
    });
    expect(data.gateName).toBe('format');
    expect(data.attempt).toBe(2);
    expect(data.correction).toBe('Auto-formatted 3 files');
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

// ─── Context Events (A03) ───────────────────────────────────────────────────

describe('ContextAssembledData', () => {
  it('should parse valid context assembly', () => {
    const data = ContextAssembledData.parse({
      qualityScore: 0.85,
      sources: ['design-doc', 'test-results', 'code-analysis'],
    });
    expect(data.qualityScore).toBe(0.85);
    expect(data.sources).toHaveLength(3);
  });
});

describe('TaskRoutedData', () => {
  it('should parse valid task routing with scores', () => {
    const data = TaskRoutedData.parse({
      taskId: 'task-001',
      scores: { 'coder-1': 0.9, 'coder-2': 0.7 },
    });
    expect(data.taskId).toBe('task-001');
    expect(data.scores['coder-1']).toBe(0.9);
  });
});

describe('RemediationStartedData', () => {
  it('should parse valid remediation start', () => {
    const data = RemediationStartedData.parse({
      failedGates: ['build', 'test'],
      strategy: 'auto-fix',
    });
    expect(data.failedGates).toEqual(['build', 'test']);
    expect(data.strategy).toBe('auto-fix');
  });
});

// ─── EventTypes Discriminated Union (A03) ───────────────────────────────────

describe('EventTypes', () => {
  it('should contain all 19 event types', () => {
    expect(EventTypes).toHaveLength(19);
  });

  it('should include workflow-level types', () => {
    expect(EventTypes).toContain('workflow.started');
    expect(EventTypes).toContain('team.formed');
    expect(EventTypes).toContain('phase.transitioned');
    expect(EventTypes).toContain('task.assigned');
  });

  it('should include task-level types', () => {
    expect(EventTypes).toContain('task.claimed');
    expect(EventTypes).toContain('task.progressed');
    expect(EventTypes).toContain('test.result');
    expect(EventTypes).toContain('task.completed');
    expect(EventTypes).toContain('task.failed');
  });

  it('should include inter-agent types', () => {
    expect(EventTypes).toContain('agent.message');
    expect(EventTypes).toContain('agent.handoff');
  });

  it('should include quality gate types', () => {
    expect(EventTypes).toContain('gate.executed');
    expect(EventTypes).toContain('gate.self-corrected');
  });

  it('should include stack types', () => {
    expect(EventTypes).toContain('stack.position-filled');
    expect(EventTypes).toContain('stack.restacked');
    expect(EventTypes).toContain('stack.enqueued');
  });

  it('should include context types', () => {
    expect(EventTypes).toContain('context.assembled');
    expect(EventTypes).toContain('task.routed');
    expect(EventTypes).toContain('remediation.started');
  });

  it('should support type-safe assignment', () => {
    const eventType: EventType = 'workflow.started';
    expect(eventType).toBe('workflow.started');
  });
});
