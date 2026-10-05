import { z } from 'zod';
import { describe, it, expect, afterEach } from 'vitest';
import { zodToJsonSchema } from '../../../src/utils/json-schema.js';
import { EVENT_NAME_MIGRATION_NOTE, MalformedEventNameError } from '../../../src/events/event-name.js';
import {
  validateAgentEvent,
  AGENT_EVENT_TYPES,
  EventTypes,
  WorkflowEventBase,
  WorkflowStartedData,
  TaskAssignedData,
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
  MergePreflightData,
  MergeExecutedData,
  MergeRollbackData,
  MergeCompletedData,
  CommandResolvedEventSchema,
  HsmDeprecatedActionInvokedData,
  SpecLegacyCapabilitiesArrayData,
  PhaseContractMissingData,
  MigrationLegacyJsonlImportedData,
  MigrationCompletedData,
  MigrationFailedData,
  SessionMachineryConsumedDataSchema,
  EVENT_EMISSION_REGISTRY,
  EVENT_DATA_SCHEMAS,
  type EventEmissionSource,
  registerEventType,
  unregisterEventType,
  getValidEventTypes,
  isBuiltInEventType,
  serializeEventCatalog,
  PrCreateRequestedData,
  PrCreateExecutedData,
  PrCommentRequestedData,
  PrCommentExecutedData,
  IssueCreateRequestedData,
  IssueCreateExecutedData,
  BranchDeleteRequestedData,
  BranchDeleteExecutedData,
  WorktreeRemoveRequestedData,
  WorktreeRemoveExecutedData,
  WorktreeAdoptedData,
  WorktreeReservedData,
  WorktreeReleasedData,
  WorktreeOrphanDetectedData,
  WorktreeMergeRequestedData,
  WorktreeMergeExecutedData,
  WorktreeCreateRequestedData,
  WorktreeCreateExecutedData,
  LaunchExecutingStartedData,
  LaunchExecutedData,
  MergeExecutingStartedData,
  MutationExecutingStartedData,
  MutationExecutedData,
  PruneExecutingStartedData,
  PruneExecutedData,
  VcsRequestedData,
  VcsExecutedData,
  VcsCompensatedData,
  PromotionExecutedData,
  EmissionViolatedData,
  AdmissionCutoverReadyData,
  type WorkflowEvent,
} from '../../../src/events/schemas.js';
import * as mutationOwner from '../../../src/vcs/mutation-owner.js';
import { promoteTree, promotionPlan, defaultPromotionIo } from '../../../src/install/atomic-promotion.js';
import { digestTree } from '../../../src/install/install-identity.js';
import { DRY_RUN, isDryRun } from '../../../src/dispatch/core/effect-carrier.js';
import { workflowStateProjection } from '../../../src/projections/views/workflow-state-projection.js';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

describe('EVENT_EMISSION_REGISTRY', () => {
  /** A `retired` source keeps its schema for replay, and no emitter writes it. */
  it('EventEmissionRegistry_AllEventTypes_HaveClassification', () => {
    for (const eventType of EventTypes) {
      expect(EVENT_EMISSION_REGISTRY).toHaveProperty(eventType);
      const source = EVENT_EMISSION_REGISTRY[eventType];
      expect(['auto', 'model', 'hook', 'planned', 'retired']).toContain(source);
    }
  });

  /** `prepare` and `prepare_delegation` append `task.assigned`, so its source is `auto`. */
  it('EventEmissionRegistry_ModelEvents_IncludesTeamAndReview', () => {
    const modelSpotChecks: Array<typeof EventTypes[number]> = [
      'team.spawned',
      'team.task.assigned',
      'team.disbanded',
      'review.finding',
      'review.escalated',
      'session.tagged',
      'task.progressed',
    ];
    for (const eventType of modelSpotChecks) {
      expect(EVENT_EMISSION_REGISTRY[eventType]).toBe('model');
    }
    expect(EVENT_EMISSION_REGISTRY['task.assigned']).toBe('auto');
  });

  /** Dispatch-core handlers emit `review.routed`, `ci.status` and `quality.regression`. */
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
      'review.routed',
      'ci.status',
      'quality.regression',
    ];
    for (const eventType of autoSpotChecks) {
      expect(EVENT_EMISSION_REGISTRY[eventType]).toBe('auto');
    }
  });

  /** The event store rejects an unregistered type, and `prepare_delegation` emits both preflight types. */
  it('EventTypes_PreflightEventsRegistered_BothNamesPresent', () => {
    expect(EventTypes).toContain('preflight.executed');
    expect(EventTypes).toContain('preflight.blocked');
    expect(EVENT_EMISSION_REGISTRY['preflight.executed']).toBe('auto');
    expect(EVENT_EMISSION_REGISTRY['preflight.blocked']).toBe('auto');
  });
});

describe('EVENT_DATA_SCHEMAS', () => {
  /**
   * The test checks only that each key of `EVENT_DATA_SCHEMAS` is an event type.
   * It does not require an entry for each type.
   */
  it('EventDataSchemas_AllEventTypes_HaveEntry', () => {
    const schemaKeys = Object.keys(EVENT_DATA_SCHEMAS);
    for (const key of schemaKeys) {
      expect(EventTypes).toContain(key);
    }
  });

  it('EventDataSchemas_ModelEvents_HaveNonNullSchemas', () => {
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

  /**
   * The count pins the size of the catalog, so a type cannot join or leave it without a change here.
   * The retired `init.executed` type must stay out of the catalog.
   */
  it('EventTypes_HasExpectedCount', () => {
    expect(EventTypes).toHaveLength(184);
    expect(EventTypes).toContain('tool.budget_exceeded');
    expect(EventTypes).toContain('ci.check_observed');
    expect(EventTypes).toContain('merge.recovered');
    expect(EventTypes).toContain('merge.retry_attempt');
    expect(EventTypes).toContain('merge.executing_started');
    expect(EventTypes).toContain('subagent.tokens_used');
    expect(EventTypes).toContain('onboard.requested');
    expect(EventTypes).toContain('onboard.executed');
    expect(EventTypes).toContain('mutation.executing_started');
    expect(EventTypes).toContain('mutation.executed');
    expect(EventTypes).toContain('feedback.recorded');
    expect(EventTypes).toContain('workflow.handoff_summarized');
    expect(EventTypes).toContain('phase.blocked');
    expect(EventTypes).toContain('worktree.adopted');
    expect(EventTypes).toContain('worktree.reserved');
    expect(EventTypes).toContain('worktree.released');
    expect(EventTypes).toContain('worktree.orphan_detected');
    expect(EventTypes).toContain('workflow.plan-revision');
    expect(EventTypes).toContain('prune.executing_started');
    expect(EventTypes).toContain('prune.executed');
    expect(EventTypes).toContain('export.requested');
    expect(EventTypes).toContain('export.executed');
    expect(EventTypes).toContain('cancel.ownership-acquired');
    expect(EventTypes).toContain('cancel.compensation-retry-scheduled');
    expect(EventTypes).toContain('cancel.manual-intervention-required');
    expect(EventTypes).toContain('vcs.requested');
    expect(EventTypes).toContain('vcs.executed');
    expect(EventTypes).toContain('vcs.compensated');
    expect(EventTypes).toContain('promotion.executed');
    expect(EventTypes as readonly string[]).not.toContain('init.executed');
  });

  /**
   * The SubagentStop hook appends `subagent.tokens_used`, so its source is `auto`.
   * The schema rejects a negative or fractional token count.
   */
  it('eventSchemas_SubagentTokensUsed_ValidateAndRegister', () => {
    expect(EventTypes).toContain('subagent.tokens_used');
    expect(EVENT_EMISSION_REGISTRY['subagent.tokens_used']).toBe('auto');

    const schema = EVENT_DATA_SCHEMAS['subagent.tokens_used'];
    expect(schema).toBeDefined();

    expect(schema!.safeParse({ agentId: 'agent-abc', outputTokens: 1234 }).success).toBe(true);

    const full = schema!.safeParse({
      agentId: 'agent-abc',
      agentType: 'exarchos-implementer',
      outputTokens: 5000,
      teammateName: 'alice',
      taskId: 'W2-6',
      sessionId: 'sess-1',
      cwd: '/tmp/wt',
    });
    expect(full.success).toBe(true);

    expect(schema!.safeParse({ outputTokens: 10 }).success).toBe(false);
    expect(schema!.safeParse({ agentId: 'a', outputTokens: -1 }).success).toBe(false);
    expect(schema!.safeParse({ agentId: 'a', outputTokens: 12.5 }).success).toBe(false);
  });

  /**
   * The runtime emits both events at the transition boundary, so each one is `auto`.
   * `phase.entered` freezes the resolved obligation.
   * `phase.exited` records the aggregate status of the required gates.
   */
  it('eventSchemas_PhaseEnteredExited_ValidateAndRegister', () => {
    expect(EventTypes).toContain('phase.entered');
    expect(EventTypes).toContain('phase.exited');
    expect(EVENT_EMISSION_REGISTRY['phase.entered']).toBe('auto');
    expect(EVENT_EMISSION_REGISTRY['phase.exited']).toBe('auto');

    const enteredSchema = EVENT_DATA_SCHEMAS['phase.entered'];
    const exitedSchema = EVENT_DATA_SCHEMAS['phase.exited'];
    expect(enteredSchema).toBeDefined();
    expect(exitedSchema).toBeDefined();

    expect(
      enteredSchema?.safeParse({
        phase: 'implement',
        kind: 'IMPLEMENT',
        resolver: 'verification-ladder',
        resolvedGates: [{ family: 'ladder', gate: 'check_static_analysis' }],
        policySource: 'builtin',
        mode: 'enforce',
        posture: 'task-isolated',
      }).success,
    ).toBe(true);

    expect(
      enteredSchema?.safeParse({
        phase: 'gather',
        kind: 'GATHER',
        resolver: null,
        resolvedGates: [],
        policySource: 'builtin',
        mode: 'enforce',
        posture: 'read-only',
      }).success,
    ).toBe(true);

    expect(
      enteredSchema?.safeParse({
        phase: 'plan',
        kind: 'PLAN',
        resolver: 'plan-structure',
        resolvedGates: [],
        policySource: 'whoknows',
        mode: 'enforce',
        posture: 'read-only',
      }).success,
    ).toBe(false);

    expect(
      enteredSchema?.safeParse({
        phase: 'review',
        kind: 'REVIEW',
        resolver: 'review-contract',
        resolvedGates: [{ family: 'bogus', gate: 'x' }],
        policySource: 'builtin',
        mode: 'enforce',
        posture: 'read-only',
      }).success,
    ).toBe(false);

    expect(
      enteredSchema?.safeParse({
        phase: 'plan',
        kind: 'PLAN',
        resolver: 'plan-structure',
        resolvedGates: [],
        policySource: 'builtin',
        mode: 'enforce',
        posture: 'god-mode',
      }).success,
    ).toBe(false);

    expect(
      exitedSchema?.safeParse({ phase: 'implement', allRequiredGatesPassed: true }).success,
    ).toBe(true);
    expect(exitedSchema?.safeParse({ phase: 'implement' }).success).toBe(false);
  });

  /** A client decline has its own type and is not an `elicitation.fulfilled` with an empty payload. */
  it('EventTypes_IncludesElicitation', () => {
    expect(EventTypes).toContain('elicitation.requested');
    expect(EventTypes).toContain('elicitation.fulfilled');
    expect(EventTypes).toContain('elicitation.declined');
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
      severity: 'high',
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

describe('WorkflowStartedData repoRoot (DR-5)', () => {
  /** `z.object` strips an unknown key, so only the value assertion fails when the schema loses `repoRoot`. */
  it('WorkflowStartedData_WithRepoRoot_Parses', () => {
    const result = WorkflowStartedData.safeParse({
      featureId: 'f1',
      workflowType: 'feature',
      repoRoot: '/home/user/exarchos',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.repoRoot).toBe('/home/user/exarchos');
  });

  /** Old stored events carry no `repoRoot`, so the field is optional. */
  it('WorkflowStartedData_WithoutRepoRoot_StillParses', () => {
    const result = WorkflowStartedData.safeParse({
      featureId: 'f1',
      workflowType: 'feature',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.repoRoot).toBeUndefined();
  });
});

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

describe('schemas_QualityHintGenerated_NotMarkedPlanned', () => {
  /** The test reads the three lines before the first line that names the schema. */
  it('schemas_QualityHintGenerated_NotMarkedPlanned', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const schemasPath = path.resolve(
      import.meta.dirname,
      '../../../src/events/schemas.ts',
    );
    const source = fs.readFileSync(schemasPath, 'utf-8');

    const lines = source.split('\n');
    const declIndex = lines.findIndex((l) =>
      l.includes('QualityHintGeneratedData'),
    );
    expect(declIndex).toBeGreaterThan(0);

    const preceding = lines
      .slice(Math.max(0, declIndex - 3), declIndex)
      .join('\n');
    expect(preceding).not.toContain('@planned');
  });
});

describe('schemas_ReviewFindingData_NotMarkedPlanned', () => {
  it('schemas_ReviewFindingData_NotMarkedPlanned', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const schemasPath = path.resolve(import.meta.dirname, '../../../src/events/schemas.ts');
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
    const schemasPath = path.resolve(import.meta.dirname, '../../../src/events/schemas.ts');
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
    const schemasPath = path.resolve(import.meta.dirname, '../../../src/events/schemas.ts');
    const source = fs.readFileSync(schemasPath, 'utf-8');
    const lines = source.split('\n');
    const declIndex = lines.findIndex((l) => l.includes('QualityRegressionData'));
    expect(declIndex).toBeGreaterThan(0);
    const preceding = lines.slice(Math.max(0, declIndex - 3), declIndex).join('\n');
    expect(preceding).not.toContain('@planned');
  });
});

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
    const shepherdTypes = ['shepherd.started', 'shepherd.iteration', 'shepherd.approval_requested', 'shepherd.escalated', 'shepherd.completed'];
    for (const t of shepherdTypes) {
      expect(EventTypes).toContain(t);
    }
  });
});

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
      runId: '11111111-1111-4111-8111-111111111111',
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
      runId: '11111111-1111-4111-8111-111111111111',
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
    });
    expect(result.success).toBe(false);
  });
});

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
    });
    expect(result.success).toBe(false);
  });
});

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
    });
    expect(result.success).toBe(false);
  });
});

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
    });
    expect(result.success).toBe(false);
  });
});

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
    });
    expect(result.success).toBe(false);
  });
});

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
    });
    expect(result.success).toBe(false);
  });
});

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
    });
    expect(result.success).toBe(false);
  });
});

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
    });
    expect(result.success).toBe(false);
  });
});

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

describe('registerEventType', () => {
  /** This hook removes the custom types that these tests register. */
  afterEach(() => {
    try { unregisterEventType('deploy.started'); } catch {}
    try { unregisterEventType('deploy.finished'); } catch {}
    try { unregisterEventType('custom.hello'); } catch {}
    try { unregisterEventType('deploy.rollback_started'); } catch {}
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

  /** One name grammar decides all three rejections, and each error names the clause that the name broke. */
  it('RegisterEventType_InvalidNameFormat_Throws', () => {
    expect(() =>
      registerEventType('nodot', { source: 'model' }),
    ).toThrow(/MISSING_SEPARATOR/);

    expect(() =>
      registerEventType('Deploy.Started', { source: 'model' }),
    ).toThrow(/NON_LOWERCASE_ALPHA/);

    expect(() =>
      registerEventType('', { source: 'model' }),
    ).toThrow(/MISSING_SEPARATOR/);
  });

  /**
   * The retired name pattern accepts this name, and the registration seam refuses it.
   * The error must carry the migration note, because the name was legal under that pattern.
   */
  it('RegisterEventType_NameTheRetiredPatternAdmitted_ThrowsNamingTheMigration', () => {
    const retiredPattern = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
    const name = 'my-app.started2';
    expect(retiredPattern.test(name)).toBe(true);

    expect(() => registerEventType(name, { source: 'auto' })).toThrow(MalformedEventNameError);
    expect(() => registerEventType(name, { source: 'auto' })).toThrow(EVENT_NAME_MIGRATION_NOTE);
    expect(getValidEventTypes()).not.toContain(name);
  });

  /**
   * The retired name pattern has no `_`, so it refuses this name, and the registration seam accepts it.
   * `WorkflowEventBase` refuses a type that is not in the registry, so the parse proves the type is usable.
   */
  it('RegisterEventType_SnakeCaseNameTheRetiredPatternRefused_NowRegisters', () => {
    const retiredPattern = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
    const name = 'deploy.rollback_started';
    expect(retiredPattern.test(name)).toBe(false);

    registerEventType(name, { source: 'auto' });
    expect(getValidEventTypes()).toContain(name);
    expect(() =>
      WorkflowEventBase.parse({ streamId: 'feat-x', sequence: 1, type: name }),
    ).not.toThrow();
  });

  it('RegisterEventType_WithSchema_RegistersInDataSchemas', () => {
    const schema = z.object({ url: z.string() });
    registerEventType('deploy.started', { source: 'hook', schema });

    expect(EVENT_DATA_SCHEMAS['deploy.started']).toBe(schema);
  });

  it('RegisterEventType_WithSource_RegistersInEmissionRegistry', () => {
    registerEventType('deploy.started', { source: 'hook' });

    expect(EVENT_EMISSION_REGISTRY['deploy.started']).toBe('hook');
  });
});

describe('unregisterEventType', () => {
  afterEach(() => {
    try { unregisterEventType('deploy.started'); } catch {}
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
    try { unregisterEventType('custom.hello'); } catch {}
  });

  it('GetValidEventTypes_ReturnsBuiltInPlusCustom', () => {
    const beforeCount = getValidEventTypes().length;

    registerEventType('custom.hello', { source: 'model' });

    const after = getValidEventTypes();
    expect(after.length).toBe(beforeCount + 1);
    expect(after).toContain('custom.hello');

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
    expect(catalog.types['task.completed'].hasSchema).toBe(true);
    expect(catalog.types['state.patched'].hasSchema).toBe(false);
  });

  it('SerializeEventCatalog_TotalCount_MatchesTypeCount', () => {
    const catalog = serializeEventCatalog();
    expect(catalog.totalCount).toBe(Object.keys(catalog.types).length);
  });
});

describe('Model-emitted event schema descriptions', () => {
  const modelEmittedTypes = Object.entries(EVENT_EMISSION_REGISTRY)
    .filter(([, source]) => source === 'model')
    .map(([type]) => type);

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
      if (!schema) continue;

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

describe('review.completed event type', () => {
  it('EventTypes_ContainsReviewCompleted', () => {
    expect(EventTypes).toContain('review.completed');
  });

  it('ReviewCompletedSchema_ValidData_Passes', async () => {
    const schemas = await import('../../../src/events/schemas.js');
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
    const schemas = await import('../../../src/events/schemas.js');
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

describe('WorkflowCheckpointWrittenData', () => {
  it('CheckpointWritten_ValidData_Parses', () => {
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

describe('WorkflowCheckpointSupersededData', () => {
  it('CheckpointSuperseded_ValidData_Parses', () => {
    expect(EventTypes).toContain('workflow.checkpoint_superseded');

    const schema = EVENT_DATA_SCHEMAS['workflow.checkpoint_superseded' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      priorSequence: 41,
      reason: 'stale-projection',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });
});

describe('WorkflowRehydratedData', () => {
  it('Rehydrated_ValidData_Parses', () => {
    expect(EventTypes).toContain('workflow.rehydrated');

    const schema = EVENT_DATA_SCHEMAS['workflow.rehydrated' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionSequence: 42,
      deliveryPath: 'direct',
      tokenEstimate: 1500,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('Rehydrated_InvalidDeliveryPath_Rejects', () => {
    const schema = EVENT_DATA_SCHEMAS['workflow.rehydrated' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionSequence: 42,
      deliveryPath: 'telepathy',
      tokenEstimate: 1500,
    });
    expect(result.success).toBe(false);
  });

  /** A stored event without the two playbook fields stays valid. */
  it('Rehydrated_LegacyPayload_ParsesWithoutPlaybookFields', () => {
    const schema = EVENT_DATA_SCHEMAS['workflow.rehydrated' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionSequence: 7,
      deliveryPath: 'snapshot',
      tokenEstimate: 800,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('Rehydrated_BothPlaybookFieldsTrue_Parses', () => {
    const schema = EVENT_DATA_SCHEMAS['workflow.rehydrated' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionSequence: 42,
      deliveryPath: 'direct',
      tokenEstimate: 1500,
      phaseHasPlaybook: true,
      phasePlaybookComposed: true,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  /** A playbook can exist and stay out of the envelope. */
  it('Rehydrated_AsymmetricPlaybookFields_Parses', () => {
    const schema = EVENT_DATA_SCHEMAS['workflow.rehydrated' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionSequence: 42,
      deliveryPath: 'ndjson',
      tokenEstimate: 2000,
      phaseHasPlaybook: true,
      phasePlaybookComposed: false,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('Rehydrated_PlaybookFieldStringValue_Rejects', () => {
    const schema = EVENT_DATA_SCHEMAS['workflow.rehydrated' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionSequence: 42,
      deliveryPath: 'direct',
      tokenEstimate: 1500,
      phaseHasPlaybook: 'yes',
    });
    expect(result.success).toBe(false);
  });
});

describe('WorkflowSnapshotTakenData', () => {
  it('SnapshotTaken_ValidData_Parses', () => {
    expect(EventTypes).toContain('workflow.snapshot_taken');

    const schema = EVENT_DATA_SCHEMAS['workflow.snapshot_taken' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionId: 'proj-001',
      sequence: 42,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });
});

describe('WorkflowProjectionDegradedData', () => {
  it('ProjectionDegraded_ValidData_Parses', () => {
    expect(EventTypes).toContain('workflow.projection_degraded');

    const schema = EVENT_DATA_SCHEMAS['workflow.projection_degraded' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = schema!.safeParse({
      projectionId: 'proj-001',
      cause: 'reducer-throw',
      fallbackSource: 'state-store-only',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  /** The server emits this degradation signal, so its source is `auto`. */
  it('ProjectionDegraded_ExposedInEmissionGuide_True', () => {
    expect(EVENT_EMISSION_REGISTRY).toHaveProperty('workflow.projection_degraded');
    expect(EVENT_EMISSION_REGISTRY['workflow.projection_degraded']).toBe('auto');

    const catalog = serializeEventCatalog();
    expect(catalog.bySource.auto).toContain('workflow.projection_degraded');
  });
});

describe('MergePreflightData', () => {
  it('MergePreflightEventSchema_ValidPayload_Parses', () => {
    expect(EventTypes).toContain('merge.preflight');

    const schema = EVENT_DATA_SCHEMAS['merge.preflight' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = MergePreflightData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      passed: true,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.taskId).toBe('T11');
      expect(result.data.sourceBranch).toBe('feat/x');
      expect(result.data.targetBranch).toBe('main');
      expect(result.data.passed).toBe(true);
    }
  });

  /** The guard sub-results must survive the parse, so events alone can rebuild the merge timeline. */
  it('MergePreflightEventSchema_NestedSubResults_RoundTrip', () => {
    const payload = {
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      passed: false,
      ancestry: {
        passed: false,
        reason: 'ancestry' as const,
        missing: ['main'],
      },
      currentBranchProtection: {
        blocked: false,
      },
      worktree: {
        isMain: true,
        actual: '/repo',
        expected: '/repo',
      },
      drift: {
        clean: true,
        uncommittedFiles: [],
        indexStale: false,
        detachedHead: false,
      },
      failureReasons: ['ancestry missing: main'],
    };
    const result = MergePreflightData.safeParse(payload);
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.ancestry?.missing).toEqual(['main']);
      expect(result.data.worktree?.isMain).toBe(true);
      expect(result.data.drift?.clean).toBe(true);
      expect(result.data.currentBranchProtection?.blocked).toBe(false);
      expect(result.data.failureReasons).toEqual(['ancestry missing: main']);
    }
  });

  /** A stored event without the nested sub-results stays valid. */
  it('MergePreflightEventSchema_LegacyPayloadWithoutSubResults_StillParses', () => {
    const result = MergePreflightData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      passed: true,
    });
    expect(result.success).toBe(true);
  });

  /**
   * The `debug` block is optional.
   * The emitter adds it only when `EXARCHOS_PREFLIGHT_DEBUG=1` and the ancestry check fails.
   */
  it('MergePreflightData_WithoutDebugBlock_ValidatesAgainstSchema', () => {
    const result = MergePreflightData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      passed: false,
      ancestry: { passed: false, reason: 'ancestry', missing: ['main'] },
      currentBranchProtection: { blocked: false },
      worktree: { isMain: true, actual: '/repo', expected: '/repo' },
      drift: {
        clean: true,
        uncommittedFiles: [],
        indexStale: false,
        detachedHead: false,
      },
      failureReasons: ['ancestry missing: main'],
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('MergePreflightData_WithDebugBlock_ValidatesAgainstSchema', () => {
    const result = MergePreflightData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      passed: false,
      ancestry: { passed: false, reason: 'ancestry', missing: ['main'] },
      currentBranchProtection: { blocked: false },
      worktree: { isMain: true, actual: '/repo', expected: '/repo' },
      drift: {
        clean: true,
        uncommittedFiles: [],
        indexStale: false,
        detachedHead: false,
      },
      failureReasons: ['ancestry missing: main'],
      debug: {
        gitVersion: 'git version 2.45.1',
        repoRoot: 'C:\\repos\\example',
        worktreeList: 'worktree C:/repos/example\nHEAD a\nbranch refs/heads/main\n',
        refsHeadsSource: { sha: 'a'.repeat(40), packed: false },
        refsHeadsTarget: { sha: 'b'.repeat(40), packed: false },
        mergeBaseCommand: ['git', 'merge-base', '--is-ancestor', 'main', 'feat/x'],
        mergeBaseExitCode: 1,
        mergeBaseStdout: '',
        mergeBaseStderr: '',
      },
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.debug?.gitVersion).toBe('git version 2.45.1');
      expect(result.data.debug?.refsHeadsSource.packed).toBe(false);
      expect(result.data.debug?.mergeBaseExitCode).toBe(1);
    }
  });
});

describe('MergeExecutedData', () => {
  it('MergeExecutedEventSchema_ValidPayload_Parses', () => {
    expect(EventTypes).toContain('merge.executed');

    const schema = EVENT_DATA_SCHEMAS['merge.executed' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = MergeExecutedData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      mergeSha: 'a'.repeat(40),
      rollbackSha: 'b'.repeat(40),
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.mergeSha).toBe('a'.repeat(40));
      expect(result.data.rollbackSha).toBe('b'.repeat(40));
    }
  });
});

describe('MergeRollbackData', () => {
  /** No emitter writes `merge.rollback`. The schema stays so that stored events replay. */
  it('MergeRollbackEventSchema_ValidPayload_Parses', () => {
    expect(EventTypes).toContain('merge.rollback');

    const schema = EVENT_DATA_SCHEMAS['merge.rollback' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const result = MergeRollbackData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      rollbackSha: 'b'.repeat(40),
      reason: 'merge-failed',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe('merge-failed');
    }
  });

  it('MergeRollbackEventSchema_UnknownReason_Rejects', () => {
    const result = MergeRollbackData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      rollbackSha: 'b'.repeat(40),
      reason: 'bogus',
    });
    expect(result.success).toBe(false);
  });

  /** `recoveryError` is a closed enum that names how the recovery failed. */
  it('MergeRollbackEventSchema_ValidRecoveryError_Parses', () => {
    const result = MergeRollbackData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      rollbackSha: 'b'.repeat(40),
      reason: 'verification-failed',
      rollbackError: 'git reset --hard exited 128',
      recoveryError: 'reset-failed',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.recoveryError).toBe('reset-failed');
    }
  });

  it('MergeRollbackEventSchema_UnknownRecoveryError_Rejects', () => {
    const result = MergeRollbackData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      rollbackSha: 'b'.repeat(40),
      reason: 'merge-failed',
      recoveryError: 'bogus',
    });
    expect(result.success).toBe(false);
  });

  /**
   * `merge.rollback` keeps its schema and type-map entry, so stored events replay.
   * Its source is `retired`, and a `retired` type must not appear in `autoEmits`.
   * Its successor `merge.recovered` is `auto`.
   */
  it('schemas_MergeRollback_ReadTolerantButNotEmittable', () => {
    expect(EventTypes).toContain('merge.rollback');
    const schema = EVENT_DATA_SCHEMAS['merge.rollback' as typeof EventTypes[number]];
    expect(schema).toBeDefined();
    expect(
      MergeRollbackData.safeParse({
        taskId: 'T11',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        rollbackSha: 'b'.repeat(40),
        reason: 'merge-failed',
      }).success,
    ).toBe(true);

    expect(EVENT_EMISSION_REGISTRY['merge.rollback']).toBe('retired');
    expect(EVENT_EMISSION_REGISTRY['merge.rollback']).not.toBe('auto');
    expect(EVENT_EMISSION_REGISTRY['merge.recovered']).toBe('auto');

    const catalog = serializeEventCatalog();
    expect(catalog.bySource.retired).toContain('merge.rollback');
    expect(catalog.bySource.auto).not.toContain('merge.rollback');
    expect(catalog.bySource.model).not.toContain('merge.rollback');
    expect(catalog.bySource.hook).not.toContain('merge.rollback');
    expect(catalog.bySource.planned).not.toContain('merge.rollback');
    expect(catalog.types['merge.rollback'].hasSchema).toBe(true);
  });
});

describe('MergeCompletedData', () => {
  it('MergeCompletedEventSchema_RegisteredInEventTypesAndDataSchemas', () => {
    expect(EventTypes).toContain('merge.completed');
    const schema = EVENT_DATA_SCHEMAS['merge.completed' as typeof EventTypes[number]];
    expect(schema).toBeDefined();
  });

  it('MergeCompletedEventSchema_ValidPayload_Parses', () => {
    const result = MergeCompletedData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      featureId: 'feat-1',
      mergeSha: 'a'.repeat(40),
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.mergeSha).toBe('a'.repeat(40));
      expect(result.data.featureId).toBe('feat-1');
    }
  });

  /** Without `mergeSha`, the terminal state of the projection loses its link to the merge commit. */
  it('MergeCompletedEventSchema_MissingMergeSha_Rejects', () => {
    const result = MergeCompletedData.safeParse({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
    });
    expect(result.success).toBe(false);
  });
});

/**
 * The command resolver emits `command.resolved` for audit.
 * Its `source` field separates a configured `null` command from an unresolved one.
 */
describe('CommandResolvedEventSchema', () => {
  it('CommandResolved_Registered_InEventTypesAndRegistry', () => {
    expect(EventTypes).toContain('command.resolved');
    expect(EVENT_EMISSION_REGISTRY['command.resolved']).toBe('auto');
    const schema = EVENT_DATA_SCHEMAS['command.resolved' as typeof EventTypes[number]];
    expect(schema).toBeDefined();
  });

  it('commandResolved_AllFieldsValid_AcceptsConfigSource', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'test',
      command: 'pytest',
      source: 'config',
      repoRoot: '/x',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.field).toBe('test');
      expect(result.data.command).toBe('pytest');
      expect(result.data.source).toBe('config');
      expect(result.data.repoRoot).toBe('/x');
    }
  });

  it('commandResolved_DetectionSource_Validates', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'typecheck',
      command: 'tsc --noEmit',
      source: 'detection',
      repoRoot: '/x',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('detection');
    }
  });

  it('commandResolved_ToolchainConfigSource_Validates', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'test',
      command: 'zig build test',
      source: 'toolchain-config',
      repoRoot: '/x',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('toolchain-config');
    }
  });

  it('commandResolved_TaskRunnerSource_Validates', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'test',
      command: 'task test',
      source: 'task-runner',
      repoRoot: '/x',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('task-runner');
    }
  });

  it('commandResolved_OverrideSource_Validates', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'install',
      command: 'npm ci',
      source: 'override',
      repoRoot: '/x',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('override');
    }
  });

  it('commandResolved_UnresolvedWithNullCommandAndRemediation_Validates', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'test',
      command: null,
      source: 'unresolved',
      repoRoot: '/x',
      remediation: 'set commands.test in .exarchos.yml',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.command).toBeNull();
      expect(result.data.source).toBe('unresolved');
      expect(result.data.remediation).toBe('set commands.test in .exarchos.yml');
    }
  });

  it('commandResolved_UnknownSource_Rejected', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'test',
      command: 'pytest',
      source: 'magic',
      repoRoot: '/x',
    });
    expect(result.success).toBe(false);
  });

  /** `field` is a closed enum of `test`, `typecheck` and `install`. */
  it('commandResolved_UnknownField_Rejected', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'lint',
      command: 'eslint .',
      source: 'config',
      repoRoot: '/x',
    });
    expect(result.success).toBe(false);
  });

  /** A resolver with no command emits `command: null` with `source: 'unresolved'`, not an empty string. */
  it('commandResolved_EmptyCommand_Rejected', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'test',
      command: '',
      source: 'config',
      repoRoot: '/x',
    });
    expect(result.success).toBe(false);
  });

  it('commandResolved_MissingRepoRoot_Rejected', () => {
    const result = CommandResolvedEventSchema.safeParse({
      field: 'test',
      command: 'pytest',
      source: 'config',
    });
    expect(result.success).toBe(false);
  });
});

/**
 * Orchestrators read the `task.assigned` shape from the published JSON schema.
 * That schema must list `branch` and must not mark it required.
 */
describe('TaskAssignedData hint catalog', () => {
  it('eventEmissionCatalog_TaskAssigned_OptionalBranchField', () => {
    const withBranch = TaskAssignedData.safeParse({
      taskId: 'T-001',
      title: 'Wire setup_worktree branch resolution',
      branch: 'feature/v290/T-001-branch-resolution',
    });
    expect(withBranch.success).toBe(true);

    const withoutBranch = TaskAssignedData.safeParse({
      taskId: 'T-002',
      title: 'No branch yet',
    });
    expect(withoutBranch.success).toBe(true);

    const json = zodToJsonSchema(TaskAssignedData) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(json.properties).toBeDefined();
    expect(json.properties).toHaveProperty('branch');
    const required = json.required ?? [];
    expect(required).not.toContain('branch');
  });
});

describe('HsmDeprecatedActionInvokedData', () => {
  it('EventSchemas_HsmDeprecatedActionInvoked_ValidatesAndRoundtrips', () => {
    expect(EventTypes).toContain('hsm.deprecated_action_invoked');
    const schema = EVENT_DATA_SCHEMAS['hsm.deprecated_action_invoked' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const payload = {
      action: 'set({phase})',
      invokedBy: 'orchestrator',
    };
    const result = HsmDeprecatedActionInvokedData.safeParse(payload);
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.action).toBe('set({phase})');
      expect(result.data.invokedBy).toBe('orchestrator');
    }
  });

  it('EventSchemas_HsmDeprecatedActionInvoked_MissingFields_Rejects', () => {
    const missingAction = HsmDeprecatedActionInvokedData.safeParse({ invokedBy: 'orchestrator' });
    expect(missingAction.success).toBe(false);

    const missingInvokedBy = HsmDeprecatedActionInvokedData.safeParse({ action: 'set({phase})' });
    expect(missingInvokedBy.success).toBe(false);
  });
});

describe('SpecLegacyCapabilitiesArrayData', () => {
  it('EventSchemas_SpecLegacyCapabilitiesArray_ValidatesAndRoundtrips', () => {
    expect(EventTypes).toContain('spec.legacy_capabilities_array');
    const schema = EVENT_DATA_SCHEMAS['spec.legacy_capabilities_array' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const payload = {
      specName: 'orchestrator-spec',
      capabilities: ['plan', 'delegate', 'merge'],
    };
    const result = SpecLegacyCapabilitiesArrayData.safeParse(payload);
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.specName).toBe('orchestrator-spec');
      expect(result.data.capabilities).toEqual(['plan', 'delegate', 'merge']);
    }
  });

  /** An empty array is still the legacy shape. */
  it('EventSchemas_SpecLegacyCapabilitiesArray_EmptyCapabilitiesAccepted', () => {
    const result = SpecLegacyCapabilitiesArrayData.safeParse({
      specName: 'empty-spec',
      capabilities: [],
    });
    expect(result.success).toBe(true);
  });

  it('EventSchemas_SpecLegacyCapabilitiesArray_MissingFields_Rejects', () => {
    const missingSpecName = SpecLegacyCapabilitiesArrayData.safeParse({ capabilities: ['x'] });
    expect(missingSpecName.success).toBe(false);

    const missingCapabilities = SpecLegacyCapabilitiesArrayData.safeParse({ specName: 's' });
    expect(missingCapabilities.success).toBe(false);
  });
});

/** Nothing emits this type. The schema stays so that old event logs decode. */
describe('PhaseContractMissingData', () => {
  it('EventSchemas_PhaseContractMissing_ValidatesAndRoundtrips', () => {
    expect(EventTypes).toContain('phase.contract_missing');
    const schema = EVENT_DATA_SCHEMAS['phase.contract_missing' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const payload = { phaseName: 'design' };
    const result = PhaseContractMissingData.safeParse(payload);
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.phaseName).toBe('design');
    }
  });

  it('EventSchemas_PhaseContractMissing_MissingPhaseName_Rejects', () => {
    const result = PhaseContractMissingData.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('MigrationLegacyJsonlImportedData', () => {
  it('EventSchemas_MigrationLegacyJsonlImported_ValidatesAndRoundtrips', () => {
    expect(EventTypes).toContain('migration.legacy_jsonl_imported');
    const schema = EVENT_DATA_SCHEMAS['migration.legacy_jsonl_imported' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const payload = {
      sourcePath: 'wf-1.events.jsonl',
      eventCount: 142,
      durationMs: 318,
    };
    const result = MigrationLegacyJsonlImportedData.safeParse(payload);
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.sourcePath).toBe('wf-1.events.jsonl');
      expect(result.data.eventCount).toBe(142);
      expect(result.data.durationMs).toBe(318);
    }
  });

  it('EventSchemas_MigrationLegacyJsonlImported_NegativeCount_Rejects', () => {
    const result = MigrationLegacyJsonlImportedData.safeParse({
      sourcePath: 'streams/x.jsonl',
      eventCount: -1,
      durationMs: 10,
    });
    expect(result.success).toBe(false);
  });

  /** An absolute path puts a machine-specific name in the log and blocks replay on another machine. */
  it('EventSchemas_MigrationLegacyJsonlImported_AbsolutePosixPath_Rejects', () => {
    const result = MigrationLegacyJsonlImportedData.safeParse({
      sourcePath: '/var/exarchos/streams/wf-1.events.jsonl',
      eventCount: 0,
      durationMs: 0,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = JSON.stringify(result.error.issues);
      expect(message).toMatch(/relative/i);
    }
  });

  it('EventSchemas_MigrationLegacyJsonlImported_AbsoluteWindowsPath_Rejects', () => {
    const result = MigrationLegacyJsonlImportedData.safeParse({
      sourcePath: 'C:\\Users\\dev\\.exarchos\\wf-1.events.jsonl',
      eventCount: 0,
      durationMs: 0,
    });
    expect(result.success).toBe(false);
  });

  it('EventSchemas_MigrationLegacyJsonlImported_RelativePath_Accepts', () => {
    const result = MigrationLegacyJsonlImportedData.safeParse({
      sourcePath: 'wf-1.events.jsonl',
      eventCount: 3,
      durationMs: 5,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.sourcePath).toBe('wf-1.events.jsonl');
    }
  });
});

describe('MigrationCompletedData', () => {
  it('EventSchemas_MigrationCompleted_ValidatesAndRoundtrips', () => {
    expect(EventTypes).toContain('migration.completed');
    const schema = EVENT_DATA_SCHEMAS['migration.completed' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const payload = {
      filesImported: 12,
      eventsImported: 4_532,
      totalDurationMs: 12_417,
    };
    const result = MigrationCompletedData.safeParse(payload);
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.filesImported).toBe(12);
      expect(result.data.eventsImported).toBe(4_532);
      expect(result.data.totalDurationMs).toBe(12_417);
    }
  });

  /** A run with zero files still records completion. */
  it('EventSchemas_MigrationCompleted_ZeroFilesAccepted', () => {
    const result = MigrationCompletedData.safeParse({
      filesImported: 0,
      eventsImported: 0,
      totalDurationMs: 4,
    });
    expect(result.success).toBe(true);
  });
});

describe('MigrationFailedData', () => {
  it('EventSchemas_MigrationFailed_ValidatesAndRoundtrips', () => {
    expect(EventTypes).toContain('migration.failed');
    const schema = EVENT_DATA_SCHEMAS['migration.failed' as typeof EventTypes[number]];
    expect(schema).toBeDefined();

    const payload = {
      reason: 'corrupt jsonl: parse error at line 42',
      partialFilesImported: 3,
      partialEventsImported: 211,
    };
    const result = MigrationFailedData.safeParse(payload);
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe('corrupt jsonl: parse error at line 42');
      expect(result.data.partialFilesImported).toBe(3);
      expect(result.data.partialEventsImported).toBe(211);
    }
  });

  /** `reason` is the diagnostic that the operator reads. */
  it('EventSchemas_MigrationFailed_EmptyReason_Rejects', () => {
    const result = MigrationFailedData.safeParse({
      reason: '',
      partialFilesImported: 0,
      partialEventsImported: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe('SessionMachineryConsumedDataSchema', () => {
  /** A dispatch-core interceptor emits this event, so its source is `auto`. */
  it('EventEmissionRegistry_SessionMachineryConsumed_IsAutoSource', () => {
    expect(EVENT_EMISSION_REGISTRY).toHaveProperty('session.machinery_consumed');
    expect(EVENT_EMISSION_REGISTRY['session.machinery_consumed' as keyof typeof EVENT_EMISSION_REGISTRY]).toBe('auto');
  });

  it('EventSchemas_SessionMachineryConsumed_ValidPayload_ParsesSuccessfully', () => {
    const result = SessionMachineryConsumedDataSchema.safeParse({
      rehydrateSequence: 0,
      firstActionVerb: 'task_complete',
      firstActionAt: '2026-05-09T20:00:00.000Z',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('EventSchemas_SessionMachineryConsumed_NegativeRehydrateSequence_Rejects', () => {
    const result = SessionMachineryConsumedDataSchema.safeParse({
      rehydrateSequence: -1,
      firstActionVerb: 'task_complete',
      firstActionAt: '2026-05-09T20:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('EventSchemas_SessionMachineryConsumed_NonIsoTimestamp_Rejects', () => {
    const result = SessionMachineryConsumedDataSchema.safeParse({
      rehydrateSequence: 0,
      firstActionVerb: 'task_complete',
      firstActionAt: 'not-an-iso-timestamp',
    });
    expect(result.success).toBe(false);
  });

  it('EventSchemas_SessionMachineryConsumed_MissingRehydrateSequence_Rejects', () => {
    const result = SessionMachineryConsumedDataSchema.safeParse({
      firstActionVerb: 'task_complete',
      firstActionAt: '2026-05-09T20:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('EventSchemas_SessionMachineryConsumed_MissingFirstActionVerb_Rejects', () => {
    const result = SessionMachineryConsumedDataSchema.safeParse({
      rehydrateSequence: 0,
      firstActionAt: '2026-05-09T20:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('EventSchemas_SessionMachineryConsumed_MissingFirstActionAt_Rejects', () => {
    const result = SessionMachineryConsumedDataSchema.safeParse({
      rehydrateSequence: 0,
      firstActionVerb: 'task_complete',
    });
    expect(result.success).toBe(false);
  });
});

/**
 * These tests check that the ten two-event split types are registered.
 * Each schema must accept a canonical payload and reject a broken one.
 * Handler idempotency is not in scope.
 */
describe('EventSchemaRegistry_RegistersAllNewTwoEventSplitTypes', () => {
  const TWO_EVENT_TYPES = [
    'pr.create.requested',
    'pr.create.executed',
    'pr.comment.requested',
    'pr.comment.executed',
    'issue.create.requested',
    'issue.create.executed',
    'branch.delete.requested',
    'branch.delete.executed',
    'worktree.remove.requested',
    'worktree.remove.executed',
  ] as const;

  it('B6_AllTenTypes_RegisteredInEventTypesArray', () => {
    for (const eventType of TWO_EVENT_TYPES) {
      expect(EventTypes).toContain(eventType);
    }
  });

  it('B6_AllTenTypes_HaveSchemaInEventDataSchemas', () => {
    for (const eventType of TWO_EVENT_TYPES) {
      expect(EVENT_DATA_SCHEMAS).toHaveProperty(eventType);
      expect(
        (EVENT_DATA_SCHEMAS as Partial<Record<string, unknown>>)[eventType],
      ).toBeDefined();
    }
  });

  it('B6_AllTenTypes_HaveAutoEmissionSource', () => {
    for (const eventType of TWO_EVENT_TYPES) {
      expect(
        (EVENT_EMISSION_REGISTRY as Record<string, EventEmissionSource>)[eventType],
      ).toBe('auto');
    }
  });

  it('B6_PrCreateRequested_ValidPayload_Accepts', () => {
    const result = PrCreateRequestedData.safeParse({
      operationId: '11111111-1111-4111-8111-111111111111',
      title: 'feat: add new feature',
      body: 'This PR adds a new feature.',
      base: 'main',
      head: 'feature/my-feature',
      draft: false,
      labels: ['enhancement'],
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_PrCreateExecuted_ValidPayload_Accepts', () => {
    const result = PrCreateExecutedData.safeParse({
      operationId: '11111111-1111-4111-8111-111111111111',
      prNumber: 42,
      url: 'https://github.com/lvlup-sw/exarchos/pull/42',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_PrCommentRequested_ValidPayload_Accepts', () => {
    const result = PrCommentRequestedData.safeParse({
      operationId: '22222222-2222-4222-8222-222222222222',
      prNumber: 42,
      body: 'LGTM! Approved.',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_PrCommentExecuted_ValidPayload_Accepts', () => {
    const result = PrCommentExecutedData.safeParse({
      operationId: '22222222-2222-4222-8222-222222222222',
      commentId: 99001,
      url: 'https://github.com/lvlup-sw/exarchos/pull/42#issuecomment-99001',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_IssueCreateRequested_ValidPayload_Accepts', () => {
    const result = IssueCreateRequestedData.safeParse({
      operationId: '33333333-3333-4333-8333-333333333333',
      title: 'Bug: something is broken',
      body: 'Steps to reproduce...',
      labels: ['bug'],
      assignees: ['reed'],
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_IssueCreateExecuted_ValidPayload_Accepts', () => {
    const result = IssueCreateExecutedData.safeParse({
      operationId: '33333333-3333-4333-8333-333333333333',
      issueNumber: 1342,
      url: 'https://github.com/lvlup-sw/exarchos/issues/1342',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_BranchDeleteRequested_ValidPayload_Accepts', () => {
    const result = BranchDeleteRequestedData.safeParse({
      operationId: '44444444-4444-4444-8444-444444444444',
      branch: 'feature/old-branch',
      remote: 'origin',
      localOnly: false,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_BranchDeleteExecuted_ValidPayload_Accepts', () => {
    const result = BranchDeleteExecutedData.safeParse({
      operationId: '44444444-4444-4444-8444-444444444444',
      branch: 'feature/old-branch',
      deletedLocally: true,
      deletedRemote: true,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_WorktreeRemoveRequested_ValidPayload_Accepts', () => {
    const result = WorktreeRemoveRequestedData.safeParse({
      operationId: '55555555-5555-4555-8555-555555555555',
      worktreePath: '/home/user/repo/.claude/worktrees/agent-abc123',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('B6_WorktreeRemoveExecuted_ValidPayload_Accepts', () => {
    const result = WorktreeRemoveExecutedData.safeParse({
      operationId: '55555555-5555-4555-8555-555555555555',
      worktreePath: '/home/user/repo/.claude/worktrees/agent-abc123',
      removed: true,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  /** Each `requested` type requires `operationId`, because it is the idempotency anchor. */
  it('B6_PrCreateRequested_MissingOperationId_Rejects', () => {
    const result = PrCreateRequestedData.safeParse({
      title: 'feat: add new feature',
      body: 'This PR adds a new feature.',
      base: 'main',
      head: 'feature/my-feature',
    });
    expect(result.success).toBe(false);
  });

  it('B6_PrCommentRequested_MissingOperationId_Rejects', () => {
    const result = PrCommentRequestedData.safeParse({
      prNumber: 42,
      body: 'LGTM! Approved.',
    });
    expect(result.success).toBe(false);
  });

  it('B6_IssueCreateRequested_MissingOperationId_Rejects', () => {
    const result = IssueCreateRequestedData.safeParse({
      title: 'Bug: something is broken',
      body: 'Steps to reproduce...',
    });
    expect(result.success).toBe(false);
  });

  it('B6_BranchDeleteRequested_MissingOperationId_Rejects', () => {
    const result = BranchDeleteRequestedData.safeParse({
      branch: 'feature/old-branch',
    });
    expect(result.success).toBe(false);
  });

  it('B6_WorktreeRemoveRequested_MissingOperationId_Rejects', () => {
    const result = WorktreeRemoveRequestedData.safeParse({
      worktreePath: '/home/user/repo/.claude/worktrees/agent-abc123',
    });
    expect(result.success).toBe(false);
  });

  /** `operationId` must be a UUID. */
  it('B6_PrCreateRequested_InvalidOperationId_Rejects', () => {
    const result = PrCreateRequestedData.safeParse({
      operationId: 'not-a-uuid',
      title: 'feat: add new feature',
      body: 'This PR adds a new feature.',
      base: 'main',
      head: 'feature/my-feature',
    });
    expect(result.success).toBe(false);
  });
});

describe('EventStoreSchemas_ToolActionErrored_HasRegisteredType', () => {
  it('includes tool.action_errored in the EventType union', () => {
    expect((EventTypes as readonly string[])).toContain('tool.action_errored');
  });

  it('classifies tool.action_errored as auto-emitted', () => {
    expect(
      EVENT_EMISSION_REGISTRY['tool.action_errored' as keyof typeof EVENT_EMISSION_REGISTRY],
    ).toBe('auto');
  });

  it('has a data schema accepting the action-errored shape', () => {
    const schema = EVENT_DATA_SCHEMAS['tool.action_errored' as keyof typeof EVENT_DATA_SCHEMAS];
    expect(schema).toBeDefined();
    if (!schema) return;
    const valid = schema.safeParse({
      tool: 'exarchos_orchestrate',
      durationMs: 12,
      errorCode: 'RESERVED_FIELD',
      responseBytes: 220,
      tokenEstimate: 55,
    });
    expect(valid.success).toBe(true);

    const missingCode = schema.safeParse({
      tool: 'exarchos_orchestrate',
      durationMs: 12,
      responseBytes: 220,
      tokenEstimate: 55,
    });
    expect(missingCode.success).toBe(false);

    const missingTool = schema.safeParse({
      durationMs: 12,
      errorCode: 'X',
      responseBytes: 0,
      tokenEstimate: 0,
    });
    expect(missingTool.success).toBe(false);
  });

  it('accepts a full WorkflowEventBase append carrying tool.action_errored', () => {
    const event = WorkflowEventBase.safeParse({
      streamId: 'telemetry',
      sequence: 1,
      timestamp: '2026-05-15T00:00:00.000Z',
      type: 'tool.action_errored',
      schemaVersion: '1.0',
      data: {
        tool: 'exarchos_orchestrate',
        durationMs: 12,
        errorCode: 'MERGE_ROLLED_BACK',
        responseBytes: 220,
        tokenEstimate: 55,
      },
    });
    expect(event.success).toBe(true);
  });
});

describe('merge.recovered (#1306 successor to merge.rollback)', () => {
  const recoveredSchema = (
    EVENT_DATA_SCHEMAS as Record<string, { parse: (v: unknown) => unknown } | undefined>
  )['merge.recovered'];

  it('MergeRecovered_RegisteredWithRecoveryShape_ParsesValidPayload', () => {
    expect(recoveredSchema).toBeDefined();
    const parsed = recoveredSchema!.parse({
      taskId: 't-1',
      sourceBranch: 'feat/x',
      targetBranch: 'integration',
      recoveryPointSha: 'abc123',
      reason: 'timeout',
      recoveryErrorDetail: 'git reset --keep abc123 exited 1',
      recoveryError: 'reset-failed',
    });
    expect(parsed).toMatchObject({
      recoveryPointSha: 'abc123',
      recoveryError: 'reset-failed',
    });
  });

  it('MergeRecovered_RejectsMissingRecoveryPointSha', () => {
    expect(recoveredSchema).toBeDefined();
    expect(() =>
      recoveredSchema!.parse({ sourceBranch: 'a', targetBranch: 'b', reason: 'merge-failed' }),
    ).toThrow();
  });
});

describe('merge.retry_attempt (#1308 transient-failure retry)', () => {
  const retrySchema = (
    EVENT_DATA_SCHEMAS as Record<string, { parse: (v: unknown) => unknown } | undefined>
  )['merge.retry_attempt'];

  it('Schemas_MergeRetryAttempt_Registered', () => {
    expect(EventTypes).toContain('merge.retry_attempt');
    expect(retrySchema).toBeDefined();
    const parsed = retrySchema!.parse({
      attempt: 2,
      delayMs: 500,
      reason: 'timeout',
    });
    expect(parsed).toMatchObject({
      attempt: 2,
      delayMs: 500,
      reason: 'timeout',
    });
  });
});

describe('merge.executing_started (#1309 liveness event)', () => {
  const startedSchema = (
    EVENT_DATA_SCHEMAS as Record<string, { parse: (v: unknown) => unknown } | undefined>
  )['merge.executing_started'];

  it('Schemas_MergeExecutingStarted_Registered', () => {
    expect(EventTypes).toContain('merge.executing_started');
    expect(startedSchema).toBeDefined();
    const parsed = startedSchema!.parse({
      taskId: 't-1',
      sourceBranch: 'feat/x',
      targetBranch: 'integration',
      recoveryPointSha: 'abc123',
      startedAt: '2026-06-21T00:00:00.000Z',
    });
    expect(parsed).toMatchObject({
      sourceBranch: 'feat/x',
      targetBranch: 'integration',
      recoveryPointSha: 'abc123',
      startedAt: '2026-06-21T00:00:00.000Z',
    });
  });

  /** A direct CLI call has no task context, so `taskId` is optional. */
  it('MergeExecutingStarted_TaskIdOptional_ParsesWithoutIt', () => {
    expect(startedSchema).toBeDefined();
    const parsed = startedSchema!.parse({
      sourceBranch: 'feat/x',
      targetBranch: 'integration',
      recoveryPointSha: 'abc123',
      startedAt: '2026-06-21T00:00:00.000Z',
    });
    expect(parsed).toMatchObject({ recoveryPointSha: 'abc123' });
  });

  it('MergeExecutingStarted_RejectsMissingRecoveryPointSha', () => {
    expect(startedSchema).toBeDefined();
    expect(() =>
      startedSchema!.parse({
        sourceBranch: 'feat/x',
        targetBranch: 'integration',
        startedAt: '2026-06-21T00:00:00.000Z',
      }),
    ).toThrow();
  });
});

/**
 * These schemas are the lease and ownership half of the worktree lifecycle.
 * Only `worktree.reserved` requires a non-null `ownerPid`.
 */
describe('WLM worktree lifecycle schemas', () => {
  const NEW_LIFECYCLE_TYPES = [
    'worktree.adopted',
    'worktree.reserved',
    'worktree.released',
    'worktree.orphan_detected',
  ] as const;

  const wellFormed = (
    type: (typeof NEW_LIFECYCLE_TYPES)[number],
    operationId: string,
  ): Record<string, unknown> => {
    const base = {
      worktreeId: '/repo/.worktrees/agent-abc',
      path: '/repo/.worktrees/agent-abc',
      featureId: 'feat-001',
      operationId,
    };
    return type === 'worktree.reserved'
      ? { ...base, ownerPid: 4242, ownerStartedAt: '2026-06-25T00:00:00.000Z' }
      : { ...base, ownerPid: null, ownerStartedAt: null };
  };

  it('WorktreeSchemas_FourNewLifecycleTypes_RegisteredAndValidate', () => {
    for (const type of NEW_LIFECYCLE_TYPES) {
      expect(EventTypes, `${type} missing from EventTypes`).toContain(type);
      expect(EVENT_EMISSION_REGISTRY[type], `${type} should be classified 'auto'`).toBe('auto');

      const schema = EVENT_DATA_SCHEMAS[type];
      expect(schema, `${type} missing from EVENT_DATA_SCHEMAS`).toBeDefined();

      const parsed = schema!.parse(wellFormed(type, randomUUID())) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        worktreeId: '/repo/.worktrees/agent-abc',
        path: '/repo/.worktrees/agent-abc',
        featureId: 'feat-001',
      });
      expect(typeof parsed.operationId).toBe('string');
    }
  });

  it('WorktreeSchemas_FeatureIdNullAndReservedOwner_BehaveAsSpecified', () => {
    const reserved = WorktreeReservedData.parse(
      wellFormed('worktree.reserved', randomUUID()),
    );
    expect(reserved.ownerPid).toBe(4242);
    expect(reserved.ownerStartedAt).toBe('2026-06-25T00:00:00.000Z');

    const adopted = WorktreeAdoptedData.parse({
      worktreeId: '/repo/.worktrees/orphan',
      path: '/repo/.worktrees/orphan',
      featureId: null,
      operationId: randomUUID(),
      ownerPid: null,
      ownerStartedAt: null,
    });
    expect(adopted.featureId).toBeNull();
    expect(adopted.ownerPid).toBeNull();
  });

  /**
   * `ownerStartedAt` is null when the platform cannot resolve the create time of the reserving process.
   * The schema accepts null or a non-empty string and rejects the empty string.
   */
  it('WorktreeSchemas_ReservedOwnerStartedAt_NullReadyNeverEmptyString', () => {
    const base = {
      worktreeId: '/repo/.worktrees/agent-abc',
      path: '/repo/.worktrees/agent-abc',
      featureId: 'feat-001',
      operationId: randomUUID(),
      ownerPid: 4242,
    };

    const nullStart = WorktreeReservedData.parse({ ...base, ownerStartedAt: null });
    expect(nullStart.ownerStartedAt).toBeNull();
    expect(nullStart.ownerPid).toBe(4242);

    const resolved = WorktreeReservedData.parse({
      ...base,
      ownerStartedAt: '2026-06-25T00:00:00.000Z',
    });
    expect(resolved.ownerStartedAt).toBe('2026-06-25T00:00:00.000Z');

    expect(() =>
      WorktreeReservedData.parse({ ...base, ownerStartedAt: '' }),
    ).toThrow();
  });

  /**
   * Garbage collection reuses the remove pair, so no `worktree.pruned` type exists.
   * The optional `worktreeId` lets the reducer drop a worktree by its canonical key
   * without `realpath()` at fold time.
   * The parse does not add an absent `worktreeId` to the result.
   */
  it('WorktreeSchemas_ReuseExistingRemoveRequestedExecuted_NotDuplicated', () => {
    for (const forbidden of ['worktree.pruned']) {
      expect(EventTypes as readonly string[]).not.toContain(forbidden);
      expect(EVENT_DATA_SCHEMAS as Record<string, unknown>).not.toHaveProperty(forbidden);
    }

    expect(EventTypes).toContain('worktree.remove.requested');
    expect(EventTypes).toContain('worktree.remove.executed');
    const requested = WorktreeRemoveRequestedData.parse({
      operationId: randomUUID(),
      worktreePath: '/repo/.worktrees/gc-me',
    }) as Record<string, unknown>;
    expect(requested).not.toHaveProperty('worktreeId');
    const executed = WorktreeRemoveExecutedData.parse({
      operationId: randomUUID(),
      worktreePath: '/repo/.worktrees/gc-me',
      removed: true,
    }) as Record<string, unknown>;
    expect(executed).not.toHaveProperty('worktreeId');

    const stampedReq = WorktreeRemoveRequestedData.parse({
      operationId: randomUUID(),
      worktreePath: '/repo/.worktrees/gc-me',
      worktreeId: '/repo/.worktrees/gc-me',
    });
    expect(stampedReq.worktreeId).toBe('/repo/.worktrees/gc-me');
    const stampedExe = WorktreeRemoveExecutedData.parse({
      operationId: randomUUID(),
      worktreePath: '/repo/.worktrees/gc-me',
      removed: true,
      worktreeId: '/repo/.worktrees/gc-me',
    });
    expect(stampedExe.worktreeId).toBe('/repo/.worktrees/gc-me');
  });

  /** The test builds the `<eventType>:<operationId>` key itself from the parsed payload. */
  it('WorktreeSchemas_LifecycleKey_IncludesOperationId', () => {
    const operationId = randomUUID();
    const schema = EVENT_DATA_SCHEMAS['worktree.reserved'];
    expect(schema).toBeDefined();
    const parsed = schema!.parse(wellFormed('worktree.reserved', operationId)) as {
      operationId: string;
    };

    const key = `worktree.reserved:${parsed.operationId}`;
    expect(key.split(':')).toHaveLength(2);
    expect(key).toBe(`worktree.reserved:${operationId}`);
    expect(key.endsWith(operationId)).toBe(true);
  });

  /**
   * The `operationId` of each call, not the path, separates the keys.
   * The test builds the three keys itself.
   */
  it('WorktreeSchemas_ReserveReleaseReacquire_ProducesDistinctKeys_NoSilentCollapse', () => {
    const steps: Array<[(typeof NEW_LIFECYCLE_TYPES)[number], string]> = [
      ['worktree.reserved', randomUUID()],
      ['worktree.released', randomUUID()],
      ['worktree.reserved', randomUUID()],
    ];

    const keys = steps.map(([type, operationId]) => {
      const schema = EVENT_DATA_SCHEMAS[type];
      expect(schema, `${type} missing from EVENT_DATA_SCHEMAS`).toBeDefined();
      const parsed = schema!.parse(wellFormed(type, operationId)) as { operationId: string };
      return `${type}:${parsed.operationId}`;
    });

    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).not.toBe(keys[2]);
    expect(keys[0].startsWith('worktree.reserved:')).toBe(true);
    expect(keys[2].startsWith('worktree.reserved:')).toBe(true);
  });

  it('WorktreeSchemas_MalformedPayload_RejectedByZod', () => {
    const operationId = randomUUID();

    expect(() =>
      WorktreeReservedData.parse({
        path: '/repo/.worktrees/agent-abc',
        featureId: 'feat-001',
        operationId,
        ownerPid: 4242,
        ownerStartedAt: '2026-06-25T00:00:00.000Z',
      }),
    ).toThrow();

    expect(() =>
      WorktreeReservedData.parse({
        ...wellFormed('worktree.reserved', operationId),
        ownerPid: null,
      }),
    ).toThrow();

    expect(() =>
      WorktreeOrphanDetectedData.parse({
        ...wellFormed('worktree.orphan_detected', operationId),
        path: 1234,
      }),
    ).toThrow();

    expect(() =>
      WorktreeReleasedData.parse({
        ...wellFormed('worktree.released', operationId),
        operationId: 'not-a-uuid',
      }),
    ).toThrow();
  });
});

/**
 * `worktree.merge_requested` claims the merge lease and `worktree.merge_executed` releases it.
 * Both events are on the singleton `worktrees` stream.
 * `operationId` is the only discriminator, so two merges onto one `integrationRef` have distinct keys.
 */
describe('WLM operational-core merge lease schemas', () => {
  const MERGE_TYPES = ['worktree.merge_requested', 'worktree.merge_executed'] as const;

  const wellFormedRequested = (operationId: string, integrationRef = 'integration/wlm'): Record<string, unknown> => ({
    integrationRef,
    sourceBranch: 'task/wlm-oc-001',
    operationId,
    holderPid: 4242,
    holderStartedAt: '2026-06-25T00:00:00.000Z',
  });

  const wellFormedExecuted = (operationId: string, integrationRef = 'integration/wlm'): Record<string, unknown> => ({
    integrationRef,
    operationId,
    status: 'merged',
    mergeSha: 'a'.repeat(40),
  });

  it('EventTypes_IncludesWorktreeMergeRequestedAndExecuted', () => {
    expect(EventTypes).toContain('worktree.merge_requested');
    expect(EventTypes).toContain('worktree.merge_executed');
  });

  /** The count pins the size of the catalog, and the set check proves that no type is a duplicate. */
  it('EventTypes_CountPins_159_AdmissionProofSchemasAreAdditive', () => {
    expect(EventTypes).toHaveLength(184);
    expect(new Set(EventTypes).size).toBe(EventTypes.length);
  });

  /**
   * The catalog declares the three ledger names as built-in types with a data schema.
   * A runtime registration puts a name in the custom set.
   * That name has no `EventDataMap` entry and no coupling annotation.
   * The test reads the names from the constants of the mutation owner, so a rename on one side fails.
   * A custom name still registers, so the two `toThrow` checks are facts about these three names.
   */
  it('VcsLedgerEvents_RuntimeSeam_IsNoLongerUsed', () => {
    const LEDGER = [
      mutationOwner.VCS_REQUESTED,
      mutationOwner.VCS_EXECUTED,
      mutationOwner.VCS_COMPENSATED,
    ];
    expect(LEDGER).toEqual(['vcs.requested', 'vcs.executed', 'vcs.compensated']);

    for (const name of LEDGER) {
      expect(isBuiltInEventType(name), `${name} is not a built-in event type`).toBe(true);
      expect(getValidEventTypes()).toContain(name);

      expect(() => registerEventType(name, { source: 'auto' })).toThrow(
        /collides with built-in event type/,
      );
      expect(() => unregisterEventType(name)).toThrow(/Cannot unregister built-in/);

      expect(EVENT_DATA_SCHEMAS[name], `${name} has no data schema`).toBeDefined();
    }

    expect(Object.keys(mutationOwner)).not.toContain('ensureVcsMutationEventTypes');

    const custom = `custom.ledger-probe-${randomUUID().slice(0, 8).replace(/[^a-z]/g, 'x')}`;
    expect(() => registerEventType(custom, { source: 'auto' })).not.toThrow();
    expect(isBuiltInEventType(custom)).toBe(false);
    unregisterEventType(custom);

    const catalog = serializeEventCatalog();
    for (const name of LEDGER) {
      expect(catalog.types[name]).toEqual({ source: 'auto', isBuiltIn: true, hasSchema: true });
    }
  });

  /**
   * The ledger fold reads `epoch`, `idempotencyKey` and `kind` from each event.
   * A missing `epoch` must fail the parse.
   * Zero is a real epoch, so a default of zero removes the fence from a stale writer.
   * The terminal fields `result` and `error` are optional.
   */
  it('VcsLedgerData_Payloads_CarryTheFoldedFields', () => {
    const head = { kind: 'branch.create', idempotencyKey: 'key-1', epoch: 3 };

    expect(VcsRequestedData.parse(head)).toEqual(head);
    expect(VcsExecutedData.parse({ ...head, result: { branch: 'feat/x', created: true } })).toEqual({
      ...head,
      result: { branch: 'feat/x', created: true },
    });
    expect(VcsCompensatedData.parse({ ...head, error: 'git worktree add failed' })).toEqual({
      ...head,
      error: 'git worktree add failed',
    });

    expect(VcsExecutedData.parse(head)).toEqual(head);
    expect(VcsCompensatedData.parse(head)).toEqual(head);

    expect(() => VcsRequestedData.parse({ kind: 'branch.create', idempotencyKey: 'k' })).toThrow();
    expect(() => VcsRequestedData.parse({ ...head, idempotencyKey: '' })).toThrow();
    expect(() => VcsRequestedData.parse({ ...head, epoch: 1.5 })).toThrow();
  });

  /**
   * The plan, the owner and the digest come from the production functions, so a promoter rename fails here.
   * The dry run must not write a file or record an event, so the recorder throws.
   * The source is `planned`: the type has a schema and no emitter.
   * `recoveredPriorAttempt` is required, because a default of `false` hides a recovered run.
   * `admission.cutover-ready` says that a cutover can proceed, and its schema rejects this payload.
   */
  it('PromotionEvent_AtomicPromotionSite_HasARegisteredName', async () => {
    const entries = [
      { path: 'SKILL.md', content: '# promote me\n' },
      { path: 'references/one.md', content: 'reference body\n' },
    ];
    const target = nodePath.join(tmpdir(), `exarchos-promotion-${randomUUID()}`, 'skills');

    const outcome = await promoteTree({ target, entries }, DRY_RUN, defaultPromotionIo(), () => {
      throw new Error('a dry-run promotion must never record');
    });
    expect(isDryRun(outcome), 'the promotion site did not withhold the effect').toBe(true);
    if (!isDryRun(outcome)) return;
    const plan = outcome.plan;
    expect(plan.effectClass).toBe('install');
    expect(plan.description).toContain(target);
    expect(plan).toEqual(promotionPlan(plan.owner, target));

    const PROMOTION = 'promotion.executed';
    expect(EventTypes).toContain(PROMOTION);
    expect(isBuiltInEventType(PROMOTION), `${PROMOTION} is not a built-in event type`).toBe(true);
    expect(getValidEventTypes()).toContain(PROMOTION);
    expect(EVENT_DATA_SCHEMAS[PROMOTION], `${PROMOTION} has no data schema`).toBeDefined();
    expect(serializeEventCatalog().types[PROMOTION]).toEqual({
      source: 'planned',
      isBuiltIn: true,
      hasSchema: true,
    });

    const payload = {
      target,
      treeDigest: digestTree(entries),
      owner: plan.owner,
      recoveredPriorAttempt: false,
    };
    expect(PromotionExecutedData.parse(payload)).toEqual(payload);

    expect(() => PromotionExecutedData.parse({ ...payload, target: '' })).toThrow();
    expect(() => PromotionExecutedData.parse({ ...payload, treeDigest: '' })).toThrow();
    expect(() => PromotionExecutedData.parse({ ...payload, owner: '' })).toThrow();
    const withoutRecovery = { target: payload.target, treeDigest: payload.treeDigest, owner: payload.owner };
    expect(() => PromotionExecutedData.parse(withoutRecovery)).toThrow();

    expect(EventTypes).toContain('admission.cutover-ready');
    expect(EVENT_DATA_SCHEMAS[PROMOTION]).not.toBe(EVENT_DATA_SCHEMAS['admission.cutover-ready']);
    expect(() => AdmissionCutoverReadyData.parse(payload)).toThrow();
  });

  /**
   * The post-dispatch verifier writes this report, so a finding stays after the run.
   * One action can declare several emissions, so `action` alone is not a report.
   * An empty `missingEvents` with no `lifecycleViolations` must fail, because that report has no evidence.
   * The report keeps the full set of missing names, not the first one.
   * The schema rejects a promotion payload, which proves that it is not a passthrough.
   */
  it('EmissionViolation_Registered_CarriesActionAndMissingSet', () => {
    const VIOLATION = 'emission.violated';

    expect(EventTypes).toContain(VIOLATION);
    expect(isBuiltInEventType(VIOLATION), `${VIOLATION} is not a built-in event type`).toBe(true);
    expect(getValidEventTypes()).toContain(VIOLATION);
    expect(EVENT_DATA_SCHEMAS[VIOLATION], `${VIOLATION} has no data schema`).toBeDefined();
    expect(serializeEventCatalog().types[VIOLATION]).toEqual({
      source: 'auto',
      isBuiltIn: true,
      hasSchema: true,
    });

    const report = {
      action: 'exarchos_workflow.transition',
      missingEvents: ['workflow.transition', 'phase.blocked'],
      operationId: 'op-8f21c4',
    };
    expect(EmissionViolatedData.parse(report)).toEqual(report);

    expect(() => EmissionViolatedData.parse({ action: report.action })).toThrow();
    expect(() =>
      EmissionViolatedData.parse({ action: report.action, operationId: report.operationId }),
    ).toThrow();
    expect(() =>
      EmissionViolatedData.parse({ action: report.action, missingEvents: report.missingEvents }),
    ).toThrow();

    expect(() => EmissionViolatedData.parse({ ...report, missingEvents: [] })).toThrow();
    expect(() => EmissionViolatedData.parse({ ...report, missingEvents: [''] })).toThrow();

    const three = {
      ...report,
      missingEvents: ['vcs.requested', 'vcs.executed', 'promotion.executed'],
    };
    expect(EmissionViolatedData.parse(three).missingEvents).toEqual(three.missingEvents);

    expect(() => EmissionViolatedData.parse({ ...report, action: '' })).toThrow();
    expect(() => EmissionViolatedData.parse({ ...report, operationId: '' })).toThrow();

    const promotionPayload = {
      target: '/tmp/exarchos-skills',
      treeDigest: 'sha256-abc',
      owner: 'install/atomic-promotion',
      recoveredPriorAttempt: false,
    };
    expect(() => EmissionViolatedData.parse(promotionPayload)).toThrow();
    expect(() => PromotionExecutedData.parse(report)).toThrow();
    expect(EVENT_DATA_SCHEMAS[VIOLATION]).not.toBe(EVENT_DATA_SCHEMAS['promotion.executed']);
  });

  /** Deterministic code appends the merge pair, so each type is `auto`. */
  it('WorktreeMergeEvents_ClassificationMaps_Exhaustive', () => {
    for (const type of MERGE_TYPES) {
      expect(EVENT_EMISSION_REGISTRY[type], `${type} should be classified 'auto'`).toBe('auto');
      const schema = EVENT_DATA_SCHEMAS[type];
      expect(schema, `${type} missing from EVENT_DATA_SCHEMAS`).toBeDefined();
    }

    const requested = WorktreeMergeRequestedData.parse(wellFormedRequested(randomUUID()));
    expect(requested).toMatchObject({
      integrationRef: 'integration/wlm',
      sourceBranch: 'task/wlm-oc-001',
      holderPid: 4242,
      holderStartedAt: '2026-06-25T00:00:00.000Z',
    });
    expect(requested as Record<string, unknown>).not.toHaveProperty('worktreeId');
    expect(
      (WorktreeMergeRequestedData.parse({ ...wellFormedRequested(randomUUID()), worktreeId: '/repo/.worktrees/x' }))
        .worktreeId,
    ).toBe('/repo/.worktrees/x');

    const executed = WorktreeMergeExecutedData.parse(wellFormedExecuted(randomUUID()));
    expect(executed.status).toBe('merged');
    expect(executed.mergeSha).toBe('a'.repeat(40));
    expect(() =>
      WorktreeMergeExecutedData.parse({ ...wellFormedExecuted(randomUUID()), status: 'bogus' }),
    ).toThrow();
    expect(
      (WorktreeMergeExecutedData.parse({ ...wellFormedExecuted(randomUUID()), recoveryError: 'holder pid dead' }))
        .recoveryError,
    ).toBe('holder pid dead');
  });

  /**
   * Two merges onto one `integrationRef` must have distinct idempotency keys.
   * The test builds the claim keys and the release keys itself from the parsed payloads.
   */
  it('WorktreeMergeEvents_IdempotencyKey_PerOperationId_NoCollisionAcrossMergesOnSameBranch', () => {
    const integrationRef = 'integration/wlm';
    const opA = randomUUID();
    const opB = randomUUID();

    const streamId = 'worktrees';
    const reducerId = 'worktrees@v1';
    const claimA = WorktreeMergeRequestedData.parse(wellFormedRequested(opA, integrationRef));
    const claimB = WorktreeMergeRequestedData.parse(wellFormedRequested(opB, integrationRef));
    const claimKeyA = `${streamId}:${reducerId}:${claimA.operationId}`;
    const claimKeyB = `${streamId}:${reducerId}:${claimB.operationId}`;
    expect(claimKeyA).not.toBe(claimKeyB);
    expect(claimA.integrationRef).toBe(claimB.integrationRef);
    expect(claimA.operationId).not.toBe(claimB.operationId);

    const relA = WorktreeMergeExecutedData.parse(wellFormedExecuted(opA, integrationRef));
    const relB = WorktreeMergeExecutedData.parse(wellFormedExecuted(opB, integrationRef));
    const relKeyA = `worktree.merge_executed:${relA.operationId}`;
    const relKeyB = `worktree.merge_executed:${relB.operationId}`;
    expect(relKeyA.split(':')).toHaveLength(2);
    expect(relKeyA).not.toBe(relKeyB);

    expect(new Set([claimKeyA, claimKeyB, relKeyA, relKeyB]).size).toBe(4);
    expect(relA.operationId).toBe(claimA.operationId);
  });

  /**
   * The workflow-state projection folds both merge events to identity.
   * Its exhaustive default throws on an unhandled built-in type, so a missing case arm fails here.
   * The built-in check proves that the event reaches the switch and not the early return for custom types.
   */
  it('WorkflowStateProjection_HandlesNewWorktreeMergeTypes_Exhaustive', () => {
    const baseView = workflowStateProjection.init();
    for (const type of MERGE_TYPES) {
      const data = type === 'worktree.merge_requested' ? wellFormedRequested(randomUUID()) : wellFormedExecuted(randomUUID());
      const event = {
        streamId: 'worktrees',
        sequence: 1,
        timestamp: '2026-06-25T00:00:00.000Z',
        type,
        schemaVersion: '1.0',
        data,
      } as unknown as WorkflowEvent;

      expect(isBuiltInEventType(type)).toBe(true);
      let next: typeof baseView | undefined;
      expect(() => {
        next = workflowStateProjection.apply(baseView, event);
      }, `${type} must be handled by the projection switch, not the never-default`).not.toThrow();
      expect(next).toEqual(baseView);
    }
  });
});

describe('harness-launcher event schemas (DR-2)', () => {
  const NEW_TYPES = [
    'worktree.create.requested',
    'worktree.create.executed',
    'launch.executing_started',
    'launch.executed',
  ] as const;

  it('EventTypes_IncludesCreatePairAndLaunch', () => {
    for (const type of NEW_TYPES) {
      expect(EventTypes).toContain(type);
    }
  });

  /** The launcher pair `worktree.create` leaves the task-scoped `worktree.created` type as it is. */
  it('EventTypes_WorktreeCreated_Untouched', () => {
    expect(EventTypes).toContain('worktree.created');
    expect(EVENT_EMISSION_REGISTRY['worktree.created']).toBe('model');

    const ok = WorktreeCreatedData.parse({
      taskId: 'task-001',
      path: '/abs/worktree',
      branch: 'task/foo',
    });
    expect(ok).toMatchObject({ taskId: 'task-001', branch: 'task/foo' });

    expect(() => WorktreeCreatedData.parse({ path: '/abs/worktree', branch: 'task/foo' })).toThrow();
    expect(() => WorktreeCreatedData.parse({ taskId: 'task-001', path: '/abs/worktree' })).toThrow();
  });

  /**
   * The start payload carries the holder fields that a dead-holder reconciler needs.
   * The terminal accepts a null `exitCode` for a child that a signal ended or whose code is not captured.
   */
  it('LaunchExecutingStarted_CarriesWorktreeIdAndHolderPid', () => {
    const parsed = LaunchExecutingStartedData.parse({
      worktreeId: '/abs/launch-worktree',
      holderPid: 4242,
      holderStartedAt: '2026-07-02T00:00:00.000Z',
    });
    expect(parsed).toMatchObject({
      worktreeId: '/abs/launch-worktree',
      holderPid: 4242,
      holderStartedAt: '2026-07-02T00:00:00.000Z',
    });

    expect(() =>
      LaunchExecutingStartedData.parse({
        worktreeId: '/abs/launch-worktree',
        holderStartedAt: '2026-07-02T00:00:00.000Z',
      }),
    ).toThrow();

    expect(
      LaunchExecutedData.parse({ worktreeId: '/abs/launch-worktree', exitCode: null }).exitCode,
    ).toBeNull();
  });

  /** Deterministic code appends all four types around `git worktree add` and around the child process. */
  it('EmissionRegistry_FourNewTypes_ClassifiedAuto', () => {
    for (const type of NEW_TYPES) {
      expect(EVENT_EMISSION_REGISTRY[type], `${type} should be classified 'auto'`).toBe('auto');
      const schema = EVENT_DATA_SCHEMAS[type];
      expect(schema, `${type} missing from EVENT_DATA_SCHEMAS`).toBeDefined();
    }

    const opId = randomUUID();
    expect(
      WorktreeCreateRequestedData.parse({ operationId: opId, worktreePath: '/abs/launch-worktree' }).operationId,
    ).toBe(opId);
    expect(
      WorktreeCreateExecutedData.parse({ operationId: opId, worktreePath: '/abs/launch-worktree', created: true }).created,
    ).toBe(true);
  });
});

/**
 * Each of the four liveness pairs (merge, launch, mutation, prune) has an optional `instanceId`.
 * The fixtures hold the stored payload shapes, and none carries `instanceId`.
 * A payload without `instanceId` must stay valid.
 * `instanceId` is a typed field, so a wrong-typed or empty value must fail.
 * If the schema does not know the key, Zod strips the value and the malformed payload passes.
 */
describe('DR-2 liveness instanceId retrofit', () => {
  const LIVENESS_PAIR_FIXTURES = [
    {
      surface: 'merge',
      startedType: 'merge.executing_started',
      startedSchema: MergeExecutingStartedData,
      started: {
        taskId: 'T11',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        recoveryPointSha: 'b'.repeat(40),
        startedAt: '2026-06-21T00:00:00.000Z',
      },
      terminalType: 'merge.executed',
      terminalSchema: MergeExecutedData,
      terminal: {
        taskId: 'T11',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        strategy: 'squash',
        mergeSha: 'a'.repeat(40),
        rollbackSha: 'b'.repeat(40),
      },
      instanceId: 'T11',
    },
    {
      surface: 'launch',
      startedType: 'launch.executing_started',
      startedSchema: LaunchExecutingStartedData,
      started: {
        worktreeId: '/srv/wt/launch-a',
        holderPid: 4242,
        holderStartedAt: 'boot-4242',
      },
      terminalType: 'launch.executed',
      terminalSchema: LaunchExecutedData,
      terminal: { worktreeId: '/srv/wt/launch-a', exitCode: 0 },
      instanceId: '/srv/wt/launch-a',
    },
    {
      surface: 'mutation',
      startedType: 'mutation.executing_started',
      startedSchema: MutationExecutingStartedData,
      started: { command: 'npx stryker run', repoRoot: '/repo' },
      terminalType: 'mutation.executed',
      terminalSchema: MutationExecutedData,
      terminal: { command: 'npx stryker run', repoRoot: '/repo', passed: true, exitCode: 0 },
      instanceId: 'op-mutation-1',
    },
    {
      surface: 'prune',
      startedType: 'prune.executing_started',
      startedSchema: PruneExecutingStartedData,
      started: { operationId: 'op-prune-1', repoRoot: '/repo', holderPid: 7777, holderStartedAt: null },
      terminalType: 'prune.executed',
      terminalSchema: PruneExecutedData,
      terminal: { operationId: 'op-prune-1', deletedCount: 0 },
      instanceId: 'op-prune-1',
    },
  ] as const;

  it('ExecutingStartedSchemas_PreviouslyEmittedPayloadFixtures_StillValidate', () => {
    for (const f of LIVENESS_PAIR_FIXTURES) {
      const started = f.startedSchema.safeParse(f.started);
      expect(started.success, `${f.startedType}: ${JSON.stringify(started)}`).toBe(true);
      const terminal = f.terminalSchema.safeParse(f.terminal);
      expect(terminal.success, `${f.terminalType}: ${JSON.stringify(terminal)}`).toBe(true);

      expect(EVENT_DATA_SCHEMAS[f.startedType as typeof EventTypes[number]]).toBeDefined();
      expect(EVENT_DATA_SCHEMAS[f.terminalType as typeof EventTypes[number]]).toBeDefined();
    }
  });

  /** The parse adds no default `instanceId`, so replay of a stored row gives the same bytes. */
  it('LegacyPayloadsWithoutInstanceId_StillValidate', () => {
    for (const f of LIVENESS_PAIR_FIXTURES) {
      expect(Object.prototype.hasOwnProperty.call(f.started, 'instanceId')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(f.terminal, 'instanceId')).toBe(false);

      const startedParsed = f.startedSchema.parse(f.started) as { instanceId?: string };
      const terminalParsed = f.terminalSchema.parse(f.terminal) as { instanceId?: string };
      expect(startedParsed.instanceId).toBeUndefined();
      expect(terminalParsed.instanceId).toBeUndefined();

      expect(f.startedSchema.safeParse({ ...f.started, instanceId: f.instanceId }).success).toBe(true);
      expect(f.terminalSchema.safeParse({ ...f.terminal, instanceId: f.instanceId }).success).toBe(true);
    }
  });

  /** If the schema loses `instanceId`, Zod strips the bad value and this test fails. */
  it('ExecutingStartedSchemas_RejectMalformedPayload', () => {
    for (const f of LIVENESS_PAIR_FIXTURES) {
      expect(f.startedSchema.safeParse({ ...f.started, instanceId: f.instanceId }).success).toBe(true);
      expect(f.terminalSchema.safeParse({ ...f.terminal, instanceId: f.instanceId }).success).toBe(true);

      expect(
        f.startedSchema.safeParse({ ...f.started, instanceId: 123 }).success,
        `${f.startedType}: number instanceId must be rejected`,
      ).toBe(false);
      expect(
        f.terminalSchema.safeParse({ ...f.terminal, instanceId: 123 }).success,
        `${f.terminalType}: number instanceId must be rejected`,
      ).toBe(false);

      expect(
        f.startedSchema.safeParse({ ...f.started, instanceId: '' }).success,
        `${f.startedType}: empty instanceId must be rejected`,
      ).toBe(false);
      expect(
        f.terminalSchema.safeParse({ ...f.terminal, instanceId: '' }).success,
        `${f.terminalType}: empty instanceId must be rejected`,
      ).toBe(false);
    }
  });

  /**
   * A payload that went through JSON must validate with `instanceId` and without it.
   * The event log can hold both forms.
   */
  it('LivenessPairSchemas_SerializationRoundTrip_ValidateWithAndWithoutInstanceId', () => {
    for (const f of LIVENESS_PAIR_FIXTURES) {
      const variants: Array<{ label: string; started: unknown; terminal: unknown }> = [
        { label: 'without instanceId (legacy)', started: f.started, terminal: f.terminal },
        {
          label: 'with instanceId (retrofit)',
          started: { ...f.started, instanceId: f.instanceId },
          terminal: { ...f.terminal, instanceId: f.instanceId },
        },
      ];
      for (const v of variants) {
        const started = JSON.parse(JSON.stringify(v.started));
        const terminal = JSON.parse(JSON.stringify(v.terminal));
        expect(
          f.startedSchema.safeParse(started).success,
          `${f.startedType} ${v.label}`,
        ).toBe(true);
        expect(
          f.terminalSchema.safeParse(terminal).success,
          `${f.terminalType} ${v.label}`,
        ).toBe(true);
      }
    }
  });

  /**
   * The test reads `instanceId` from the Zod shape of each of the eight schemas.
   * The test does not import the mixin, so a missing field fails an assertion and not an import.
   */
  it('LivenessInstanceFields_SharedMixin_IsAppliedToAllEightSchemas', () => {
    for (const f of LIVENESS_PAIR_FIXTURES) {
      const startedShape = (f.startedSchema as unknown as { shape: Record<string, unknown> }).shape;
      const terminalShape = (f.terminalSchema as unknown as { shape: Record<string, unknown> }).shape;
      expect(startedShape, `${f.startedType} shape must carry instanceId`).toHaveProperty('instanceId');
      expect(terminalShape, `${f.terminalType} shape must carry instanceId`).toHaveProperty('instanceId');
    }
  });
});

/**
 * `export` writes a zip bundle outside `.exarchos/`, which is a non-idempotent external effect.
 * `export.requested` records the resolved path before the write.
 * `export.executed` records the content hash after the write.
 * The composite handler appends both, so each one is `auto`.
 * The tests read the schemas from `EVENT_DATA_SCHEMAS`.
 * As a result, an unregistered type fails an assertion and not an import.
 */
describe('Export event contract (DR-6, lifecycle-verbs task 012)', () => {
  const requestedSchema = () => EVENT_DATA_SCHEMAS['export.requested'];
  const executedSchema = () => EVENT_DATA_SCHEMAS['export.executed'];

  const validRequested = () => ({
    featureId: 'feat-export-1',
    outputPath: '/repo/feat-export-1-export.zip',
    idempotencyKey: 'feat-export-1:export:/repo/feat-export-1-export.zip',
  });

  const validExecuted = () => ({
    featureId: 'feat-export-1',
    outputPath: '/repo/feat-export-1-export.zip',
    contentHash: 'sha256:'.concat('a'.repeat(64)),
    eventCount: 42,
    idempotencyKey: 'feat-export-1:export:/repo/feat-export-1-export.zip',
  });

  it('ExportEventSchemas_RequestedExecutedPair_RegisteredWithEmissionSource', () => {
    expect(EventTypes).toContain('export.requested');
    expect(EventTypes).toContain('export.executed');

    expect(EVENT_EMISSION_REGISTRY['export.requested']).toBe('auto');
    expect(EVENT_EMISSION_REGISTRY['export.executed']).toBe('auto');

    expect(requestedSchema()).toBeDefined();
    expect(executedSchema()).toBeDefined();

    const catalog = serializeEventCatalog();
    expect(catalog.bySource.auto).toContain('export.requested');
    expect(catalog.bySource.auto).toContain('export.executed');
    expect(catalog.types['export.requested']).toEqual({ source: 'auto', isBuiltIn: true, hasSchema: true });
    expect(catalog.types['export.executed']).toEqual({ source: 'auto', isBuiltIn: true, hasSchema: true });
  });

  /**
   * `outputPath` is required, so the timeline shows the destination after a crash during the write.
   * An empty `idempotencyKey` must fail, because it merges unrelated exports into one.
   */
  it('ExportRequested_CarriesResolvedPathIntent', () => {
    const schema = requestedSchema();
    expect(schema).toBeDefined();

    expect(schema!.safeParse(validRequested()).success).toBe(true);

    const parsed = schema!.parse(validRequested()) as { outputPath: string };
    expect(parsed.outputPath).toBe('/repo/feat-export-1-export.zip');

    expect(schema!.safeParse({ featureId: 'f', idempotencyKey: 'k' }).success).toBe(false);
    expect(schema!.safeParse({ ...validRequested(), outputPath: '' }).success).toBe(false);
    expect(schema!.safeParse({ ...validRequested(), outputPath: 123 }).success).toBe(false);
    expect(schema!.safeParse({ outputPath: '/x.zip', idempotencyKey: 'k' }).success).toBe(false);
    expect(schema!.safeParse({ featureId: 'f', outputPath: '/x.zip' }).success).toBe(false);
    expect(schema!.safeParse({ ...validRequested(), idempotencyKey: '' }).success).toBe(false);
  });

  /** Each payload goes through JSON before the parse, as a stored event does. */
  it('ExportEventSchemas_Serialization_ValidPayloadsValidate_MalformedReject', () => {
    const requested = requestedSchema();
    const executed = executedSchema();
    expect(requested).toBeDefined();
    expect(executed).toBeDefined();

    const validCases: Array<{ label: string; schema: z.ZodSchema; payload: Record<string, unknown> }> = [
      { label: 'export.requested (minimal)', schema: requested!, payload: validRequested() },
      { label: 'export.executed (minimal)', schema: executed!, payload: validExecuted() },
      {
        label: 'export.executed (with tolerated missingArtifacts)',
        schema: executed!,
        payload: { ...validExecuted(), missingArtifacts: ['artifacts/plan.md', 'storage/artifacts/review.json'] },
      },
      {
        label: 'export.executed (empty missingArtifacts — nothing missing)',
        schema: executed!,
        payload: { ...validExecuted(), missingArtifacts: [] },
      },
    ];
    for (const c of validCases) {
      const roundTripped = JSON.parse(JSON.stringify(c.payload));
      expect(c.schema.safeParse(roundTripped).success, c.label).toBe(true);
    }

    const malformedCases: Array<{ label: string; schema: z.ZodSchema; payload: Record<string, unknown> }> = [
      { label: 'requested: missing outputPath', schema: requested!, payload: { featureId: 'f', idempotencyKey: 'k' } },
      { label: 'requested: empty idempotencyKey', schema: requested!, payload: { ...validRequested(), idempotencyKey: '' } },
      { label: 'executed: missing contentHash', schema: executed!, payload: (() => { const p = validExecuted() as Record<string, unknown>; delete p.contentHash; return p; })() },
      { label: 'executed: empty contentHash', schema: executed!, payload: { ...validExecuted(), contentHash: '' } },
      { label: 'executed: fractional eventCount', schema: executed!, payload: { ...validExecuted(), eventCount: 4.5 } },
      { label: 'executed: negative eventCount', schema: executed!, payload: { ...validExecuted(), eventCount: -1 } },
      { label: 'executed: missingArtifacts wrong element type', schema: executed!, payload: { ...validExecuted(), missingArtifacts: [123] } },
    ];
    for (const c of malformedCases) {
      const roundTripped = JSON.parse(JSON.stringify(c.payload));
      expect(c.schema.safeParse(roundTripped).success, c.label).toBe(false);
    }
  });
});
