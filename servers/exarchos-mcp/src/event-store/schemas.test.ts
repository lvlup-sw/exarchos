import { z } from 'zod';
import { describe, it, expect, afterEach } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
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
  TaskProgressedData,
  TaskCompletedData,
  TaskFailedData,
  WorkflowPrunedData,
  SynthesizeRequestedData,
  WorkflowCheckpointRequestedData,
  SessionTaggedData,
  StackRestackedData,
  WorktreeCreatedData,
  WorktreeBaselineData,
  TestResultData,
  TypecheckResultData,
  StackSubmittedData,
  CiStatusData,
  CommentPostedData,
  CommentResolvedData,
  EVENT_EMISSION_REGISTRY,
  EVENT_DATA_SCHEMAS,
  type EventEmissionSource,
  registerEventType,
  unregisterEventType,
  getValidEventTypes,
  isBuiltInEventType,
  serializeEventCatalog,
} from './schemas.js';

// ─── T1: EventEmissionSource + EVENT_EMISSION_REGISTRY ──────────────────────

describe('EVENT_EMISSION_REGISTRY', () => {
  it('EventEmissionRegistry_AllEventTypes_HaveClassification', () => {
    for (const eventType of EventTypes) {
      expect(EVENT_EMISSION_REGISTRY).toHaveProperty(eventType);
      const source = EVENT_EMISSION_REGISTRY[eventType];
      expect(['auto', 'model', 'hook', 'planned']).toContain(source);
    }
  });

  it('EventEmissionRegistry_ModelEvents_IncludesTeamAndReview', () => {
    const modelSpotChecks: Array<typeof EventTypes[number]> = [
      'team.spawned',
      'team.task.assigned',
      'team.disbanded',
      'review.routed',
      'review.finding',
      'review.escalated',
      'session.tagged',
      'task.assigned',
      'task.progressed',
    ];
    for (const eventType of modelSpotChecks) {
      expect(EVENT_EMISSION_REGISTRY[eventType]).toBe('model');
    }
  });

  it('EventEmissionRegistry_AutoEvents_IncludesWorkflowAndTask', () => {
    const autoSpotChecks: Array<typeof EventTypes[number]> = [
      'workflow.started',
      'workflow.transition',
      'workflow.checkpoint',
      'task.claimed',
      'task.completed',
      'task.failed',
      'gate.executed',
      'state.patched',
      'tool.invoked',
    ];
    for (const eventType of autoSpotChecks) {
      expect(EVENT_EMISSION_REGISTRY[eventType]).toBe('auto');
    }
  });

  it('EventTypes_PreflightEventsRegistered_BothNamesPresent', () => {
    // Regression: #1129. `prepare_delegation` emits preflight.executed and
    // preflight.blocked, but without registration the event store rejects
    // the append — and fire-and-forget `.catch(()=>{})` silently swallows
    // the rejection. Every preflight event ends up in the bit bucket.
    expect(EventTypes).toContain('preflight.executed');
    expect(EventTypes).toContain('preflight.blocked');
    expect(EVENT_EMISSION_REGISTRY['preflight.executed']).toBe('auto');
    expect(EVENT_EMISSION_REGISTRY['preflight.blocked']).toBe('auto');
  });
});

// ─── T2: EVENT_DATA_SCHEMAS map ─────────────────────────────────────────────

describe('EVENT_DATA_SCHEMAS', () => {
  it('EventDataSchemas_AllEventTypes_HaveEntry', () => {
    // Every EventType should either be in EVENT_DATA_SCHEMAS or be explicitly absent.
    // We verify that the keys in EVENT_DATA_SCHEMAS are all valid EventTypes.
    const schemaKeys = Object.keys(EVENT_DATA_SCHEMAS);
    for (const key of schemaKeys) {
      expect(EventTypes).toContain(key);
    }
  });

  it('EventDataSchemas_ModelEvents_HaveNonNullSchemas', () => {
    // Every model-emitted type must have a non-null schema
    for (const eventType of EventTypes) {
      if (EVENT_EMISSION_REGISTRY[eventType] === 'model') {
        expect(
          EVENT_DATA_SCHEMAS[eventType],
          `Model event '${eventType}' should have a data schema`,
        ).toBeDefined();
      }
    }
  });

  it('EventDataSchemas_ValidData_ParsesSuccessfully', () => {
    // For each entry with a schema, parse known-valid data samples
    const validDataSamples: Partial<Record<string, Record<string, unknown>>> = {
      'workflow.started': { featureId: 'f1', workflowType: 'feature' },
      'task.assigned': { taskId: 't1', title: 'Test task' },
      'task.claimed': { taskId: 't1', agentId: 'a1', claimedAt: '2025-01-01T00:00:00Z' },
      'task.progressed': { taskId: 't1', tddPhase: 'red' },
      'task.completed': { taskId: 't1' },
      'task.failed': { taskId: 't1', error: 'something broke' },
      'team.spawned': { teamSize: 2, teammateNames: ['a', 'b'], taskCount: 3, dispatchMode: 'agent-team' },
      'team.task.assigned': { taskId: 't1', teammateName: 'w1', worktreePath: '/tmp/wt', modules: ['m1'] },
      'team.task.completed': { taskId: 't1', teammateName: 'w1', durationMs: 1000, filesChanged: ['f.ts'], testsPassed: true, qualityGateResults: {} },
      'team.task.failed': { taskId: 't1', teammateName: 'w1', failureReason: 'build', gateResults: {} },
      'team.disbanded': { totalDurationMs: 5000, tasksCompleted: 2, tasksFailed: 0 },
      'review.routed': { pr: 1, riskScore: 0.5, factors: ['f'], destination: 'coderabbit', velocityTier: 'normal', semanticAugmented: false },
      'session.tagged': { tag: 'test', sessionId: 'sess-1' },
    };

    for (const [eventType, data] of Object.entries(validDataSamples)) {
      const schema = EVENT_DATA_SCHEMAS[eventType as typeof EventTypes[number]];
      if (schema) {
        const result = schema.safeParse(data);
        expect(result.success, `Schema for '${eventType}' should parse valid data: ${JSON.stringify(result)}`).toBe(true);
      }
    }
  });
});

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

    it('TeamDisbandedData_ValidData_ParsesSuccessfully', () => {
      const result = TeamDisbandedData.safeParse({
        totalDurationMs: 5000,
        tasksCompleted: 3,
        tasksFailed: 0,
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
  it('should include all 7 team event types', () => {
    const teamEventTypes = [
      'team.spawned',
      'team.task.assigned',
      'team.task.completed',
      'team.task.failed',
      'team.disbanded',
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
    expect(EventTypes).toHaveLength(76);
  });

  it('EventTypes_IncludesSessionTagged', () => {
    expect(EventTypes).toContain('session.tagged');
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
    const payload = { featureId: 'feat-001' };
    expect(ShepherdStartedData.safeParse(payload).success).toBe(true);
  });
});

describe('ShepherdIterationData validation', () => {
  it('ShepherdIterationData_ValidPayload_PassesValidation', () => {
    const payload = { iteration: 2, prsAssessed: 3, fixesApplied: 1, status: 'in-progress' };
    expect(ShepherdIterationData.safeParse(payload).success).toBe(true);
  });
});

describe('ShepherdApprovalRequestedData validation', () => {
  it('ShepherdApprovalRequestedData_ValidPayload_PassesValidation', () => {
    const payload = { prUrl: 'https://github.com/org/repo/pull/1' };
    expect(ShepherdApprovalRequestedData.safeParse(payload).success).toBe(true);
  });
});

describe('ShepherdCompletedData validation', () => {
  it('ShepherdCompletedData_ValidPayload_PassesValidation', () => {
    const payload = { prUrl: 'https://github.com/org/repo/pull/1', outcome: 'merged' };
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

// ─── Task 1: Max-length constraints on unbounded event payload fields ────────

describe('TaskProgressedData max-length constraints', () => {
  it('TaskProgressedData_MaxDetail_PassesValidation', () => {
    const data = { taskId: 'task-1', tddPhase: 'red', detail: 'a'.repeat(500) };
    expect(() => TaskProgressedData.parse(data)).not.toThrow();
  });

  it('TaskProgressedData_OversizedDetail_FailsValidation', () => {
    const data = { taskId: 'task-1', tddPhase: 'red', detail: 'a'.repeat(501) };
    expect(() => TaskProgressedData.parse(data)).toThrow();
  });
});

describe('TaskFailedData max-length constraints', () => {
  it('TaskFailedData_MaxError_PassesValidation', () => {
    const data = { taskId: 'task-1', error: 'a'.repeat(500) };
    expect(() => TaskFailedData.parse(data)).not.toThrow();
  });

  it('TaskFailedData_OversizedError_FailsValidation', () => {
    const data = { taskId: 'task-1', error: 'a'.repeat(501) };
    expect(() => TaskFailedData.parse(data)).toThrow();
  });
});

describe('EvalCaseCompletedData max-length constraints', () => {
  it('EvalCaseCompletedData_MaxAssertions_PassesValidation', () => {
    const assertions = Array.from({ length: 50 }, (_, i) => ({
      name: `assertion-${i}`, type: 'equality', passed: true, score: 1, reason: 'ok'
    }));
    const data = {
      runId: '00000000-0000-0000-0000-000000000001',
      caseId: 'case-1', suiteId: 'suite-1',
      passed: true, score: 1, assertions, duration: 100
    };
    expect(() => EvalCaseCompletedData.parse(data)).not.toThrow();
  });

  it('EvalCaseCompletedData_OversizedAssertions_FailsValidation', () => {
    const assertions = Array.from({ length: 51 }, (_, i) => ({
      name: `assertion-${i}`, type: 'equality', passed: true, score: 1, reason: 'ok'
    }));
    const data = {
      runId: '00000000-0000-0000-0000-000000000001',
      caseId: 'case-1', suiteId: 'suite-1',
      passed: true, score: 1, assertions, duration: 100
    };
    expect(() => EvalCaseCompletedData.parse(data)).toThrow();
  });
});

describe('SessionTaggedData', () => {
  it('SessionTaggedData_ValidPayload_PassesValidation', () => {
    const data = { tag: 'feature-auth', sessionId: 'sess-123' };
    const result = SessionTaggedData.safeParse(data);
    expect(result.success).toBe(true);
  });

  it('SessionTaggedData_WithOptionalFields_PassesValidation', () => {
    const data = {
      tag: 'feature-auth',
      sessionId: 'sess-123',
      description: 'Adding JWT token validation',
      branch: 'main',
    };
    const result = SessionTaggedData.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe('Adding JWT token validation');
      expect(result.data.branch).toBe('main');
    }
  });

  it('SessionTaggedData_MissingTag_FailsValidation', () => {
    const data = { sessionId: 'sess-123' };
    const result = SessionTaggedData.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('SessionTaggedData_MissingSessionId_FailsValidation', () => {
    const data = { tag: 'feature-auth' };
    const result = SessionTaggedData.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('SessionTaggedData_OversizedTag_FailsValidation', () => {
    const data = { tag: 'a'.repeat(101), sessionId: 'sess-123' };
    const result = SessionTaggedData.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('SessionTaggedData_OversizedDescription_FailsValidation', () => {
    const data = { tag: 'feature-auth', sessionId: 'sess-123', description: 'a'.repeat(501) };
    const result = SessionTaggedData.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('sessionTaggedEvent_ValidPayload_ParsesAsBaseEvent', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'tags',
      sequence: 1,
      type: 'session.tagged',
      data: { tag: 'feature-auth', sessionId: 'sess-123' },
    });
    expect(event.success).toBe(true);
  });
});

// ─── Readiness Event Types ──────────────────────────────────────────────────

describe('Readiness EventTypes', () => {
  it('EventTypes_Contains_WorktreeCreated', () => {
    expect(EventTypes).toContain('worktree.created');
  });

  it('EventTypes_Contains_WorktreeBaseline', () => {
    expect(EventTypes).toContain('worktree.baseline');
  });

  it('EventTypes_Contains_TestResult', () => {
    expect(EventTypes).toContain('test.result');
  });

  it('EventTypes_Contains_TypecheckResult', () => {
    expect(EventTypes).toContain('typecheck.result');
  });

  it('EventTypes_Contains_StackSubmitted', () => {
    expect(EventTypes).toContain('stack.submitted');
  });

  it('EventTypes_Contains_CiStatus', () => {
    expect(EventTypes).toContain('ci.status');
  });

  it('EventTypes_Contains_CommentPosted', () => {
    expect(EventTypes).toContain('comment.posted');
  });

  it('EventTypes_Contains_CommentResolved', () => {
    expect(EventTypes).toContain('comment.resolved');
  });
});

// ─── WorktreeCreatedData ────────────────────────────────────────────────────

describe('WorktreeCreatedData', () => {
  it('WorktreeCreatedData_ValidPayload_Parses', () => {
    const result = WorktreeCreatedData.safeParse({
      taskId: 'task-001',
      path: '/tmp/.worktrees/wt-001',
      branch: 'feature/task-001',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.taskId).toBe('task-001');
      expect(result.data.path).toBe('/tmp/.worktrees/wt-001');
      expect(result.data.branch).toBe('feature/task-001');
    }
  });

  it('WorktreeCreatedData_MissingFields_Rejects', () => {
    const result = WorktreeCreatedData.safeParse({
      taskId: 'task-001',
      // missing path and branch
    });
    expect(result.success).toBe(false);
  });
});

// ─── WorktreeBaselineData ───────────────────────────────────────────────────

describe('WorktreeBaselineData', () => {
  it('WorktreeBaselineData_ValidPayload_Parses', () => {
    const result = WorktreeBaselineData.safeParse({
      taskId: 'task-001',
      path: '/tmp/.worktrees/wt-001',
      status: 'passed',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.taskId).toBe('task-001');
      expect(result.data.status).toBe('passed');
    }
  });

  it('WorktreeBaselineData_WithOptionalOutput_Parses', () => {
    const result = WorktreeBaselineData.safeParse({
      taskId: 'task-001',
      path: '/tmp/.worktrees/wt-001',
      status: 'failed',
      output: 'Build error on line 42',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.output).toBe('Build error on line 42');
    }
  });

  it('WorktreeBaselineData_InvalidStatus_Rejects', () => {
    const result = WorktreeBaselineData.safeParse({
      taskId: 'task-001',
      path: '/tmp/.worktrees/wt-001',
      status: 'unknown',
    });
    expect(result.success).toBe(false);
  });

  it('WorktreeBaselineData_MissingFields_Rejects', () => {
    const result = WorktreeBaselineData.safeParse({
      taskId: 'task-001',
      // missing path and status
    });
    expect(result.success).toBe(false);
  });
});

// ─── TestResultData ─────────────────────────────────────────────────────────

describe('TestResultData', () => {
  it('TestResultData_ValidPayload_Parses', () => {
    const result = TestResultData.safeParse({
      passed: true,
      passCount: 42,
      failCount: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
      expect(result.data.passCount).toBe(42);
      expect(result.data.failCount).toBe(0);
    }
  });

  it('TestResultData_WithOptionalFields_Parses', () => {
    const result = TestResultData.safeParse({
      passed: false,
      passCount: 38,
      failCount: 4,
      coveragePercent: 87.5,
      output: 'FAIL src/utils.test.ts',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.coveragePercent).toBe(87.5);
      expect(result.data.output).toBe('FAIL src/utils.test.ts');
    }
  });

  it('TestResultData_MissingFields_Rejects', () => {
    const result = TestResultData.safeParse({
      passed: true,
      // missing passCount and failCount
    });
    expect(result.success).toBe(false);
  });
});

// ─── TypecheckResultData ────────────────────────────────────────────────────

describe('TypecheckResultData', () => {
  it('TypecheckResultData_ValidPayload_Parses', () => {
    const result = TypecheckResultData.safeParse({
      passed: true,
      errorCount: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
      expect(result.data.errorCount).toBe(0);
    }
  });

  it('TypecheckResultData_WithErrors_Parses', () => {
    const result = TypecheckResultData.safeParse({
      passed: false,
      errorCount: 2,
      errors: ['TS2322: Type string not assignable to number', 'TS2304: Cannot find name foo'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.errors).toHaveLength(2);
    }
  });

  it('TypecheckResultData_MissingFields_Rejects', () => {
    const result = TypecheckResultData.safeParse({
      passed: true,
      // missing errorCount
    });
    expect(result.success).toBe(false);
  });
});

// ─── StackSubmittedData ─────────────────────────────────────────────────────

describe('StackSubmittedData', () => {
  it('StackSubmittedData_ValidPayload_Parses', () => {
    const result = StackSubmittedData.safeParse({
      branches: ['feature/task-001', 'feature/task-002'],
      prNumbers: [101, 102],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branches).toEqual(['feature/task-001', 'feature/task-002']);
      expect(result.data.prNumbers).toEqual([101, 102]);
    }
  });

  it('StackSubmittedData_MissingFields_Rejects', () => {
    const result = StackSubmittedData.safeParse({
      branches: ['feature/task-001'],
      // missing prNumbers
    });
    expect(result.success).toBe(false);
  });
});

// ─── CiStatusData ───────────────────────────────────────────────────────────

describe('CiStatusData', () => {
  it('CiStatusData_ValidPayload_Parses', () => {
    const result = CiStatusData.safeParse({
      pr: 101,
      status: 'passing',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pr).toBe(101);
      expect(result.data.status).toBe('passing');
    }
  });

  it('CiStatusData_WithJobUrl_Parses', () => {
    const result = CiStatusData.safeParse({
      pr: 101,
      status: 'failing',
      jobUrl: 'https://github.com/org/repo/actions/runs/123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jobUrl).toBe('https://github.com/org/repo/actions/runs/123');
    }
  });

  it('CiStatusData_InvalidStatus_Rejects', () => {
    const result = CiStatusData.safeParse({
      pr: 101,
      status: 'unknown',
    });
    expect(result.success).toBe(false);
  });

  it('CiStatusData_MissingFields_Rejects', () => {
    const result = CiStatusData.safeParse({
      // missing pr and status
    });
    expect(result.success).toBe(false);
  });
});

// ─── CommentPostedData ──────────────────────────────────────────────────────

describe('CommentPostedData', () => {
  it('CommentPostedData_ValidPayload_Parses', () => {
    const result = CommentPostedData.safeParse({
      pr: 101,
      commentId: 'ic_123',
      body: 'LGTM',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pr).toBe(101);
      expect(result.data.commentId).toBe('ic_123');
      expect(result.data.body).toBe('LGTM');
    }
  });

  it('CommentPostedData_WithInReplyTo_Parses', () => {
    const result = CommentPostedData.safeParse({
      pr: 101,
      commentId: 'ic_124',
      body: 'Fixed in latest push',
      inReplyTo: 'ic_123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.inReplyTo).toBe('ic_123');
    }
  });

  it('CommentPostedData_MissingFields_Rejects', () => {
    const result = CommentPostedData.safeParse({
      pr: 101,
      // missing commentId and body
    });
    expect(result.success).toBe(false);
  });
});

// ─── CommentResolvedData ────────────────────────────────────────────────────

describe('CommentResolvedData', () => {
  it('CommentResolvedData_ValidPayload_Parses', () => {
    const result = CommentResolvedData.safeParse({
      pr: 101,
      threadId: 'thread-abc',
      resolvedBy: 'author',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pr).toBe(101);
      expect(result.data.threadId).toBe('thread-abc');
      expect(result.data.resolvedBy).toBe('author');
    }
  });

  it('CommentResolvedData_InvalidResolvedBy_Rejects', () => {
    const result = CommentResolvedData.safeParse({
      pr: 101,
      threadId: 'thread-abc',
      resolvedBy: 'bot',
    });
    expect(result.success).toBe(false);
  });

  it('CommentResolvedData_MissingFields_Rejects', () => {
    const result = CommentResolvedData.safeParse({
      pr: 101,
      // missing threadId and resolvedBy
    });
    expect(result.success).toBe(false);
  });
});

// ─── Modified StackRestackedData ────────────────────────────────────────────

describe('StackRestackedData (updated)', () => {
  it('StackRestackedData_NewFields_Parses', () => {
    const result = StackRestackedData.safeParse({
      branches: ['feature/task-001', 'feature/task-002'],
      conflicts: false,
      reconstructed: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branches).toEqual(['feature/task-001', 'feature/task-002']);
      expect(result.data.conflicts).toBe(false);
      expect(result.data.reconstructed).toBe(true);
    }
  });

  it('StackRestackedData_OldFields_Rejects', () => {
    const result = StackRestackedData.safeParse({
      affectedPositions: [1, 2, 3],
    });
    expect(result.success).toBe(false);
  });
});

// ─── Modified ShepherdIterationData ─────────────────────────────────────────

describe('ShepherdIterationData (updated)', () => {
  it('ShepherdIterationData_NewFields_Parses', () => {
    const result = ShepherdIterationData.safeParse({
      iteration: 2,
      prsAssessed: 3,
      fixesApplied: 1,
      status: 'in-progress',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.iteration).toBe(2);
      expect(result.data.prsAssessed).toBe(3);
      expect(result.data.fixesApplied).toBe(1);
      expect(result.data.status).toBe('in-progress');
    }
  });

  it('ShepherdIterationData_OldFields_Rejects', () => {
    const result = ShepherdIterationData.safeParse({
      prUrl: 'https://github.com/org/repo/pull/1',
      iteration: 2,
      action: 'fix-ci',
      outcome: 'resolved',
    });
    expect(result.success).toBe(false);
  });
});

// ─── T8: team.context.injected removal ──────────────────────────────────────

describe('EventTypes_DoesNotInclude_TeamContextInjected', () => {
  it('EventTypes_DoesNotInclude_TeamContextInjected', () => {
    expect(EventTypes).not.toContain('team.context.injected');
  });

  it('EVENT_EMISSION_REGISTRY_DoesNotInclude_TeamContextInjected', () => {
    expect(EVENT_EMISSION_REGISTRY).not.toHaveProperty('team.context.injected');
  });

  it('EVENT_DATA_SCHEMAS_DoesNotInclude_TeamContextInjected', () => {
    expect(EVENT_DATA_SCHEMAS).not.toHaveProperty('team.context.injected');
  });
});

// ─── T9: registerEventType / unregisterEventType / getValidEventTypes ────

describe('registerEventType', () => {
  afterEach(() => {
    // Clean up any custom event types registered during tests
    try { unregisterEventType('deploy.started'); } catch { /* ignore */ }
    try { unregisterEventType('deploy.finished'); } catch { /* ignore */ }
    try { unregisterEventType('custom.hello'); } catch { /* ignore */ }
  });

  it('RegisterEventType_CustomType_AddsToValidEventTypes', () => {
    registerEventType('deploy.started', { source: 'model' });

    const valid = getValidEventTypes();
    expect(valid).toContain('deploy.started');
  });

  it('RegisterEventType_BuiltInType_ThrowsCollisionError', () => {
    expect(() =>
      registerEventType('workflow.started', { source: 'auto' }),
    ).toThrow(/built-in/i);
  });

  it('RegisterEventType_DuplicateCustomType_Throws', () => {
    registerEventType('deploy.started', { source: 'model' });

    expect(() =>
      registerEventType('deploy.started', { source: 'hook' }),
    ).toThrow(/already registered/i);
  });

  it('RegisterEventType_InvalidNameFormat_Throws', () => {
    // No dot separator
    expect(() =>
      registerEventType('nodot', { source: 'model' }),
    ).toThrow(/dot separator/i);

    // Uppercase
    expect(() =>
      registerEventType('Deploy.Started', { source: 'model' }),
    ).toThrow(/lowercase/i);

    // Empty
    expect(() =>
      registerEventType('', { source: 'model' }),
    ).toThrow();
  });

  it('RegisterEventType_WithSchema_RegistersInDataSchemas', () => {
    const schema = z.object({ url: z.string() });
    registerEventType('deploy.started', { source: 'hook', schema });

    // The schema should be accessible in EVENT_DATA_SCHEMAS
    expect(EVENT_DATA_SCHEMAS['deploy.started']).toBe(schema);
  });

  it('RegisterEventType_WithSource_RegistersInEmissionRegistry', () => {
    registerEventType('deploy.started', { source: 'hook' });

    expect(EVENT_EMISSION_REGISTRY['deploy.started']).toBe('hook');
  });
});

describe('unregisterEventType', () => {
  afterEach(() => {
    try { unregisterEventType('deploy.started'); } catch { /* ignore */ }
  });

  it('UnregisterEventType_CustomType_RemovesIt', () => {
    registerEventType('deploy.started', { source: 'model' });
    expect(getValidEventTypes()).toContain('deploy.started');

    unregisterEventType('deploy.started');
    expect(getValidEventTypes()).not.toContain('deploy.started');
  });

  it('UnregisterEventType_BuiltInType_Throws', () => {
    expect(() =>
      unregisterEventType('workflow.started'),
    ).toThrow(/built-in/i);
  });
});

describe('getValidEventTypes', () => {
  afterEach(() => {
    try { unregisterEventType('custom.hello'); } catch { /* ignore */ }
  });

  it('GetValidEventTypes_ReturnsBuiltInPlusCustom', () => {
    const beforeCount = getValidEventTypes().length;

    registerEventType('custom.hello', { source: 'model' });

    const after = getValidEventTypes();
    expect(after.length).toBe(beforeCount + 1);
    expect(after).toContain('custom.hello');

    // All built-in types should still be present
    for (const builtIn of EventTypes) {
      expect(after).toContain(builtIn);
    }
  });
});

describe('isBuiltInEventType', () => {
  it('IsBuiltInEventType_BuiltInType_ReturnsTrue', () => {
    expect(isBuiltInEventType('workflow.started')).toBe(true);
    expect(isBuiltInEventType('task.completed')).toBe(true);
  });

  it('IsBuiltInEventType_CustomType_ReturnsFalse', () => {
    expect(isBuiltInEventType('deploy.started')).toBe(false);
  });
});

// ─── serializeEventCatalog ──────────────────────────────────────────────────

describe('serializeEventCatalog', () => {
  it('SerializeEventCatalog_ReturnsAllBuiltInEventTypes', () => {
    const catalog = serializeEventCatalog();
    for (const eventType of EventTypes) {
      expect(catalog.types).toHaveProperty(eventType);
    }
  });

  it('SerializeEventCatalog_IncludesEmissionSource', () => {
    const catalog = serializeEventCatalog();
    expect(catalog.types['workflow.started'].source).toBe('auto');
    expect(catalog.types['team.spawned'].source).toBe('model');
  });

  it('SerializeEventCatalog_GroupsBySource', () => {
    const catalog = serializeEventCatalog();
    expect(catalog.bySource.auto).toContain('workflow.started');
    expect(catalog.bySource.model).toContain('team.spawned');
  });

  it('SerializeEventCatalog_IncludesBuiltInFlag', () => {
    const catalog = serializeEventCatalog();
    expect(catalog.types['workflow.started'].isBuiltIn).toBe(true);
    expect(catalog.types['task.completed'].isBuiltIn).toBe(true);
    expect(catalog.types['team.spawned'].isBuiltIn).toBe(true);
  });

  it('SerializeEventCatalog_IncludesHasSchemaFlag', () => {
    const catalog = serializeEventCatalog();
    // task.completed has a schema in EVENT_DATA_SCHEMAS
    expect(catalog.types['task.completed'].hasSchema).toBe(true);
    // state.patched does NOT have a schema in EVENT_DATA_SCHEMAS
    expect(catalog.types['state.patched'].hasSchema).toBe(false);
  });

  it('SerializeEventCatalog_TotalCount_MatchesTypeCount', () => {
    const catalog = serializeEventCatalog();
    expect(catalog.totalCount).toBe(Object.keys(catalog.types).length);
  });
});

// ─── Task 005/006: Model-emitted event schema description drift tests ────────

describe('Model-emitted event schema descriptions', () => {
  // Get all model-emitted event types
  const modelEmittedTypes = Object.entries(EVENT_EMISSION_REGISTRY)
    .filter(([, source]) => source === 'model')
    .map(([type]) => type);

  /** Narrowing helper for JSON Schema property objects. */
  interface JsonSchemaProperty {
    properties?: Record<string, { description?: string }>;
  }

  function isJsonSchemaWithProperties(
    value: unknown,
  ): value is Required<JsonSchemaProperty> {
    return (
      typeof value === 'object' &&
      value !== null &&
      'properties' in value &&
      typeof (value as JsonSchemaProperty).properties === 'object'
    );
  }

  it('modelEmittedEventSchemas_AllFields_HaveDescriptions', () => {
    const missing: string[] = [];

    for (const eventType of modelEmittedTypes) {
      const schema = (EVENT_DATA_SCHEMAS as Record<string, unknown>)[eventType];
      if (!schema) continue; // skip types without schemas

      const jsonSchema: unknown = zodToJsonSchema(schema as z.ZodSchema);
      if (!isJsonSchemaWithProperties(jsonSchema)) continue;

      for (const [field, fieldSchema] of Object.entries(jsonSchema.properties)) {
        if (!fieldSchema.description) {
          missing.push(`${eventType}.${field}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('modelEmittedEventSchemas_Descriptions_AreReasonableLength', () => {
    const issues: string[] = [];

    for (const eventType of modelEmittedTypes) {
      const schema = (EVENT_DATA_SCHEMAS as Record<string, unknown>)[eventType];
      if (!schema) continue;

      const jsonSchema: unknown = zodToJsonSchema(schema as z.ZodSchema);
      if (!isJsonSchemaWithProperties(jsonSchema)) continue;

      for (const [field, fieldSchema] of Object.entries(jsonSchema.properties)) {
        const desc = fieldSchema.description;
        if (desc && (desc.length < 5 || desc.length > 80)) {
          issues.push(`${eventType}.${field}: ${desc.length} chars`);
        }
      }
    }

    expect(issues).toEqual([]);
  });
});

// ─── DR-6: review.completed event type ──────────────────────────────────────

describe('review.completed event type', () => {
  it('EventTypes_ContainsReviewCompleted', () => {
    expect(EventTypes).toContain('review.completed');
  });

  it('ReviewCompletedSchema_ValidData_Passes', async () => {
    const schemas = await import('./schemas.js');
    const ReviewCompletedData = (schemas as Record<string, z.ZodSchema>)['ReviewCompletedData'];
    expect(ReviewCompletedData).toBeDefined();
    const result = ReviewCompletedData.safeParse({
      stage: 'spec-review',
      verdict: 'pass',
      findingsCount: 0,
      summary: 'All checks passed',
    });
    expect(result.success).toBe(true);
  });

  it('ReviewCompletedSchema_InvalidVerdict_Fails', async () => {
    const schemas = await import('./schemas.js');
    const ReviewCompletedData = (schemas as Record<string, z.ZodSchema>)['ReviewCompletedData'];
    expect(ReviewCompletedData).toBeDefined();
    const result = ReviewCompletedData.safeParse({
      stage: 'spec-review',
      verdict: 'maybe',
      findingsCount: 0,
      summary: 'All checks passed',
    });
    expect(result.success).toBe(false);
  });

  it('EventEmissionRegistry_ReviewCompleted_IsModelSource', () => {
    expect(
      (EVENT_EMISSION_REGISTRY as Record<string, string>)['review.completed'],
    ).toBe('model');
  });
});

// ─── TaskCompletedData acceptanceTestRef (DR-4) ────────────────────────────

describe('TaskCompletedData acceptanceTestRef', () => {
  it('TaskCompletedData_WithAcceptanceTestRef_ParsesSuccessfully', () => {
    const result = TaskCompletedData.safeParse({
      taskId: 'T-001',
      acceptanceTestRef: 'T-000',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.acceptanceTestRef).toBe('T-000');
    }
  });

  it('TaskCompletedData_WithoutAcceptanceTestRef_StillParses', () => {
    const result = TaskCompletedData.safeParse({
      taskId: 'T-001',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.acceptanceTestRef).toBeUndefined();
    }
  });
});

// ─── T1: workflow.pruned event type ─────────────────────────────────────────

describe('WorkflowPrunedData', () => {
  it('eventSchema_workflowPruned_acceptsValidPayload', () => {
    const result = WorkflowPrunedData.safeParse({
      featureId: 'stale-feature',
      stalenessMinutes: 10080,
      triggeredBy: 'manual',
      skippedSafeguards: ['open-pr'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.featureId).toBe('stale-feature');
      expect(result.data.stalenessMinutes).toBe(10080);
      expect(result.data.triggeredBy).toBe('manual');
      expect(result.data.skippedSafeguards).toEqual(['open-pr']);
    }
  });

  it('eventSchema_workflowPruned_acceptsPayloadWithoutSkippedSafeguards', () => {
    const result = WorkflowPrunedData.safeParse({
      featureId: 'stale-feature',
      stalenessMinutes: 60,
      triggeredBy: 'scheduled',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skippedSafeguards).toBeUndefined();
    }
  });

  it('eventSchema_workflowPruned_rejectsMissingFeatureId', () => {
    const result = WorkflowPrunedData.safeParse({
      stalenessMinutes: 60,
      triggeredBy: 'manual',
    });
    expect(result.success).toBe(false);
  });

  it('eventSchema_workflowPruned_rejectsInvalidTriggeredBy', () => {
    const result = WorkflowPrunedData.safeParse({
      featureId: 'stale-feature',
      stalenessMinutes: 60,
      triggeredBy: 'automatic',
    });
    expect(result.success).toBe(false);
  });

  it('eventSchema_workflowPruned_isRegisteredInEventTypeUnion', () => {
    expect(EventTypes).toContain('workflow.pruned');
  });

  it('eventSchema_workflowPruned_hasEmissionSourceClassification', () => {
    expect(EVENT_EMISSION_REGISTRY).toHaveProperty('workflow.pruned');
  });

  it('eventSchema_workflowPruned_isListedInEventDataSchemas', () => {
    expect(EVENT_DATA_SCHEMAS['workflow.pruned']).toBeDefined();
  });
});

// ─── T2: synthesize.requested event type ────────────────────────────────────

describe('SynthesizeRequestedData', () => {
  it('eventSchema_synthesizeRequested_acceptsValidPayload', () => {
    const result = SynthesizeRequestedData.safeParse({
      featureId: 'feat-1',
      reason: 'user requested PR instead of direct commit',
      timestamp: '2026-04-11T12:00:00Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.featureId).toBe('feat-1');
      expect(result.data.reason).toBe('user requested PR instead of direct commit');
      expect(result.data.timestamp).toBe('2026-04-11T12:00:00Z');
    }
  });

  it('eventSchema_synthesizeRequested_acceptsPayloadWithoutReason', () => {
    const result = SynthesizeRequestedData.safeParse({
      featureId: 'feat-1',
      timestamp: '2026-04-11T12:00:00Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBeUndefined();
    }
  });

  it('eventSchema_synthesizeRequested_rejectsMissingFeatureId', () => {
    const result = SynthesizeRequestedData.safeParse({
      timestamp: '2026-04-11T12:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('eventSchema_synthesizeRequested_rejectsMissingTimestamp', () => {
    const result = SynthesizeRequestedData.safeParse({
      featureId: 'feat-1',
    });
    expect(result.success).toBe(false);
  });

  it('eventSchema_synthesizeRequested_isRegisteredInEventTypeUnion', () => {
    expect(EventTypes).toContain('synthesize.requested');
  });

  it('eventSchema_synthesizeRequested_hasEmissionSourceClassification', () => {
    expect(EVENT_EMISSION_REGISTRY).toHaveProperty('synthesize.requested');
  });

  it('eventSchema_synthesizeRequested_isListedInEventDataSchemas', () => {
    expect(EVENT_DATA_SCHEMAS['synthesize.requested']).toBeDefined();
  });
});

// ─── diagnostic.executed (exarchos doctor) ──────────────────────────────────

describe('diagnostic.executed event', () => {
  it('EventSchema_DiagnosticExecuted_ParsesSuccessfully', () => {
    expect(EventTypes).toContain('diagnostic.executed');

    const schema = EVENT_DATA_SCHEMAS['diagnostic.executed' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const valid = {
      summary: { passed: 3, warnings: 1, failed: 0, skipped: 1 },
      checkCount: 5,
      failedCheckNames: [],
      durationMs: 42,
    };

    const result = schema!.safeParse(valid);
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('EventSchema_DiagnosticExecuted_MissingSummary_ThrowsValidationError', () => {
    const schema = EVENT_DATA_SCHEMAS['diagnostic.executed' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const invalid = {
      checkCount: 5,
      failedCheckNames: [],
      durationMs: 42,
    };

    const result = schema!.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});

// ─── workflow.checkpoint_requested (T005, DR-4) ─────────────────────────────

describe('WorkflowCheckpointRequestedData', () => {
  it('CheckpointRequested_ValidData_Parses', () => {
    const result = WorkflowCheckpointRequestedData.safeParse({
      trigger: 'manual',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trigger).toBe('manual');
    }
  });

  it('CheckpointRequested_UnknownTrigger_Rejects', () => {
    const result = WorkflowCheckpointRequestedData.safeParse({
      trigger: 'auto-cadence',
    });
    expect(result.success).toBe(false);
  });
});

// ─── workflow.checkpoint_written (T006, DR-4) ───────────────────────────────

describe('WorkflowCheckpointWrittenData', () => {
  it('CheckpointWritten_ValidData_Parses', () => {
    // DR-4: { projectionId: string, projectionSequence: number, byteSize: number }
    // Emitted after projection materialized + snapshot written, closing the
    // checkpoint_requested → checkpoint_written loop.
    expect(EventTypes).toContain('workflow.checkpoint_written');

    const schema = EVENT_DATA_SCHEMAS['workflow.checkpoint_written' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionId: 'rehydrate-foundation',
      projectionSequence: 42,
      byteSize: 1024,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });
});
