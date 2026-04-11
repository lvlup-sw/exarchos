import { describe, it, expect } from 'vitest';
import { ArtifactsSchema, SynthesisSchema, TaskStatusSchema } from './schemas.js';
import { z } from 'zod';

// ─── TaskStatusSchema alias tests ─────────────────────────────────────────

describe('TaskStatusSchema', () => {
  it('TaskStatusSchema_CompletedAlias_NormalizesToComplete', () => {
    const result = TaskStatusSchema.safeParse('completed');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('complete');
    }
  });

  it('TaskStatusSchema_Complete_ParsesUnchanged', () => {
    const result = TaskStatusSchema.safeParse('complete');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('complete');
    }
  });

  it('TaskStatusSchema_InvalidValue_Rejects', () => {
    const result = TaskStatusSchema.safeParse('done');
    expect(result.success).toBe(false);
  });
});

// ─── Schema Passthrough Tests ──────────────────────────────────────────────

describe('ArtifactsSchema passthrough', () => {
  it('ArtifactsSchema_UnknownFields_PreservedThroughParse', () => {
    const input = {
      design: 'design.md',
      plan: 'plan.md',
      pr: null,
      rca: 'rca-doc.md',
    };
    const result = ArtifactsSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).rca).toBe('rca-doc.md');
    }
  });

  it('ArtifactsSchema_FixDesignField_PreservedThroughParse', () => {
    const input = {
      design: null,
      plan: null,
      pr: null,
      fixDesign: 'fix-design.md',
    };
    const result = ArtifactsSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).fixDesign).toBe('fix-design.md');
    }
  });
});

describe('SynthesisSchema passthrough', () => {
  it('SynthesisSchema_UnknownFields_PreservedThroughParse', () => {
    const input = {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
      customField: 'value',
    };
    const result = SynthesisSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).customField).toBe('value');
    }
  });
});

// T1: TestingStrategySchema and PerformanceSLASchema tests
describe('PerformanceSLASchema', () => {
  it('PerformanceSLASchema_Valid_Parses', async () => {
    const { PerformanceSLASchema } = await import('./schemas.js');
    const input = { metric: 'p95', threshold: 100, unit: 'ms' };
    const result = PerformanceSLASchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('PerformanceSLASchema_InvalidUnit_Rejects', async () => {
    const { PerformanceSLASchema } = await import('./schemas.js');
    const input = { metric: 'p95', threshold: 100, unit: 'seconds' };
    const result = PerformanceSLASchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('TestingStrategySchema', () => {
  it('TestingStrategySchema_ValidMinimal_Parses', async () => {
    const { TestingStrategySchema } = await import('./schemas.js');
    const input = { exampleTests: true, propertyTests: false, benchmarks: false };
    const result = TestingStrategySchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('TestingStrategySchema_WithProperties_Parses', async () => {
    const { TestingStrategySchema } = await import('./schemas.js');
    const input = {
      exampleTests: true,
      propertyTests: true,
      benchmarks: false,
      properties: ['roundtrip', 'idempotence'],
    };
    const result = TestingStrategySchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('TestingStrategySchema_WithPerformanceSLAs_Parses', async () => {
    const { TestingStrategySchema } = await import('./schemas.js');
    const input = {
      exampleTests: true,
      propertyTests: false,
      benchmarks: true,
      performanceSLAs: [
        { metric: 'p95', threshold: 100, unit: 'ms' },
        { metric: 'throughput', threshold: 5000, unit: 'ops/s' },
      ],
    };
    const result = TestingStrategySchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('TestingStrategySchema_MissingRequired_Rejects', async () => {
    const { TestingStrategySchema } = await import('./schemas.js');
    const input = { propertyTests: false, benchmarks: false };
    const result = TestingStrategySchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// T2: TaskSchema with testingStrategy tests
describe('TaskSchema with testingStrategy', () => {
  it('TaskSchema_WithTestingStrategy_Parses', async () => {
    const { TaskSchema } = await import('./schemas.js');
    const input = {
      id: 'task-001',
      title: 'Implement parser',
      status: 'pending',
      testingStrategy: {
        exampleTests: true,
        propertyTests: true,
        benchmarks: false,
        properties: ['roundtrip'],
      },
    };
    const result = TaskSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('TaskSchema_WithoutTestingStrategy_StillValid', async () => {
    const { TaskSchema } = await import('./schemas.js');
    const input = {
      id: 'task-002',
      title: 'Add logging',
      status: 'pending',
    };
    const result = TaskSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('TaskSchema_InvalidTestingStrategy_Rejects', async () => {
    const { TaskSchema } = await import('./schemas.js');
    const input = {
      id: 'task-003',
      title: 'Bad task',
      status: 'pending',
      testingStrategy: {
        propertyTests: true,
        // missing exampleTests (required)
      },
    };
    const result = TaskSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ─── _esVersion field tests ───────────────────────────────────────────────

describe('WorkflowStateSchema _esVersion field', () => {
  it('WorkflowStateSchema_EsVersionField_AcceptsVersion2', async () => {
    const { WorkflowStateSchema } = await import('./schemas.js');
    const input = {
      version: '1.1',
      workflowType: 'feature',
      featureId: 'test-feature',
      phase: 'ideate',
      createdAt: '2026-02-19T00:00:00Z',
      updatedAt: '2026-02-19T00:00:00Z',
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
      integration: null,
      synthesis: {
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: null,
        prFeedback: [],
      },
      _esVersion: 2,
    };
    const result = WorkflowStateSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data._esVersion).toBe(2);
    }
  });

  it('WorkflowStateSchema_EsVersionField_OptionalForLegacy', async () => {
    const { WorkflowStateSchema } = await import('./schemas.js');
    const input = {
      version: '1.1',
      workflowType: 'feature',
      featureId: 'test-feature',
      phase: 'ideate',
      createdAt: '2026-02-19T00:00:00Z',
      updatedAt: '2026-02-19T00:00:00Z',
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
      integration: null,
      synthesis: {
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: null,
        prFeedback: [],
      },
    };
    const result = WorkflowStateSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data._esVersion).toBeUndefined();
    }
  });

  it('WorkflowStateSchema_EsVersionField_RejectsNonInteger', async () => {
    const { WorkflowStateSchema } = await import('./schemas.js');
    const input = {
      version: '1.1',
      workflowType: 'feature',
      featureId: 'test-feature',
      phase: 'ideate',
      createdAt: '2026-02-19T00:00:00Z',
      updatedAt: '2026-02-19T00:00:00Z',
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
      integration: null,
      synthesis: {
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: null,
        prFeedback: [],
      },
      _esVersion: 1.5,
    };
    const result = WorkflowStateSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('WorkflowStateSchema_EsVersionField_RejectsZero', async () => {
    const { WorkflowStateSchema } = await import('./schemas.js');
    const input = {
      version: '1.1',
      workflowType: 'feature',
      featureId: 'test-feature',
      phase: 'ideate',
      createdAt: '2026-02-19T00:00:00Z',
      updatedAt: '2026-02-19T00:00:00Z',
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
      integration: null,
      synthesis: {
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: null,
        prFeedback: [],
      },
      _esVersion: 0,
    };
    const result = WorkflowStateSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ─── TaskSchema Agent Tracking Fields ─────────────────────────────────────

describe('TaskSchema agent tracking fields', () => {
  it('TaskSchema_AgentId_AcceptsOptionalString', async () => {
    const { TaskSchema } = await import('./schemas.js');
    const input = {
      id: 'task-010',
      title: 'Extend state schema',
      status: 'in_progress',
      agentId: 'agent-abc-123',
    };
    const result = TaskSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentId).toBe('agent-abc-123');
    }
  });

  it('TaskSchema_AgentResumed_AcceptsOptionalBoolean', async () => {
    const { TaskSchema } = await import('./schemas.js');
    const input = {
      id: 'task-010',
      title: 'Extend state schema',
      status: 'in_progress',
      agentResumed: true,
    };
    const result = TaskSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentResumed).toBe(true);
    }
  });

  it('TaskSchema_LastExitReason_AcceptsOptionalString', async () => {
    const { TaskSchema } = await import('./schemas.js');
    const input = {
      id: 'task-010',
      title: 'Extend state schema',
      status: 'complete',
      lastExitReason: 'subtask_completed',
    };
    const result = TaskSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lastExitReason).toBe('subtask_completed');
    }
  });

  it('TaskSchema_BackwardCompatible_AcceptsWithoutNewFields', async () => {
    const { TaskSchema } = await import('./schemas.js');
    const input = {
      id: 'task-010',
      title: 'Extend state schema',
      status: 'pending',
    };
    const result = TaskSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentId).toBeUndefined();
      expect(result.data.agentResumed).toBeUndefined();
      expect(result.data.lastExitReason).toBeUndefined();
    }
  });
});

// T6: oneshot workflow type + schema
describe('Oneshot workflow type and schema', () => {
  const baseOneshotFixture = {
    version: '1.1',
    workflowType: 'oneshot' as const,
    featureId: 'oneshot-test',
    phase: 'plan',
    createdAt: '2026-04-11T00:00:00Z',
    updatedAt: '2026-04-11T00:00:00Z',
    artifacts: { design: null, plan: null, pr: null },
    tasks: [],
    worktrees: {},
    reviews: {},
    integration: null,
    synthesis: {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    },
  };

  it('workflowTypeSchema_acceptsOneshot', async () => {
    const { WorkflowTypeSchema } = await import('./schemas.js');
    const result = WorkflowTypeSchema.safeParse('oneshot');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('oneshot');
    }
  });

  it('workflowTypeSchema_getValidWorkflowTypesIncludesOneshot', async () => {
    const { getValidWorkflowTypes } = await import('./schemas.js');
    expect(getValidWorkflowTypes()).toContain('oneshot');
  });

  it('oneshotStateSchema_acceptsValidState', async () => {
    const { WorkflowStateSchema } = await import('./schemas.js');
    const input = {
      ...baseOneshotFixture,
      oneshot: {
        synthesisPolicy: 'always',
        planSummary: 'Add a config flag',
      },
    };
    const result = WorkflowStateSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.workflowType).toBe('oneshot');
      const oneshot = data.oneshot as Record<string, unknown> | undefined;
      expect(oneshot?.synthesisPolicy).toBe('always');
      expect(oneshot?.planSummary).toBe('Add a config flag');
    }
  });

  it('oneshotStateSchema_rejectsInvalidSynthesisPolicy', async () => {
    const { WorkflowStateSchema } = await import('./schemas.js');
    const input = {
      ...baseOneshotFixture,
      oneshot: {
        synthesisPolicy: 'maybe',
      },
    };
    const result = WorkflowStateSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('oneshotStateSchema_defaultsSynthesisPolicyToOnRequest', async () => {
    const { WorkflowStateSchema } = await import('./schemas.js');
    const input = {
      ...baseOneshotFixture,
      oneshot: {},
    };
    const result = WorkflowStateSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      const oneshot = data.oneshot as Record<string, unknown> | undefined;
      expect(oneshot?.synthesisPolicy).toBe('on-request');
    }
  });

  it('oneshotStateSchema_oneshotFieldIsOptional', async () => {
    const { WorkflowStateSchema } = await import('./schemas.js');
    const result = WorkflowStateSchema.safeParse(baseOneshotFixture);
    expect(result.success).toBe(true);
  });
});

// T3: WorkflowState integration validation
describe('WorkflowState integration', () => {
  it('WorkflowState_TasksWithTestingStrategy_Parses', async () => {
    const { WorkflowStateSchema } = await import('./schemas.js');
    const input = {
      version: '1.1',
      workflowType: 'feature',
      featureId: 'test-feature',
      phase: 'delegate',
      createdAt: '2026-02-17T00:00:00Z',
      updatedAt: '2026-02-17T00:00:00Z',
      artifacts: { design: null, plan: null, pr: null },
      tasks: [
        {
          id: 'task-001',
          title: 'Implement parser',
          status: 'pending',
          testingStrategy: {
            exampleTests: true,
            propertyTests: true,
            benchmarks: false,
            properties: ['roundtrip', 'idempotence'],
          },
        },
        {
          id: 'task-002',
          title: 'Add logging',
          status: 'pending',
        },
      ],
      worktrees: {},
      reviews: {},
      integration: null,
      synthesis: {
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: null,
        prFeedback: [],
      },
    };
    const result = WorkflowStateSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      const task0 = result.data.tasks[0] as Record<string, unknown>;
      expect(task0.testingStrategy).toBeDefined();
    }
  });
});
