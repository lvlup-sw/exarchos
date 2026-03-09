import { describe, it, expect, vi } from 'vitest';
import { handleRunbook } from './handler.js';
import { ALL_RUNBOOKS } from './definitions.js';
import type { ResolvedRunbookStep } from './types.js';

describe('handleRunbook', () => {
  // ─── List Mode ────────────────────────────────────────────────────────

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
    // Should match only delegate-phase runbooks
    const expected = ALL_RUNBOOKS.filter(r => r.phase === 'delegate');
    expect(data).toHaveLength(expected.length);
  });

  it('HandleRunbook_ListMode_UnknownPhase_ReturnsEmptyArray', async () => {
    const result = await handleRunbook({ phase: 'nonexistent-phase' });
    expect(result.success).toBe(true);
    const data = result.data as Array<unknown>;
    expect(data).toHaveLength(0);
  });

  // ─── Detail Mode ──────────────────────────────────────────────────────

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
    // Verify seq numbers are 1-based
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
    // task-completion uses exarchos_orchestrate actions — schema should be resolved
    const orchSteps = data.steps.filter(s => s.tool === 'exarchos_orchestrate');
    expect(orchSteps.length).toBeGreaterThan(0);
    for (const step of orchSteps) {
      expect(step.schema).not.toBeNull();
      expect(typeof step.schema).toBe('object');
    }
  });

  it('HandleRunbook_DetailMode_ResolvesGateFromRegistry', async () => {
    // task-completion has check_tdd_compliance which has gate: { blocking: true, dimension: 'D1' }
    const result = await handleRunbook({ id: 'task-completion' });
    expect(result.success).toBe(true);
    const data = result.data as {
      steps: Array<{ action: string; gate: { blocking: boolean; dimension?: string } | null }>;
    };
    const tddStep = data.steps.find(s => s.action === 'check_tdd_compliance');
    expect(tddStep).toBeDefined();
    expect(tddStep!.gate).not.toBeNull();
    expect(tddStep!.gate!.blocking).toBe(true);
    expect(tddStep!.gate!.dimension).toBe('D1');
  });

  it('HandleRunbook_DetailMode_SkipsSchemaForNativeTools', async () => {
    // agent-teams-saga has native: tools
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

  // ─── Platform Hint ────────────────────────────────────────────────────

  it('RunbookResolve_NativeTaskWithAgent_IncludesPlatformHint', async () => {
    // agent-teams-saga has a native:Task step with params.agent = 'teammate'
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

  it('RunbookResolve_NativeTaskWithoutAgent_NoPlatformHint', async () => {
    // task-fix has a native:Task step without params.agent (has resumeAgent/fallbackAgent instead)
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
    // task-completion has only exarchos_orchestrate steps (non-native MCP steps)
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
});
