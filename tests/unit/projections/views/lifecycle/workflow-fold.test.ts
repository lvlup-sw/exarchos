import { describe, it, expect, afterEach, vi } from 'vitest';
import { fc } from '@fast-check/vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowEvent } from '../../../../../src/events/schemas.js';
import type { WorkflowState } from '../../../../../src/workflow/types.js';
import type {
  StorageBackend,
  WorkflowSummary,
  WorkflowSummaryFilter,
} from '../../../../../src/storage/backend.js';
import {
  deriveWorkflowStatus,
  matchesWorkflowSummaryFilter,
} from '../../../../../src/storage/backend.js';
import { InMemoryBackend } from '../../../../../src/storage/memory-backend.js';
import { SqliteBackend } from '../../../../../src/storage/sqlite-backend.js';
import { foldWorkflowSummaries } from '../../../../../src/projections/views/lifecycle/workflow-fold.js';
import { rmrf } from '../../../../../tools/test-helpers/temp-dir.js';

interface WorkflowSpec {
  featureId: string;
  workflowType: string;
  phase: string;
  /** Event-envelope timestamp (ISO-8601). Defaults to a fixed instant. */
  createdAtIso?: string;
}

const T0 = '2026-07-01T00:00:00.000Z';

/**
 * Seed one workflow into `backend`: its state (carrying workflowType + phase),
 * its stream-registry row (for the SQLite indexed join — a no-op on backends
 * without `registerStream`), and a `workflow.started` event so the envelope
 * timestamp exists. Uses the REAL backends — no hand-mocks.
 *
 * `skipRegistry` models the REACHABLE state where `registerStream()` failed and
 * its error was swallowed: a `workflow_state` row with no `streams` row.
 */
function seed(backend: StorageBackend, spec: WorkflowSpec, skipRegistry = false): void {
  const state = {
    featureId: spec.featureId,
    workflowType: spec.workflowType,
    phase: spec.phase,
  } as unknown as WorkflowState;
  backend.setState(spec.featureId, state);
  if (!skipRegistry) backend.registerStream?.(spec.featureId, spec.workflowType);
  backend.appendEvent(spec.featureId, {
    streamId: spec.featureId,
    sequence: 1,
    timestamp: spec.createdAtIso ?? T0,
    type: 'workflow.started',
    schemaVersion: '1.0',
  } as WorkflowEvent);
}

function makeSqlite(): { backend: SqliteBackend; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-fold-'));
  const backend = new SqliteBackend(join(dir, 'test.db'));
  backend.initialize();
  return {
    backend,
    cleanup: () => {
      backend.close();
      rmrf(dir);
    },
  };
}

function makeMemory(): { backend: InMemoryBackend; cleanup: () => void } {
  const backend = new InMemoryBackend();
  backend.initialize();
  return { backend, cleanup: () => backend.close() };
}

/** A corpus with two workflow types and each lifecycle status. */
const CORPUS: WorkflowSpec[] = [
  { featureId: 'feat-active', workflowType: 'feature', phase: 'delegate' },
  { featureId: 'feat-blocked', workflowType: 'feature', phase: 'blocked' },
  { featureId: 'feat-done', workflowType: 'feature', phase: 'completed' },
  { featureId: 'feat-cancelled', workflowType: 'feature', phase: 'cancelled' },
  { featureId: 'dbg-active', workflowType: 'debug', phase: 'triage' },
  { featureId: 'dbg-done', workflowType: 'debug', phase: 'completed' },
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  vi.restoreAllMocks();
});

/** Set up a real SqliteBackend seeded with CORPUS, auto-cleaned. */
function sqliteWithCorpus(): SqliteBackend {
  const { backend, cleanup } = makeSqlite();
  cleanups.push(cleanup);
  for (const spec of CORPUS) seed(backend, spec);
  return backend;
}

describe('workflow-fold view (DR-3)', () => {
  /**
   * The JavaScript lifecycle filter does not check `workflowType`. Without the SQL predicate, the
   * `feature` rows stay in the result. The counter shows that the pushdown ran one time.
   */
  it('WorkflowFold_TypeFilter_PushedDownToSql', () => {
    const backend = sqliteWithCorpus();

    const rows = foldWorkflowSummaries(backend, { workflowType: 'debug', includeTerminal: true });

    expect(rows.map((r) => r.featureId).sort()).toEqual(['dbg-active', 'dbg-done']);

    expect(backend.getStats().workflowTypePushdownQueries).toBe(1);
  });

  it('WorkflowFold_NoTypeFilter_DoesNotPushDown', () => {
    const backend = sqliteWithCorpus();
    foldWorkflowSummaries(backend, { includeTerminal: true });
    expect(backend.getStats().workflowTypePushdownQueries).toBe(0);
  });

  /** An explicit terminal `status` returns terminal rows without `includeTerminal`. */
  it('WorkflowFold_StatusFilter_ReturnsMatchingRows', () => {
    const backend = sqliteWithCorpus();

    const active = foldWorkflowSummaries(backend, { status: 'active' });
    expect(active.map((r) => r.featureId).sort()).toEqual(['dbg-active', 'feat-active']);
    expect(active.every((r) => r.status === 'active')).toBe(true);

    const blocked = foldWorkflowSummaries(backend, { status: 'blocked' });
    expect(blocked.map((r) => r.featureId)).toEqual(['feat-blocked']);

    const completed = foldWorkflowSummaries(backend, { status: 'completed' });
    expect(completed.map((r) => r.featureId).sort()).toEqual(['dbg-done', 'feat-done']);
  });

  it('WorkflowFold_PhaseFilter_ReturnsMatchingRows', () => {
    const backend = sqliteWithCorpus();

    const delegate = foldWorkflowSummaries(backend, { phase: 'delegate' });
    expect(delegate.map((r) => r.featureId)).toEqual(['feat-active']);
    expect(delegate[0].phase).toBe('delegate');

    const triage = foldWorkflowSummaries(backend, { phase: 'triage' });
    expect(triage.map((r) => r.featureId)).toEqual(['dbg-active']);
  });

  it('WorkflowFold_Default_ExcludesTerminalStates', () => {
    const backend = sqliteWithCorpus();

    const rows = foldWorkflowSummaries(backend);
    const ids = rows.map((r) => r.featureId).sort();

    expect(ids).toEqual(['dbg-active', 'feat-active', 'feat-blocked']);
    expect(ids).not.toContain('feat-done');
    expect(ids).not.toContain('feat-cancelled');
    expect(ids).not.toContain('dbg-done');
    expect(rows.every((r) => r.status !== 'completed' && r.status !== 'cancelled')).toBe(true);
  });

  it('WorkflowFold_AllFlag_IncludesCompleted', () => {
    const backend = sqliteWithCorpus();

    const all = foldWorkflowSummaries(backend, { includeTerminal: true });
    const ids = all.map((r) => r.featureId).sort();

    expect(ids).toEqual([
      'dbg-active',
      'dbg-done',
      'feat-active',
      'feat-blocked',
      'feat-cancelled',
      'feat-done',
    ]);
    expect(ids).toContain('feat-done');
    expect(ids).toContain('dbg-done');
  });

  /** `nowMs` is 10 s after `T0`, so each `ageMs` is 10000. Rows with equal ages sort by `featureId`. */
  it('WorkflowFold_Age_ComputedFromEventEnvelope', () => {
    const backend = sqliteWithCorpus();
    const nowMs = Date.parse('2026-07-01T00:00:10.000Z');
    const rows = foldWorkflowSummaries(backend, { includeTerminal: true, nowMs });
    for (const row of rows) {
      expect(row.ageMs).toBe(10_000);
    }
    expect(rows[0].featureId).toBe('dbg-active');
  });
});

/** `normalize` removes `createdAt` and sorts the rows by `featureId`, so the rows of two backends compare directly. */
describe('listWorkflowSummaries backend contract', () => {
  function normalize(rows: WorkflowSummary[]): Array<Omit<WorkflowSummary, 'createdAt'>> {
    return rows
      .map(({ featureId, workflowType, phase, status }) => ({ featureId, workflowType, phase, status }))
      .sort((a, b) => a.featureId.localeCompare(b.featureId));
  }

  const FILTERS: WorkflowSummaryFilter[] = [
    {},
    { includeTerminal: true },
    { workflowType: 'feature' },
    { workflowType: 'feature', includeTerminal: true },
    { workflowType: 'debug' },
    { status: 'active' },
    { status: 'blocked' },
    { status: 'completed' },
    { phase: 'delegate' },
    { phase: 'completed' },
    { phase: 'completed', includeTerminal: true },
  ];

  /**
   * Each filter must give the same rows on both backends. `createdAt` must also agree, because
   * both backends read the earliest event timestamp.
   */
  it('ListWorkflowSummaries_BackendContract_SharedAcrossSqliteAndInMemory', () => {
    const sqlite = makeSqlite();
    const memory = makeMemory();
    try {
      for (const spec of CORPUS) {
        seed(sqlite.backend, spec);
        seed(memory.backend, spec);
      }

      for (const filter of FILTERS) {
        const fromSqlite = normalize(sqlite.backend.listWorkflowSummaries(filter));
        const fromMemory = normalize(memory.backend.listWorkflowSummaries(filter));
        expect(fromMemory, `filter=${JSON.stringify(filter)}`).toEqual(fromSqlite);
      }

      const sqliteAll = sqlite.backend.listWorkflowSummaries({ includeTerminal: true });
      const memoryAll = memory.backend.listWorkflowSummaries({ includeTerminal: true });
      const byId = (rows: WorkflowSummary[]) =>
        Object.fromEntries(rows.map((r) => [r.featureId, r.createdAt]));
      expect(byId(memoryAll)).toEqual(byId(sqliteAll));
    } finally {
      sqlite.cleanup();
      memory.cleanup();
    }
  });

  /**
   * A `workflow_state` row can exist with no `streams` row, because init ignores a
   * `registerStream()` error. An inner join drops that workflow, and the in-memory backend keeps
   * it. The `workflowType` filter must use the coalesced expression of the SELECT. A bare
   * `s.workflow_type = ?` is NULL for the orphan and drops it again.
   */
  it('ListWorkflowSummaries_StateRowWithoutRegistryRow_StillListedAndBackendsAgree', () => {
    const sqlite = makeSqlite();
    const memory = makeMemory();
    try {
      const orphan: WorkflowSpec = {
        featureId: 'orphan-feat',
        workflowType: 'feature',
        phase: 'delegate',
      };
      seed(sqlite.backend, CORPUS[0]);
      seed(memory.backend, CORPUS[0]);
      seed(sqlite.backend, orphan, true);
      seed(memory.backend, orphan, true);

      const rows = sqlite.backend.listWorkflowSummaries();
      expect(rows.map((r) => r.featureId)).toContain('orphan-feat');
      expect(rows.find((r) => r.featureId === 'orphan-feat')!.workflowType).toBe('feature');

      const filters: WorkflowSummaryFilter[] = [
        {},
        { workflowType: 'feature' },
        { workflowType: 'debug' },
        { includeTerminal: true },
      ];
      for (const filter of filters) {
        expect(
          normalize(memory.backend.listWorkflowSummaries(filter)),
          `filter=${JSON.stringify(filter)}`,
        ).toEqual(normalize(sqlite.backend.listWorkflowSummaries(filter)));
      }
      expect(
        sqlite.backend.listWorkflowSummaries({ workflowType: 'feature' }).map((r) => r.featureId),
      ).toContain('orphan-feat');
    } finally {
      sqlite.cleanup();
      memory.cleanup();
    }
  });
});

describe('workflow-fold filter properties', () => {
  const statusArb = fc.constantFrom('active', 'completed', 'cancelled', 'blocked');
  const phaseArb = fc.constantFrom('plan', 'delegate', 'triage', 'completed', 'cancelled', 'blocked', 'review');

  const summaryArb: fc.Arbitrary<WorkflowSummary> = fc
    .record({
      featureId: fc.string({ minLength: 1, maxLength: 8 }),
      workflowType: fc.constantFrom('feature', 'debug', 'refactor'),
      phase: phaseArb,
    })
    .map(({ featureId, workflowType, phase }) => ({
      featureId,
      workflowType,
      phase,
      status: deriveWorkflowStatus(phase),
      createdAt: T0,
    }));

  const filterArb: fc.Arbitrary<WorkflowSummaryFilter> = fc.record(
    {
      workflowType: fc.constantFrom('feature', 'debug', 'refactor'),
      status: statusArb,
      phase: phaseArb,
      includeTerminal: fc.boolean(),
    },
    { requiredKeys: [] },
  );

  /** The lifecycle predicate is pure, so a second filter pass removes no row. */
  it('WorkflowFold_Filter_Idempotent', () => {
    fc.assert(
      fc.property(fc.array(summaryArb, { maxLength: 30 }), filterArb, (rows, filter) => {
        const once = rows.filter((r) => matchesWorkflowSummaryFilter(r, filter));
        const twice = once.filter((r) => matchesWorkflowSummaryFilter(r, filter));
        expect(twice).toEqual(once);
      }),
    );
  });

  /** Each row that passes a filter also passes the filter `{ includeTerminal: true }`. */
  it('WorkflowFold_Filtered_SubsetOfUnfiltered', () => {
    fc.assert(
      fc.property(fc.array(summaryArb, { maxLength: 30 }), filterArb, (rows, filter) => {
        const filtered = rows.filter((r) => matchesWorkflowSummaryFilter(r, filter));
        const unfiltered = rows.filter((r) =>
          matchesWorkflowSummaryFilter(r, { includeTerminal: true }),
        );
        for (const row of filtered) {
          expect(unfiltered).toContain(row);
        }
      }),
    );
  });

  /** The subset property also holds through the real in-memory backend and the view. */
  it('WorkflowFold_ViewFiltered_SubsetOfAll', () => {
    const { backend, cleanup } = makeMemory();
    try {
      for (const spec of CORPUS) seed(backend, spec);
      fc.assert(
        fc.property(filterArb, (filter) => {
          const filtered = foldWorkflowSummaries(backend, filter).map((r) => r.featureId);
          const all = foldWorkflowSummaries(backend, { includeTerminal: true }).map((r) => r.featureId);
          for (const id of filtered) expect(all).toContain(id);
        }),
      );
    } finally {
      cleanup();
    }
  });
});
