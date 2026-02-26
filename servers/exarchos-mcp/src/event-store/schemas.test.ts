import { describe, it, expect } from 'vitest';
import {
  validateAgentEvent,
  AGENT_EVENT_TYPES,
  EventTypes,
  WorkflowEventBase,
  TeamSpawnedData,
  TeamTaskAssignedData,
  TeamTaskCompletedData,
  TeamTaskFailedData,
  TeamDisbandedData,
  TeamContextInjectedData,
  TeamTaskPlannedData,
  TeamTeammateDispatchedData,
  QualityRegressionData,
  WorkflowCasFailedData,
  ReviewRoutedData,
  ReviewFindingData,
  ReviewEscalatedData,
  QualityHintGeneratedData,
  EvalRunStartedData,
  EvalCaseCompletedData,
  EvalRunCompletedData,
  ShepherdStartedData,
  ShepherdIterationData,
  ShepherdApprovalRequestedData,
  ShepherdCompletedData,
} from './schemas.js';

describe('validateAgentEvent', () => {
  describe('agent event types', () => {
    it('should reject task.claimed when agentId is missing', () => {
      expect(() =>
        validateAgentEvent({ type: 'task.claimed', source: 'test' }),
      ).toThrow();
    });

    it('should reject task.claimed when source is missing', () => {
      expect(() =>
        validateAgentEvent({ type: 'task.claimed', agentId: 'agent-1' }),
      ).toThrow();
    });

    it('should reject task.progressed when source is missing', () => {
      expect(() =>
        validateAgentEvent({ type: 'task.progressed', agentId: 'agent-1' }),
      ).toThrow();
    });

    it('should pass task.claimed when both agentId and source are present', () => {
      expect(
        validateAgentEvent({ type: 'task.claimed', agentId: 'agent-1', source: 'test' }),
      ).toBe(true);
    });

    it('should pass task.progressed when both agentId and source are present', () => {
      expect(
        validateAgentEvent({ type: 'task.progressed', agentId: 'agent-1', source: 'test' }),
      ).toBe(true);
    });
  });

  describe('system event types', () => {
    it('should pass workflow.started without agentId or source', () => {
      expect(
        validateAgentEvent({ type: 'workflow.started' }),
      ).toBe(true);
    });

    it('should pass workflow.transition without agentId or source', () => {
      expect(
        validateAgentEvent({ type: 'workflow.transition' }),
      ).toBe(true);
    });

    it('should pass task.assigned without agentId or source', () => {
      expect(
        validateAgentEvent({ type: 'task.assigned' }),
      ).toBe(true);
    });
  });

  describe('AGENT_EVENT_TYPES constant', () => {
    it('should contain all agent event types', () => {
      expect(AGENT_EVENT_TYPES).toEqual([
        'task.claimed',
        'task.progressed',
        'team.task.completed',
        'team.task.failed',
      ]);
    });
  });
});

describe('Team Event Data Schemas', () => {
  describe('TeamSpawnedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamSpawnedData.safeParse({
        teamSize: 3,
        teammateNames: ['a', 'b', 'c'],
        taskCount: 5,
        dispatchMode: 'agent-team',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamTaskCompletedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamTaskCompletedData.safeParse({
        taskId: 'task-001',
        teammateName: 'worker-1',
        durationMs: 5000,
        filesChanged: ['a.ts'],
        testsPassed: true,
        qualityGateResults: {},
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamTaskFailedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamTaskFailedData.safeParse({
        taskId: 'task-001',
        teammateName: 'worker-1',
        failureReason: 'typecheck',
        gateResults: {},
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamDisbandedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamDisbandedData.safeParse({
        totalDurationMs: 60000,
        tasksCompleted: 5,
        tasksFailed: 0,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamContextInjectedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamContextInjectedData.safeParse({
        phase: 'delegate',
        toolsAvailable: 3,
        historicalHints: ['hint'],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TeamTaskAssignedData', () => {
    it('should parse valid payload successfully', () => {
      const result = TeamTaskAssignedData.safeParse({
        taskId: 'task-001',
        teammateName: 'worker-1',
        worktreePath: '/tmp/wt',
        modules: ['auth'],
      });
      expect(result.success).toBe(true);
    });
  });
});

describe('EventTypes', () => {
  it('should include all 8 team event types', () => {
    const teamEventTypes = [
      'team.spawned',
      'team.task.assigned',
      'team.task.completed',
      'team.task.failed',
      'team.disbanded',
      'team.context.injected',
      'team.task.planned',
      'team.teammate.dispatched',
    ];
    for (const eventType of teamEventTypes) {
      expect(EventTypes).toContain(eventType);
    }
  });
});

// ─── Task 002: team.task.planned and team.teammate.dispatched ────────────────

describe('TeamTaskPlannedData', () => {
  it('EventSchema_TeamTaskPlanned_ValidatesPayload', () => {
    const result = TeamTaskPlannedData.safeParse({
      taskId: 'task-001',
      title: 'Implement event store',
      modules: ['event-store', 'schemas'],
      blockedBy: ['task-000'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.taskId).toBe('task-001');
      expect(result.data.title).toBe('Implement event store');
      expect(result.data.modules).toEqual(['event-store', 'schemas']);
      expect(result.data.blockedBy).toEqual(['task-000']);
    }
  });

  it('EventSchema_TeamTaskPlanned_RejectsWithoutTaskId', () => {
    const result = TeamTaskPlannedData.safeParse({
      title: 'Implement event store',
      modules: ['event-store'],
      blockedBy: [],
    });
    expect(result.success).toBe(false);
  });

  it('EventSchema_TeamTaskPlanned_IncludedInEventTypeUnion', () => {
    expect(EventTypes).toContain('team.task.planned');
  });

  it('EventSchema_TeamTaskPlanned_ParsesAsBaseEvent', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'team.task.planned',
      data: {
        taskId: 'task-001',
        title: 'Implement event store',
        modules: ['event-store'],
        blockedBy: [],
      },
    });
    expect(event.success).toBe(true);
  });
});

describe('TeamTeammateDispatchedData', () => {
  it('EventSchema_TeamTeammateDispatched_ValidatesPayload', () => {
    const result = TeamTeammateDispatchedData.safeParse({
      teammateName: 'worker-1',
      worktreePath: '/path/.worktrees/wt-001',
      assignedTaskIds: ['task-001', 'task-002'],
      model: 'claude-sonnet-4-20250514',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.teammateName).toBe('worker-1');
      expect(result.data.worktreePath).toBe('/path/.worktrees/wt-001');
      expect(result.data.assignedTaskIds).toEqual(['task-001', 'task-002']);
      expect(result.data.model).toBe('claude-sonnet-4-20250514');
    }
  });

  it('EventSchema_TeamTeammateDispatched_RejectsWithoutTeammateName', () => {
    const result = TeamTeammateDispatchedData.safeParse({
      worktreePath: '/path/.worktrees/wt-001',
      assignedTaskIds: ['task-001'],
      model: 'claude-sonnet-4-20250514',
    });
    expect(result.success).toBe(false);
  });

  it('EventSchema_TeamTeammateDispatched_IncludedInEventTypeUnion', () => {
    expect(EventTypes).toContain('team.teammate.dispatched');
  });

  it('EventSchema_TeamTeammateDispatched_ParsesAsBaseEvent', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'team.teammate.dispatched',
      data: {
        teammateName: 'worker-1',
        worktreePath: '/tmp/wt',
        assignedTaskIds: ['task-001'],
        model: 'claude-sonnet-4-20250514',
      },
    });
    expect(event.success).toBe(true);
  });
});

// ─── T11: quality.regression Event Type ──────────────────────────────────────

describe('QualityRegressionData', () => {
  it('QualityRegressionData_Valid_Parses', () => {
    const result = QualityRegressionData.safeParse({
      skill: 'delegation',
      gate: 'typecheck',
      consecutiveFailures: 3,
      firstFailureCommit: 'abc',
      lastFailureCommit: 'def',
      detectedAt: '2026-02-17T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skill).toBe('delegation');
      expect(result.data.gate).toBe('typecheck');
      expect(result.data.consecutiveFailures).toBe(3);
      expect(result.data.firstFailureCommit).toBe('abc');
      expect(result.data.lastFailureCommit).toBe('def');
      expect(result.data.detectedAt).toBe('2026-02-17T00:00:00.000Z');
    }
  });
});

// ─── T26: workflow.cas-failed Event Schema ───────────────────────────────────

describe('WorkflowCasFailedData', () => {
  it('WorkflowCasFailedData_Valid_Parses', () => {
    const result = WorkflowCasFailedData.safeParse({
      featureId: 'test',
      phase: 'delegate',
      retries: 3,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.featureId).toBe('test');
      expect(result.data.phase).toBe('delegate');
      expect(result.data.retries).toBe(3);
    }
  });
});

describe('EventTypes', () => {
  it('EventTypes_IncludesQualityRegression', () => {
    expect(EventTypes).toContain('quality.regression');
  });

  it('EventTypes_IncludesWorkflowCasFailed', () => {
    expect(EventTypes).toContain('workflow.cas-failed');
  });

  it('EventTypes_HasExpectedCount', () => {
    expect(EventTypes).toHaveLength(50);
  });

  it('EventTypes_StatePatchedType_IsValidEventType', () => {
    expect(EventTypes).toContain('state.patched');
  });

  it('EventTypes_StatePatchedType_ParsesAsBaseEvent', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'my-workflow',
      sequence: 1,
      type: 'state.patched',
      data: {
        fields: { 'tasks[0].status': 'complete' },
      },
    });
    expect(event.success).toBe(true);
  });

  it('EventTypes_IncludesReviewRouted', () => {
    expect(EventTypes).toContain('review.routed');
  });

  it('EventTypes_IncludesReviewFinding', () => {
    expect(EventTypes).toContain('review.finding');
  });

  it('EventTypes_IncludesReviewEscalated', () => {
    expect(EventTypes).toContain('review.escalated');
  });
});

// ─── T3: Review Event Schemas ───────────────────────────────────────────────

describe('ReviewRoutedData', () => {
  it('reviewRoutedEvent_ValidPayload_PassesValidation', () => {
    const result = ReviewRoutedData.safeParse({
      pr: 42,
      riskScore: 0.75,
      factors: ['large-diff', 'security-sensitive'],
      destination: 'coderabbit',
      velocityTier: 'normal',
      semanticAugmented: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pr).toBe(42);
      expect(result.data.riskScore).toBe(0.75);
      expect(result.data.factors).toEqual(['large-diff', 'security-sensitive']);
      expect(result.data.destination).toBe('coderabbit');
      expect(result.data.velocityTier).toBe('normal');
      expect(result.data.semanticAugmented).toBe(true);
    }
  });

  it('reviewRoutedEvent_MissingFields_FailsValidation', () => {
    const result = ReviewRoutedData.safeParse({
      pr: 42,
      riskScore: 0.75,
      // missing factors, destination, velocityTier, semanticAugmented
    });
    expect(result.success).toBe(false);
  });
});

describe('ReviewFindingData', () => {
  it('reviewFindingEvent_ValidPayload_PassesValidation', () => {
    const result = ReviewFindingData.safeParse({
      pr: 42,
      source: 'coderabbit',
      severity: 'major',
      filePath: 'src/merge-gate.ts',
      lineRange: [10, 20],
      message: 'Function too complex',
      rule: 'solid-srp',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pr).toBe(42);
      expect(result.data.source).toBe('coderabbit');
      expect(result.data.severity).toBe('major');
      expect(result.data.filePath).toBe('src/merge-gate.ts');
      expect(result.data.lineRange).toEqual([10, 20]);
      expect(result.data.message).toBe('Function too complex');
      expect(result.data.rule).toBe('solid-srp');
    }
  });

  it('reviewFindingEvent_OptionalFieldsOmitted_PassesValidation', () => {
    const result = ReviewFindingData.safeParse({
      pr: 42,
      source: 'self-hosted',
      severity: 'minor',
      filePath: 'src/utils.ts',
      message: 'Consider renaming variable',
    });
    expect(result.success).toBe(true);
  });

  it('reviewFindingEvent_InvalidSeverity_FailsValidation', () => {
    const result = ReviewFindingData.safeParse({
      pr: 42,
      source: 'coderabbit',
      severity: 'high',  // invalid — not in enum
      filePath: 'src/merge-gate.ts',
      message: 'Something wrong',
    });
    expect(result.success).toBe(false);
  });
});

describe('ReviewEscalatedData', () => {
  it('reviewEscalatedEvent_ValidPayload_PassesValidation', () => {
    const result = ReviewEscalatedData.safeParse({
      pr: 42,
      reason: 'Self-hosted found major issue on velocity-triaged PR',
      originalScore: 0.3,
      triggeringFinding: 'Function too complex',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pr).toBe(42);
      expect(result.data.reason).toBe('Self-hosted found major issue on velocity-triaged PR');
      expect(result.data.originalScore).toBe(0.3);
      expect(result.data.triggeringFinding).toBe('Function too complex');
    }
  });
});

// ─── T5: quality.hint.generated Event Type ──────────────────────────────────

describe('QualityHintGeneratedData', () => {
  it('QualityHintGeneratedData_ValidData_PassesValidation', () => {
    const result = QualityHintGeneratedData.safeParse({
      skill: 'delegation',
      hintCount: 3,
      categories: ['gate', 'pbt', 'benchmark'],
      generatedAt: '2026-02-20T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skill).toBe('delegation');
      expect(result.data.hintCount).toBe(3);
      expect(result.data.categories).toEqual(['gate', 'pbt', 'benchmark']);
      expect(result.data.generatedAt).toBe('2026-02-20T00:00:00.000Z');
    }
  });

  it('QualityHintGeneratedData_ZeroHints_PassesValidation', () => {
    const result = QualityHintGeneratedData.safeParse({
      skill: 'quality-review',
      hintCount: 0,
      categories: [],
      generatedAt: '2026-02-20T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('QualityHintGeneratedData_MissingSkill_FailsValidation', () => {
    const result = QualityHintGeneratedData.safeParse({
      hintCount: 1,
      categories: ['gate'],
      generatedAt: '2026-02-20T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('EventTypes', () => {
  it('EventTypes_IncludesQualityHintGenerated', () => {
    expect(EventTypes).toContain('quality.hint.generated');
  });
});

// ─── T07: WorkflowEventBase multi-tenant fields ──────────────────────────────

describe('WorkflowEventBase multi-tenant fields', () => {
  it('WorkflowEventBase_WithTenantId_ParsesSuccessfully', () => {
    const event = {
      streamId: 'test-stream',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'workflow.started',
      tenantId: 'tenant-123',
      organizationId: 'org-456',
    };
    const result = WorkflowEventBase.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tenantId).toBe('tenant-123');
      expect(result.data.organizationId).toBe('org-456');
    }
  });

  it('WorkflowEventBase_EmptyTenantId_RejectsValidation', () => {
    const event = {
      streamId: 'test-stream',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'workflow.started',
      tenantId: '',
    };
    const result = WorkflowEventBase.safeParse(event);
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_EmptyOrganizationId_RejectsValidation', () => {
    const event = {
      streamId: 'test-stream',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'workflow.started',
      organizationId: '',
    };
    const result = WorkflowEventBase.safeParse(event);
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_WithoutTenantId_ParsesSuccessfully', () => {
    const event = {
      streamId: 'test-stream',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'workflow.started',
    };
    const result = WorkflowEventBase.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tenantId).toBeUndefined();
      expect(result.data.organizationId).toBeUndefined();
    }
  });
});

// ─── T07: Eval Event Type Schemas ──────────────────────────────────────────

describe('EvalRunStartedData', () => {
  it('EvalRunStartedData_ValidPayload_Parses', () => {
    const result = EvalRunStartedData.safeParse({
      runId: crypto.randomUUID(),
      suiteId: 'delegation',
      trigger: 'local',
      caseCount: 10,
    });
    expect(result.success).toBe(true);
  });

  it('EvalRunStartedData_MissingRunId_Fails', () => {
    const result = EvalRunStartedData.safeParse({
      suiteId: 'delegation',
      trigger: 'local',
      caseCount: 10,
    });
    expect(result.success).toBe(false);
  });

  it('EvalRunStartedData_InvalidTrigger_Fails', () => {
    const result = EvalRunStartedData.safeParse({
      runId: crypto.randomUUID(),
      suiteId: 'delegation',
      trigger: 'unknown',
      caseCount: 10,
    });
    expect(result.success).toBe(false);
  });

  it('EvalRunStartedData_WithOptionalLayer_Parses', () => {
    const result = EvalRunStartedData.safeParse({
      runId: crypto.randomUUID(),
      suiteId: 'delegation',
      trigger: 'local',
      caseCount: 10,
      layer: 'regression',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layer).toBe('regression');
    }
  });
});

describe('EvalCaseCompletedData', () => {
  it('EvalCaseCompletedData_ValidPayload_Parses', () => {
    const result = EvalCaseCompletedData.safeParse({
      runId: crypto.randomUUID(),
      caseId: 'case-001',
      suiteId: 'delegation',
      passed: true,
      score: 0.95,
      assertions: [
        { name: 'check-output', type: 'exact-match', passed: true, score: 0.95, reason: 'matched' },
      ],
      duration: 1200,
    });
    expect(result.success).toBe(true);
  });

  it('EvalCaseCompletedData_ScoreOutOfRange_Fails', () => {
    const result = EvalCaseCompletedData.safeParse({
      runId: crypto.randomUUID(),
      caseId: 'case-001',
      suiteId: 'delegation',
      passed: true,
      score: 1.5,
      assertions: [],
      duration: 1200,
    });
    expect(result.success).toBe(false);
  });

  it('EvalCaseCompletedData_EmptyAssertions_Parses', () => {
    const result = EvalCaseCompletedData.safeParse({
      runId: crypto.randomUUID(),
      caseId: 'case-001',
      suiteId: 'delegation',
      passed: true,
      score: 1.0,
      assertions: [],
      duration: 500,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.assertions).toEqual([]);
    }
  });
});

describe('EvalRunCompletedData', () => {
  it('EvalRunCompletedData_ValidPayload_Parses', () => {
    const result = EvalRunCompletedData.safeParse({
      runId: crypto.randomUUID(),
      suiteId: 'delegation',
      total: 10,
      passed: 8,
      failed: 2,
      avgScore: 0.85,
      duration: 5000,
      regressions: ['case-003'],
    });
    expect(result.success).toBe(true);
  });

  it('EvalRunCompletedData_NegativeFailed_Fails', () => {
    const result = EvalRunCompletedData.safeParse({
      runId: crypto.randomUUID(),
      suiteId: 'delegation',
      total: 10,
      passed: 8,
      failed: -1,
      avgScore: 0.85,
      duration: 5000,
      regressions: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('WorkflowEventBase — eval event types', () => {
  it('WorkflowEventBase_EvalRunStartedType_Parses', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'eval-stream',
      sequence: 1,
      type: 'eval.run.started',
      data: {
        runId: crypto.randomUUID(),
        suiteId: 'delegation',
        trigger: 'local',
        caseCount: 5,
      },
    });
    expect(event.success).toBe(true);
  });

  it('WorkflowEventBase_EvalCaseCompletedType_Parses', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'eval-stream',
      sequence: 2,
      type: 'eval.case.completed',
      data: {
        runId: crypto.randomUUID(),
        caseId: 'case-001',
        suiteId: 'delegation',
        passed: true,
        score: 1.0,
        assertions: [],
        duration: 100,
      },
    });
    expect(event.success).toBe(true);
  });

  it('WorkflowEventBase_EvalRunCompletedType_Parses', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'eval-stream',
      sequence: 3,
      type: 'eval.run.completed',
      data: {
        runId: crypto.randomUUID(),
        suiteId: 'delegation',
        total: 5,
        passed: 5,
        failed: 0,
        avgScore: 1.0,
        duration: 3000,
        regressions: [],
      },
    });
    expect(event.success).toBe(true);
  });
});

// ─── Task 3.1: quality.hint.generated @planned removal ──────────────────────

describe('schemas_QualityHintGenerated_NotMarkedPlanned', () => {
  it('schemas_QualityHintGenerated_NotMarkedPlanned', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const schemasPath = path.resolve(
      import.meta.dirname,
      'schemas.ts',
    );
    const source = fs.readFileSync(schemasPath, 'utf-8');

    // Find the QualityHintGeneratedData declaration and check
    // that no @planned annotation appears in the JSDoc immediately
    // preceding it
    const lines = source.split('\n');
    const declIndex = lines.findIndex((l) =>
      l.includes('QualityHintGeneratedData'),
    );
    expect(declIndex).toBeGreaterThan(0);

    // Check the 3 lines before the declaration for @planned
    const preceding = lines
      .slice(Math.max(0, declIndex - 3), declIndex)
      .join('\n');
    expect(preceding).not.toContain('@planned');
  });
});

// ─── Task 3: @planned removal promotion tests ──────────────────────

describe('schemas_ReviewFindingData_NotMarkedPlanned', () => {
  it('schemas_ReviewFindingData_NotMarkedPlanned', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const schemasPath = path.resolve(import.meta.dirname, 'schemas.ts');
    const source = fs.readFileSync(schemasPath, 'utf-8');
    const lines = source.split('\n');
    const declIndex = lines.findIndex((l) => l.includes('ReviewFindingData'));
    expect(declIndex).toBeGreaterThan(0);
    const preceding = lines.slice(Math.max(0, declIndex - 3), declIndex).join('\n');
    expect(preceding).not.toContain('@planned');
  });
});

describe('schemas_ReviewEscalatedData_NotMarkedPlanned', () => {
  it('schemas_ReviewEscalatedData_NotMarkedPlanned', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const schemasPath = path.resolve(import.meta.dirname, 'schemas.ts');
    const source = fs.readFileSync(schemasPath, 'utf-8');
    const lines = source.split('\n');
    const declIndex = lines.findIndex((l) => l.includes('ReviewEscalatedData'));
    expect(declIndex).toBeGreaterThan(0);
    const preceding = lines.slice(Math.max(0, declIndex - 3), declIndex).join('\n');
    expect(preceding).not.toContain('@planned');
  });
});

describe('schemas_QualityRegressionData_NotMarkedPlanned', () => {
  it('schemas_QualityRegressionData_NotMarkedPlanned', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const schemasPath = path.resolve(import.meta.dirname, 'schemas.ts');
    const source = fs.readFileSync(schemasPath, 'utf-8');
    const lines = source.split('\n');
    const declIndex = lines.findIndex((l) => l.includes('QualityRegressionData'));
    expect(declIndex).toBeGreaterThan(0);
    const preceding = lines.slice(Math.max(0, declIndex - 3), declIndex).join('\n');
    expect(preceding).not.toContain('@planned');
  });
});

// ─── Task 4: Schema validation tests ──────────────────────────────

describe('ReviewFindingData validation', () => {
  it('ReviewFindingData_ValidPayload_PassesValidation', () => {
    const payload = {
      pr: 123,
      source: 'coderabbit',
      severity: 'major',
      filePath: 'src/foo.ts',
      lineRange: [10, 20],
      message: 'Unused import',
      rule: 'no-unused-imports',
    };
    expect(ReviewFindingData.safeParse(payload).success).toBe(true);
  });
});

describe('ReviewEscalatedData validation', () => {
  it('ReviewEscalatedData_ValidPayload_PassesValidation', () => {
    const payload = {
      pr: 123,
      reason: 'Critical finding detected',
      originalScore: 0.4,
      triggeringFinding: 'SQL injection in query builder',
    };
    expect(ReviewEscalatedData.safeParse(payload).success).toBe(true);
  });
});

describe('QualityRegressionData validation', () => {
  it('QualityRegressionData_ValidPayload_PassesValidation', () => {
    const payload = {
      skill: 'delegation',
      gate: 'test-coverage',
      consecutiveFailures: 3,
      firstFailureCommit: 'abc123',
      lastFailureCommit: 'def456',
      detectedAt: new Date().toISOString(),
    };
    expect(QualityRegressionData.safeParse(payload).success).toBe(true);
  });
});

// ─── Task 5+6: Shepherd schema tests ──────────────────────────────

describe('ShepherdStartedData validation', () => {
  it('ShepherdStartedData_ValidPayload_PassesValidation', () => {
    const payload = { prUrl: 'https://github.com/org/repo/pull/1', stackSize: 3, ciStatus: 'pending' };
    expect(ShepherdStartedData.safeParse(payload).success).toBe(true);
  });
});

describe('ShepherdIterationData validation', () => {
  it('ShepherdIterationData_ValidPayload_PassesValidation', () => {
    const payload = { prUrl: 'https://github.com/org/repo/pull/1', iteration: 2, action: 'fix-ci', outcome: 'resolved' };
    expect(ShepherdIterationData.safeParse(payload).success).toBe(true);
  });
});

describe('ShepherdApprovalRequestedData validation', () => {
  it('ShepherdApprovalRequestedData_ValidPayload_PassesValidation', () => {
    const payload = { prUrl: 'https://github.com/org/repo/pull/1', reviewers: ['alice', 'bob'] };
    expect(ShepherdApprovalRequestedData.safeParse(payload).success).toBe(true);
  });
});

describe('ShepherdCompletedData validation', () => {
  it('ShepherdCompletedData_ValidPayload_PassesValidation', () => {
    const payload = { prUrl: 'https://github.com/org/repo/pull/1', merged: true, iterations: 3, duration: 45000 };
    expect(ShepherdCompletedData.safeParse(payload).success).toBe(true);
  });
});

describe('EventType_ShepherdTypes_ExistInUnion', () => {
  it('EventType_ShepherdTypes_ExistInUnion', () => {
    const shepherdTypes = ['shepherd.started', 'shepherd.iteration', 'shepherd.approval_requested', 'shepherd.completed'];
    for (const t of shepherdTypes) {
      expect(EventTypes).toContain(t);
    }
  });
});

// ─── Task 5: WorkflowEventBase max-length constraints ──────────────────────

describe('WorkflowEventBase max-length constraints', () => {
  const validBase = {
    streamId: 'test-stream',
    sequence: 1,
    type: 'workflow.started' as const,
  };

  it('WorkflowEventBase_OversizedStreamId_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      streamId: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_MaxLengthStreamId_PassesValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      streamId: 'a'.repeat(100),
    });
    expect(result.success).toBe(true);
  });

  it('WorkflowEventBase_OversizedAgentId_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      agentId: 'a'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_OversizedCorrelationId_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      correlationId: 'a'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_ValidEvent_StillPasses', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      correlationId: 'corr-123',
      causationId: 'cause-456',
      agentId: 'agent-789',
      agentRole: 'implementer',
      source: 'test-runner',
      schemaVersion: '1.0',
      idempotencyKey: 'key-abc',
      data: { key: 'value' },
    });
    expect(result.success).toBe(true);
  });

  it('WorkflowEventBase_OversizedCausationId_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      causationId: 'a'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_OversizedAgentRole_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      agentRole: 'a'.repeat(51),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_OversizedSource_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      source: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_OversizedSchemaVersion_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      schemaVersion: 'a'.repeat(21),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_OversizedIdempotencyKey_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      idempotencyKey: 'a'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_MaxLengthAgentRole_PassesValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      agentRole: 'a'.repeat(50),
    });
    expect(result.success).toBe(true);
  });

  it('WorkflowEventBase_OversizedTenantId_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      tenantId: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_MaxLengthTenantId_PassesValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      tenantId: 'a'.repeat(100),
    });
    expect(result.success).toBe(true);
  });

  it('WorkflowEventBase_OversizedOrganizationId_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      organizationId: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_MaxLengthOrganizationId_PassesValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      organizationId: 'a'.repeat(100),
    });
    expect(result.success).toBe(true);
  });

  it('WorkflowEventBase_EmptyAgentId_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      agentId: '',
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_EmptyIdempotencyKey_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      idempotencyKey: '',
    });
    expect(result.success).toBe(false);
  });

  it('WorkflowEventBase_EmptySchemaVersion_FailsValidation', () => {
    const result = WorkflowEventBase.safeParse({
      ...validBase,
      schemaVersion: '',
    });
    expect(result.success).toBe(false);
  });
});
