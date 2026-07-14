import { describe, it, expect, afterEach, vi } from 'vitest';
import { fc } from '@fast-check/vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import type { WorkflowState } from '../../workflow/types.js';
import type {
  StorageBackend,
  WorkflowSummary,
  WorkflowSummaryFilter,
} from '../../storage/backend.js';
import {
  deriveWorkflowStatus,
  matchesWorkflowSummaryFilter,
} from '../../storage/backend.js';
import { InMemoryBackend } from '../../storage/memory-backend.js';
import { SqliteBackend } from '../../storage/sqlite-backend.js';
import { foldWorkflowSummaries } from './workflow-fold.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

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
 */
function seed(backend: StorageBackend, spec: WorkflowSpec): void {
  const state = {
    featureId: spec.featureId,
    workflowType: spec.workflowType,
    phase: spec.phase,
  } as unknown as WorkflowState;
  backend.setState(spec.featureId, state);
  backend.registerStream?.(spec.featureId, spec.workflowType);
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
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeMemory(): { backend: InMemoryBackend; cleanup: () => void } {
  const backend = new InMemoryBackend();
  backend.initialize();
  return { backend, cleanup: () => backend.close() };
}

// A representative multi-type, multi-status corpus reused across tests.
const CORPUS: WorkflowSpec[] = [
  { featureId: 'feat-active', workflowType: 'feature', phase: 'delegate' },
  { featureId: 'feat-blocked', workflowType: 'feature', phase: 'blocked' },
  { featureId: 'feat-done', workflowType: 'feature', phase: 'completed' },
  { featureId: 'feat-cancelled', workflowType: 'feature', phase: 'cancelled' },
  { featureId: 'dbg-active', workflowType: 'debug', phase: 'triage' },
  { featureId: 'dbg-done', workflowType: 'debug', phase: 'completed' },
];

// ─── Cleanup registry ────────────────────────────────────────────────────────

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

// ─── WorkflowFold_TypeFilter_PushedDownToIndexedColumn ────────────────────────

describe('workflow-fold view (DR-3)', () => {
  it('WorkflowFold_TypeFilter_PushedDownToIndexedColumn', () => {
    const backend = sqliteWithCorpus();

    // Capture every SQL string the backend compiles during the filtered read.
    const db = (backend as unknown as { db: { prepare: (sql: string) => unknown } }).db;
    const preparedSql: string[] = [];
    const original = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      preparedSql.push(sql);
      return original(sql);
    });

    const rows = foldWorkflowSummaries(backend, { workflowType: 'debug', includeTerminal: true });

    // Behavioural proof: only debug workflows returned. If the type predicate
    // were NOT pushed down to SQL, the INNER JOIN would return every type and
    // — because the JS lifecycle filter deliberately does not re-check
    // workflowType — feature rows would leak through here.
    expect(rows.map((r) => r.featureId).sort()).toEqual(['dbg-active', 'dbg-done']);

    // Structural proof: the summary query compiled the type predicate into a
    // SQL WHERE against the indexed streams.workflow_type column.
    const summarySql = preparedSql.find(
      (sql) => sql.includes('json_extract') && sql.includes('workflow_type'),
    );
    expect(summarySql).toBeDefined();
    expect(summarySql!).toMatch(/where[\s\S]*s\.workflow_type\s*=\s*\?/i);

    // Counter proof: the indexed pushdown path fired exactly once.
    expect(backend.getStats().workflowTypePushdownQueries).toBe(1);
  });

  // An unfiltered read must NOT emit the type predicate nor bump the counter.
  it('WorkflowFold_NoTypeFilter_DoesNotPushDown', () => {
    const backend = sqliteWithCorpus();
    foldWorkflowSummaries(backend, { includeTerminal: true });
    expect(backend.getStats().workflowTypePushdownQueries).toBe(0);
  });

  // ─── WorkflowFold_StatusFilter_ReturnsMatchingRows ─────────────────────────

  it('WorkflowFold_StatusFilter_ReturnsMatchingRows', () => {
    const backend = sqliteWithCorpus();

    // 'active' is non-terminal, so this is independent of the terminal default.
    const active = foldWorkflowSummaries(backend, { status: 'active' });
    expect(active.map((r) => r.featureId).sort()).toEqual(['dbg-active', 'feat-active']);
    expect(active.every((r) => r.status === 'active')).toBe(true);

    // 'blocked' is non-terminal too.
    const blocked = foldWorkflowSummaries(backend, { status: 'blocked' });
    expect(blocked.map((r) => r.featureId)).toEqual(['feat-blocked']);

    // An explicit terminal status is authoritative even without includeTerminal.
    const completed = foldWorkflowSummaries(backend, { status: 'completed' });
    expect(completed.map((r) => r.featureId).sort()).toEqual(['dbg-done', 'feat-done']);
  });

  // ─── WorkflowFold_PhaseFilter_ReturnsMatchingRows ──────────────────────────

  it('WorkflowFold_PhaseFilter_ReturnsMatchingRows', () => {
    const backend = sqliteWithCorpus();

    const delegate = foldWorkflowSummaries(backend, { phase: 'delegate' });
    expect(delegate.map((r) => r.featureId)).toEqual(['feat-active']);
    expect(delegate[0].phase).toBe('delegate');

    const triage = foldWorkflowSummaries(backend, { phase: 'triage' });
    expect(triage.map((r) => r.featureId)).toEqual(['dbg-active']);
  });

  // ─── WorkflowFold_Default_ExcludesTerminalStates ───────────────────────────

  it('WorkflowFold_Default_ExcludesTerminalStates', () => {
    const backend = sqliteWithCorpus();

    const rows = foldWorkflowSummaries(backend);
    const ids = rows.map((r) => r.featureId).sort();

    // completed + cancelled workflows are hidden by default.
    expect(ids).toEqual(['dbg-active', 'feat-active', 'feat-blocked']);
    expect(ids).not.toContain('feat-done');
    expect(ids).not.toContain('feat-cancelled');
    expect(ids).not.toContain('dbg-done');
    // No returned row is terminal.
    expect(rows.every((r) => r.status !== 'completed' && r.status !== 'cancelled')).toBe(true);
  });

  // ─── WorkflowFold_AllFlag_IncludesCompleted ────────────────────────────────

  it('WorkflowFold_AllFlag_IncludesCompleted', () => {
    const backend = sqliteWithCorpus();

    const all = foldWorkflowSummaries(backend, { includeTerminal: true });
    const ids = all.map((r) => r.featureId).sort();

    // Every workflow, terminal included.
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

  // ─── Age is computed from the event envelope ───────────────────────────────

  it('WorkflowFold_Age_ComputedFromEventEnvelope', () => {
    const backend = sqliteWithCorpus();
    const nowMs = Date.parse('2026-07-01T00:00:10.000Z'); // 10s after T0
    const rows = foldWorkflowSummaries(backend, { includeTerminal: true, nowMs });
    for (const row of rows) {
      expect(row.ageMs).toBe(10_000);
    }
    // Oldest-first ordering with equal ages falls back to featureId.
    expect(rows[0].featureId).toBe('dbg-active');
  });
});

// ─── ListWorkflowSummaries_BackendContract_SharedAcrossSqliteAndInMemory ──────

describe('listWorkflowSummaries backend contract', () => {
  /** Strip createdAt (backend-derived, identical here) → stable comparison key. */
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

      // And the event-envelope createdAt agrees too (both read MIN timestamp).
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
});

// ─── Property tests (collections) ─────────────────────────────────────────────

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

  // filter(filter(rows)) === filter(rows): the lifecycle predicate is pure and
  // idempotent, so re-filtering an already-filtered collection is a no-op.
  it('WorkflowFold_Filter_Idempotent', () => {
    fc.assert(
      fc.property(fc.array(summaryArb, { maxLength: 30 }), filterArb, (rows, filter) => {
        const once = rows.filter((r) => matchesWorkflowSummaryFilter(r, filter));
        const twice = once.filter((r) => matchesWorkflowSummaryFilter(r, filter));
        expect(twice).toEqual(once);
      }),
    );
  });

  // filtered ⊆ unfiltered: every row that survives a filter is present in the
  // full (includeTerminal, no-axis) set.
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

  // Idempotence + subset through the real in-memory backend + view.
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
