import { describe, it, expect } from 'vitest';
import { handleRunbook } from '../../../src/runbooks/handler.js';
import { ALL_RUNBOOKS } from '../../../src/runbooks/definitions.js';
import type { ResolvedRunbookStep } from '../../../src/runbooks/types.js';

describe('handleRunbook', () => {
  it('HandleRunbook_ListMode_NoParams_ReturnsAllRunbooks', async () => {
    const result = await handleRunbook({});
    expect(result.success).toBe(true);
    const data = result.data as Array<{ id: string; phase: string; description: string; stepCount: number }>;
    expect(data).toHaveLength(ALL_RUNBOOKS.length);
    for (const entry of data) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('phase');
      expect(entry).toHaveProperty('description');
      expect(entry).toHaveProperty('stepCount');
    }
  });

  it('HandleRunbook_ListMode_WithPhase_FiltersRunbooks', async () => {
    const result = await handleRunbook({ phase: 'delegate' });
    expect(result.success).toBe(true);
    const data = result.data as Array<{ id: string; phase: string }>;
    expect(data.length).toBeGreaterThan(0);
    for (const entry of data) {
      expect(entry.phase).toBe('delegate');
    }
    const expected = ALL_RUNBOOKS.filter(r => r.phase === 'delegate');
    expect(data).toHaveLength(expected.length);
  });

  it('HandleRunbook_ListMode_UnknownPhase_ReturnsEmptyArray', async () => {
    const result = await handleRunbook({ phase: 'nonexistent-phase' });
    expect(result.success).toBe(true);
    const data = result.data as Array<unknown>;
    expect(data).toHaveLength(0);
  });

  it('HandleRunbook_DetailMode_ValidId_ReturnsResolvedSteps', async () => {
    const result = await handleRunbook({ id: 'task-completion' });
    expect(result.success).toBe(true);
    const data = result.data as {
      id: string;
      phase: string;
      description: string;
      steps: Array<{ seq: number; tool: string; action: string }>;
    };
    expect(data.id).toBe('task-completion');
    expect(data.phase).toBe('delegate');
    expect(data.steps.length).toBeGreaterThan(0);
    for (let i = 0; i < data.steps.length; i++) {
      expect(data.steps[i].seq).toBe(i + 1);
    }
  });

  it('HandleRunbook_DetailMode_ResolvesSchemaFromRegistry', async () => {
    const result = await handleRunbook({ id: 'task-completion' });
    expect(result.success).toBe(true);
    const data = result.data as {
      steps: Array<{ seq: number; tool: string; action: string; schema: unknown }>;
    };
    const orchSteps = data.steps.filter(s => s.tool === 'exarchos_orchestrate');
    expect(orchSteps.length).toBeGreaterThan(0);
    for (const step of orchSteps) {
      expect(step.schema).not.toBeNull();
      expect(typeof step.schema).toBe('object');
    }
  });

  /**
   * In `task-completion`, the `check_test_adequacy` step resolves a blocking gate with dimension
   * `D1`. The runbook holds no `check_tdd_compliance` step.
   */
  it('HandleRunbook_DetailMode_ResolvesGateFromRegistry', async () => {
    const result = await handleRunbook({ id: 'task-completion' });
    expect(result.success).toBe(true);
    const data = result.data as {
      steps: Array<{ action: string; gate: { blocking: boolean; dimension?: string } | null }>;
    };

    const adequacyStep = data.steps.find(s => s.action === 'check_test_adequacy');
    expect(adequacyStep).toBeDefined();
    expect(adequacyStep!.gate).not.toBeNull();
    expect(adequacyStep!.gate!.blocking).toBe(true);
    expect(adequacyStep!.gate!.dimension).toBe('D1');

    const tddStep = data.steps.find(s => s.action === 'check_tdd_compliance');
    expect(tddStep).toBeUndefined();
  });

  it('HandleRunbook_DetailMode_SkipsSchemaForNativeTools', async () => {
    const result = await handleRunbook({ id: 'agent-teams-saga' });
    expect(result.success).toBe(true);
    const data = result.data as {
      steps: Array<{ tool: string; schema: unknown }>;
    };
    const nativeSteps = data.steps.filter(s => s.tool.startsWith('native:'));
    expect(nativeSteps.length).toBeGreaterThan(0);
    for (const step of nativeSteps) {
      expect(step.schema).toBeNull();
    }
  });

  it('HandleRunbook_DetailMode_UnknownId_ReturnsErrorWithValidTargets', async () => {
    const result = await handleRunbook({ id: 'nonexistent-runbook' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_RUNBOOK');
    expect(result.error?.validTargets).toBeDefined();
    const targets = result.error!.validTargets as string[];
    expect(targets.length).toBe(ALL_RUNBOOKS.length);
    for (const rb of ALL_RUNBOOKS) {
      expect(targets).toContain(rb.id);
    }
  });

  it('HandleRunbook_DetailMode_IncludesTemplateVarsAndAutoEmits', async () => {
    const result = await handleRunbook({ id: 'task-completion' });
    expect(result.success).toBe(true);
    const data = result.data as {
      templateVars: readonly string[];
      autoEmits: readonly string[];
    };
    expect(Array.isArray(data.templateVars)).toBe(true);
    expect(data.templateVars.length).toBeGreaterThan(0);
    expect(Array.isArray(data.autoEmits)).toBe(true);
    expect(data.autoEmits.length).toBeGreaterThan(0);
  });

  /** The `native:Task` step of `agent-teams-saga` sets `params.agent` to `'teammate'`. */
  it('RunbookResolve_NativeTaskWithAgent_IncludesPlatformHint', async () => {
    const result = await handleRunbook({ id: 'agent-teams-saga' });
    expect(result.success).toBe(true);
    const data = result.data as {
      steps: Array<ResolvedRunbookStep & {
        platformHint?: { claudeCode: string; generic: string };
      }>;
    };
    const nativeTaskWithAgent = data.steps.find(
      s => s.tool === 'native:Task' && (s.params as Record<string, unknown>)?.agent,
    );
    expect(nativeTaskWithAgent).toBeDefined();
    expect(nativeTaskWithAgent!.platformHint).toBeDefined();
    expect(nativeTaskWithAgent!.platformHint!.claudeCode).toBe(
      'Uses native agent definition exarchos-teammate',
    );
    expect(nativeTaskWithAgent!.platformHint!.generic).toBe(
      'Call agent_spec("teammate") to get system prompt and tool restrictions',
    );
  });

  /**
   * The `native:Task` step of `task-fix` sets `resumeAgent` and `fallbackAgent`, and not
   * `params.agent`. The platform selects one of the two at run time, so the step names no single
   * agent spec for a hint.
   */
  it('RunbookResolve_NativeTaskWithoutAgent_NoPlatformHint', async () => {
    const result = await handleRunbook({ id: 'task-fix' });
    expect(result.success).toBe(true);
    const data = result.data as {
      steps: Array<ResolvedRunbookStep & {
        platformHint?: { claudeCode: string; generic: string };
      }>;
    };
    const nativeTaskStep = data.steps.find(s => s.tool === 'native:Task');
    expect(nativeTaskStep).toBeDefined();
    expect(nativeTaskStep!.platformHint).toBeUndefined();
  });

  it('RunbookResolve_McpStep_NoPlatformHint', async () => {
    const result = await handleRunbook({ id: 'task-completion' });
    expect(result.success).toBe(true);
    const data = result.data as {
      steps: Array<ResolvedRunbookStep & {
        platformHint?: { claudeCode: string; generic: string };
      }>;
    };
    for (const step of data.steps) {
      expect(step.tool.startsWith('native:')).toBe(false);
      expect(step.platformHint).toBeUndefined();
    }
  });

  it('handleRunbook_DecisionRunbook_ReturnsDecideFields', async () => {
    const result = await handleRunbook({ id: 'triage-decision' });
    expect(result.success).toBe(true);
    const data = result.data as {
      steps: Array<{ decide?: { question: string; branches: Record<string, unknown> } }>;
    };
    const decideSteps = data.steps.filter((s) => s.decide);
    expect(decideSteps.length).toBeGreaterThanOrEqual(2);
    for (const step of decideSteps) {
      expect(step.decide!.question).toBeTruthy();
      expect(step.decide!.branches).toBeTruthy();
    }
  });

  it('handleRunbook_DecisionRunbook_NoSchemaForNoneSteps', async () => {
    const result = await handleRunbook({ id: 'triage-decision' });
    expect(result.success).toBe(true);
    const data = result.data as {
      steps: Array<{ tool: string; schema: unknown }>;
    };
    const noneSteps = data.steps.filter((step) => step.tool === 'none');
    expect(noneSteps.length).toBeGreaterThan(0);
    for (const step of noneSteps) {
      expect(step.schema).toBeNull();
    }
  });

  /** A runbook that holds no decision step returns no `decide` field. */
  it('handleRunbook_LinearRunbook_UnchangedResponse', async () => {
    const result = await handleRunbook({ id: 'task-completion' });
    expect(result.success).toBe(true);
    const data = result.data as {
      steps: Array<{ decide?: unknown }>;
    };
    for (const step of data.steps) {
      expect(step.decide).toBeUndefined();
    }
  });

  it('handleRunbook_ListMode_IncludesDecisionRunbooks', async () => {
    const result = await handleRunbook({});
    expect(result.success).toBe(true);
    const ids = (result.data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain('triage-decision');
    expect(ids).toContain('review-escalation');
  });
});
