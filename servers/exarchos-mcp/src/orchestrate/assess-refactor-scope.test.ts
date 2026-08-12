import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import type { EventStore } from '../events/store.js';
import type { WorkflowEvent } from '../events/schemas.js';

vi.mock('node:fs');

const mockedFs = vi.mocked(fs);

/**
 * Minimal EventStore stub for fileless resolution. `node:fs` is auto-mocked
 * here (which breaks the SQLite-backed real EventStore), so we stub the only
 * method `resolveWorkflowState` calls — `query` — to return seeded events.
 */
function makeStubEventStore(events: WorkflowEvent[]): EventStore {
  return {
    query: vi.fn(async () => events),
  } as unknown as EventStore;
}

function evt(type: string, data: unknown): WorkflowEvent {
  return { type, data, timestamp: '2026-05-30T00:00:00.000Z' } as unknown as WorkflowEvent;
}

describe('Assess Refactor Scope', () => {
  it('handleAssessRefactorScope_FewFilesSingleModule_RecommendPolish', async () => {
    const { handleAssessRefactorScope } = await import('./assess-refactor-scope.js');
    const result = await handleAssessRefactorScope({
      files: ['src/foo.ts', 'src/bar.ts', 'src/baz.ts'],
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      recommendedTrack: string;
      filesCount: number;
      modulesCount: number;
      report: string;
    };
    expect(data.passed).toBe(true);
    expect(data.recommendedTrack).toBe('polish');
    expect(data.filesCount).toBe(3);
    expect(data.modulesCount).toBe(1);
  });

  it('handleAssessRefactorScope_ManyFiles_RecommendOverhaul', async () => {
    const { handleAssessRefactorScope } = await import('./assess-refactor-scope.js');
    const result = await handleAssessRefactorScope({
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'],
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      recommendedTrack: string;
      filesCount: number;
    };
    expect(data.passed).toBe(false);
    expect(data.recommendedTrack).toBe('overhaul');
    expect(data.filesCount).toBe(6);
  });

  it('handleAssessRefactorScope_CrossModule_RecommendOverhaul', async () => {
    const { handleAssessRefactorScope } = await import('./assess-refactor-scope.js');
    const result = await handleAssessRefactorScope({
      files: ['src/foo.ts', 'lib/bar.ts'],
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      recommendedTrack: string;
      modulesCount: number;
    };
    expect(data.passed).toBe(false);
    expect(data.recommendedTrack).toBe('overhaul');
    expect(data.modulesCount).toBe(2);
  });

  it('handleAssessRefactorScope_ReadsFromStateFile', async () => {
    const stateContent = JSON.stringify({
      explore: {
        scopeAssessment: {
          filesAffected: ['src/one.ts', 'src/two.ts'],
        },
      },
    });
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(stateContent);

    const { handleAssessRefactorScope } = await import('./assess-refactor-scope.js');
    const result = await handleAssessRefactorScope({
      stateFile: '/tmp/test-state.json',
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      recommendedTrack: string;
      filesCount: number;
    };
    expect(data.passed).toBe(true);
    expect(data.recommendedTrack).toBe('polish');
    expect(data.filesCount).toBe(2);
  });

  // ─── Fileless resolution: MCP-only workflow ────────────────────────────
  //
  // INV-1: the event store is the sole source of truth. An MCP-only refactor
  // workflow has no `.state.json` stamp; explore.scopeAssessment.filesAffected
  // must resolve from the event-store projection via featureId + eventStore.
  it('FilelessMcpOnly_ResolvesFilesFromEventStore', async () => {
    const { handleAssessRefactorScope } = await import('./assess-refactor-scope.js');

    const featureId = 'fileless-refactor';
    const eventStore = makeStubEventStore([
      evt('workflow.started', { featureId, workflowType: 'refactor' }),
      evt('state.patched', {
        patch: {
          explore: { scopeAssessment: { filesAffected: ['src/one.ts', 'src/two.ts'] } },
        },
      }),
    ]);

    const result = await handleAssessRefactorScope({ featureId, eventStore });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; recommendedTrack: string; filesCount: number };
    expect(data.passed).toBe(true);
    expect(data.recommendedTrack).toBe('polish');
    expect(data.filesCount).toBe(2);
  });

  it('handleAssessRefactorScope_NoFiles_ReturnsError', async () => {
    const { handleAssessRefactorScope } = await import('./assess-refactor-scope.js');
    const result = await handleAssessRefactorScope({});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('INVALID_INPUT');
  });

  it('handleAssessRefactorScope_ReportContainsAssessment', async () => {
    const { handleAssessRefactorScope } = await import('./assess-refactor-scope.js');
    const result = await handleAssessRefactorScope({
      files: ['src/foo.ts', 'src/bar.ts'],
    });
    expect(result.success).toBe(true);
    const data = result.data as { report: string };
    expect(data.report).toContain('Scope Assessment');
    expect(data.report).toContain('Files affected');
    expect(data.report).toContain('polish');
  });
});
