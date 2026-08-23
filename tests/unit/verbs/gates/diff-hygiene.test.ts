// ─── Diff-Hygiene Gate ───────────────────────────────────────────────────────
//
// This file has two jobs, and they are different jobs.
//
// 1. CHARACTERIZATION. One action replaced three, and a consolidation is only
//    safe if it is silent. The oracle is `__fixtures__/diff-hygiene-baseline.json`,
//    CAPTURED by running the three pre-consolidation handlers over the corpus —
//    it is what the old code actually did, not a transcription of what it looked
//    like it did. Every carrier field and every durable row is compared against
//    it, so a rendering the fold quietly reworded fails here.
//
// 2. THE PACK IS DATA. A rule must be addable by appending a record, with no
//    branch anywhere learning its name. Asserting that by reading the source
//    would prove nothing, so the suite hands the scorer a rule this module has
//    never seen and requires it to come back scored and counted.
// ─────────────────────────────────────────────────────────────────────────────
//
// @oracle-sources: ./__fixtures__/diff-hygiene-baseline.json, ./__fixtures__/diff-hygiene-corpus.ts
//
// Two authorities, and neither is derived from the other: the baseline records what
// the THREE retired handlers actually emitted, captured by running them; the corpus
// is the input population they were run over. A rendering the fold reworded fails
// against the first; a case the fold stopped covering fails against the second.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fc } from '@fast-check/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventStore } from '../../../../src/events/store.js';

// ─── Mock gate-utils (getDiff + emitGateEvent) ─────────────────────────────

const mockGetDiff = vi.fn<(repoRoot: string, baseBranch: string) => string | null>();
const mockEmitGateEvent = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../../src/verbs/gates/gate-utils.js', () => ({
  getDiff: (...args: [string, string]) => mockGetDiff(...args),
  emitGateEvent: (...args: unknown[]) => mockEmitGateEvent(...args),
}));

// ─── Mock the telemetry projection ───────────────────────────────────────────

const mockTelemetryState = {
  tools: {} as Record<string, unknown>,
  sessionStart: '2026-01-01T00:00:00.000Z',
  totalInvocations: 0,
  totalTokens: 0,
  windowSize: 1000,
};

vi.mock('../../../../src/projections/views/tools.js', () => ({
  getOrCreateMaterializer: () => ({
    materialize: vi.fn(() => mockTelemetryState),
    getState: vi.fn(() => null),
    loadFromSnapshot: vi.fn().mockResolvedValue(undefined),
  }),
  queryDeltaEvents: vi.fn().mockResolvedValue([]),
}));

// The gate folds its telemetry view to the stream's durable tail rather than
// pairing a delta query with a bare materialize (#1855). These fixtures ARE the
// stream, so the stub reports a sequence at or past every fixture event; a lower
// one would assert a lag this file never sets up.
const AT_TAIL = Number.MAX_SAFE_INTEGER;

vi.mock('../../../../src/projections/fold-at-tail.js', () => ({
  foldToTail: vi.fn(async () => ({ view: mockTelemetryState, sequence: AT_TAIL })),
}));

import {
  DIFF_HYGIENE_RULES,
  handleDiffHygiene,
  scanDiffHygiene,
  type DiffHygieneRule,
} from '../../../../src/verbs/gates/diff-hygiene.js';
import { checkContextEconomy } from '../../../../src/verbs/pure/context-economy.js';
import { checkOperationalResilience } from '../../../../src/verbs/pure/operational-resilience.js';
import { checkWorkflowDeterminism } from '../../../../src/verbs/pure/workflow-determinism.js';
import { CORPUS_KEYS, DIFF_CORPUS } from './__fixtures__/diff-hygiene-corpus.js';
import BASELINE from './__fixtures__/diff-hygiene-baseline.json' with { type: 'json' };

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

const STATE_DIR = '/tmp/test-diff-hygiene';
const FEATURE_ID = 'feat-baseline';
const REPO_ROOT = '/repo';
const BASE = 'main';
const NO_REPO = '/exarchos-not-a-repository';

/** The rule ids the three retired actions carried, in the order they folded. */
const RETIRED_GATE_NAMES = ['context-economy', 'operational-resilience', 'workflow-determinism'];

interface CapturedGate {
  readonly passed: boolean;
  readonly findingCount: number;
  readonly report: string;
  readonly emissions: readonly unknown[][];
}

const SCORED = BASELINE.scored as unknown as Record<string, Record<string, CapturedGate>>;
const UNSCOPED = BASELINE.unscoped as unknown as Record<
  string,
  { success: boolean; data: Record<string, unknown>; diffAttempted: boolean; emissions: unknown[][] }
>;

function store(): EventStore {
  return mockStore as unknown as EventStore;
}

async function runOn(diff: string) {
  mockGetDiff.mockReturnValue(diff);
  return handleDiffHygiene(
    { featureId: FEATURE_ID, repoRoot: REPO_ROOT, baseBranch: BASE },
    STATE_DIR,
    store(),
  );
}

/** The rows the handler appended, with the store argument dropped. */
function appendedRows(): unknown[][] {
  return mockEmitGateEvent.mock.calls.map((call) => call.slice(1));
}

describe('the diff-hygiene rule pack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.append.mockResolvedValue(undefined);
    mockStore.query.mockResolvedValue([]);
    mockTelemetryState.tools = {};
    mockTelemetryState.totalTokens = 0;
    mockTelemetryState.totalInvocations = 0;
  });

  // ─── The corpus is the denominator of every claim below ───────────────────

  describe('the oracle', () => {
    it('Corpus_CoversEveryRule_InBothDirections', () => {
      // Without this, "each rule still fires" could be satisfied by a corpus
      // that never provokes one of them — the vacuity that makes a green
      // characterization meaningless.
      expect(CORPUS_KEYS.length).toBeGreaterThanOrEqual(20);
      expect(Object.keys(SCORED).sort()).toEqual([...CORPUS_KEYS]);

      for (const id of RETIRED_GATE_NAMES) {
        const verdicts = CORPUS_KEYS.map((key) => SCORED[key]?.[id]);
        expect(
          verdicts.some((verdict) => (verdict?.findingCount ?? 0) > 0),
          `the corpus never provokes a finding from '${id}', so its characterization is vacuous`,
        ).toBe(true);
        expect(
          verdicts.some((verdict) => verdict?.passed === true),
          `the corpus never lets '${id}' pass, so a rule stuck on FAIL would go unnoticed`,
        ).toBe(true);
      }
    });
  });

  // ─── One action replaces three ────────────────────────────────────────────

  describe('one action replaces three', () => {
    it('OneAction_ReplacesThree', async () => {
      expect(DIFF_HYGIENE_RULES.map((rule) => rule.id)).toEqual(RETIRED_GATE_NAMES);
      expect(DIFF_HYGIENE_RULES.map((rule) => rule.dimension)).toEqual(['D3', 'D4', 'D5']);

      // One call, three durable rows — the same three a caller used to obtain
      // from three separate invocations.
      await runOn(DIFF_CORPUS.cleanSource ?? '');

      expect(appendedRows().map((row) => row[1])).toEqual(RETIRED_GATE_NAMES);
      for (const row of appendedRows()) {
        expect(row[0]).toBe(FEATURE_ID);
        expect(row[2]).toBe('quality');
      }
    });

    it('GateDirectory_ShrinksByTwo', () => {
      // Three modules out, one in. Asserted as membership rather than as an
      // absolute count: the directory's pinned cap is re-pinned elsewhere, and a
      // number here would collide with every other retirement landing beside
      // this one.
      const gateModule = (name: string): string =>
        fileURLToPath(new URL(`../../../../src/verbs/gates/${name}`, import.meta.url));

      for (const retired of [
        'context-economy.ts',
        'operational-resilience.ts',
        'workflow-determinism.ts',
      ]) {
        expect(existsSync(gateModule(retired)), `${retired} should have been folded away`).toBe(false);
      }
      expect(existsSync(gateModule('diff-hygiene.ts'))).toBe(true);
    });
  });

  // ─── The pack is data, not branches ───────────────────────────────────────

  describe('the pack is data', () => {
    it('RulePack_IsData_NotBranches', async () => {
      // A rule this module has never seen, added the only way a rule is ever
      // added: by being in the pack. If any control flow keyed on a known id,
      // this rule would be scored by nothing.
      const invented: DiffHygieneRule = {
        id: 'invented-rule',
        dimension: 'D9',
        scan: () => ({ passed: false, findingCount: 7, report: 'Result: FINDINGS (invented)' }),
      };

      const scan = scanDiffHygiene(DIFF_CORPUS.cleanSource ?? '', [
        ...DIFF_HYGIENE_RULES,
        invented,
      ]);

      expect(scan.rules.map((rule) => rule.id)).toEqual([...RETIRED_GATE_NAMES, 'invented-rule']);
      // Folded into the aggregate, not merely carried alongside it.
      expect(scan.findingCount).toBe(7);
      expect(scan.passed).toBe(false);
      expect(scan.report).toContain('### invented-rule');
      expect(scan.rules.at(-1)).toMatchObject({ dimension: 'D9', findingCount: 7 });
    });

    it('AnEmptyPack_IsNotAPass', () => {
      // `every` over nothing is true, which would turn a pack that lost its
      // rules into a gate that always passes. The count is what says otherwise,
      // and the reachability guard is what keeps the shipped pack non-empty.
      expect(DIFF_HYGIENE_RULES.length).toBe(3);
      const empty = scanDiffHygiene(DIFF_CORPUS.multiRule ?? '', []);
      expect(empty.rules).toHaveLength(0);
      expect(empty.findingCount).toBe(0);
    });
  });

  // ─── Characterization against the three it replaced ───────────────────────

  describe('every rule still fires exactly as it did', () => {
    it.each(CORPUS_KEYS)('EachRule_StillFires [%s]', async (key) => {
      const captured = SCORED[key];
      expect(captured, `no baseline captured for '${key}'`).toBeDefined();

      const result = await runOn(DIFF_CORPUS[key] ?? '');
      expect(result.success).toBe(true);

      const data = result.data as {
        passed: boolean;
        findingCount: number;
        rules: readonly { id: string; dimension: string; passed: boolean; findingCount: number; report: string }[];
      };

      for (const rule of data.rules) {
        const before = captured![rule.id];
        expect(before, `'${rule.id}' has no captured verdict for '${key}'`).toBeDefined();
        expect({ passed: rule.passed, findingCount: rule.findingCount, report: rule.report }).toEqual({
          passed: before!.passed,
          findingCount: before!.findingCount,
          report: before!.report,
        });
      }

      // The union: the aggregate is the three verdicts, not a fourth opinion.
      const expectedTotal = RETIRED_GATE_NAMES.reduce(
        (total, id) => total + (captured![id]?.findingCount ?? 0),
        0,
      );
      expect(data.findingCount).toBe(expectedTotal);
      expect(data.passed).toBe(RETIRED_GATE_NAMES.every((id) => captured![id]?.passed === true));
    });

    it.each(CORPUS_KEYS)('TheDurableRows_AreUnchanged [%s]', async (key) => {
      const captured = SCORED[key]!;
      await runOn(DIFF_CORPUS[key] ?? '');

      const expectedRows = RETIRED_GATE_NAMES.flatMap((id) => captured[id]?.emissions ?? []);
      expect(appendedRows()).toEqual(expectedRows);
    });
  });

  // ─── The inconclusive carrier survives the fold ───────────────────────────

  describe('an unscoped run', () => {
    it('UnresolvedBase_IsInconclusive_NotPass', async () => {
      const result = await handleDiffHygiene(
        { featureId: FEATURE_ID, repoRoot: NO_REPO },
        STATE_DIR,
        store(),
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        passed: boolean;
        findingCount: number;
        report: string;
        rules: readonly unknown[];
        skipped?: boolean;
        discriminant?: string;
        reason?: string;
      };

      const before = UNSCOPED['context-economy']!.data;
      expect(data.passed).toBe(false);
      expect(data.findingCount).toBe(0);
      expect(data.skipped).toBe(true);
      expect(data.discriminant).toBe('base-branch-unresolved');
      // The reason is the diagnostic an operator acts on, so it is compared, not
      // merely probed for truthiness.
      expect(data.reason).toBe(before.reason);
      expect(data.report).toBe(before.report);
      // Nothing was scored, so nothing may be reported as scored.
      expect(data.rules).toHaveLength(0);
      // The diff was never attempted.
      expect(mockGetDiff).not.toHaveBeenCalled();
    });

    it('UnscopedRun_StillAppendsOneRowPerRule', async () => {
      await handleDiffHygiene({ featureId: FEATURE_ID, repoRoot: NO_REPO }, STATE_DIR, store());

      // Indeterminate is a verdict, and this action declares `gate.executed`
      // unconditionally — a success carrier without the rows is drift the
      // post-dispatch emission verifier reports, and it leaves the durable log
      // unable to tell an unscoped run from one that never happened.
      const expectedRows = RETIRED_GATE_NAMES.flatMap((id) => UNSCOPED[id]!.emissions);
      expect(appendedRows()).toEqual(expectedRows);
    });
  });

  // ─── The remaining carrier contracts ──────────────────────────────────────

  describe('carrier contracts', () => {
    it('MissingFeatureId_ReturnsError', async () => {
      const result = await handleDiffHygiene({ featureId: '' }, STATE_DIR, store());
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('featureId');
      expect(mockEmitGateEvent).not.toHaveBeenCalled();
    });

    it('GitDiffFails_ReturnsError_AndScoresNothing', async () => {
      mockGetDiff.mockReturnValue(null);
      const result = await handleDiffHygiene(
        { featureId: FEATURE_ID, repoRoot: REPO_ROOT, baseBranch: BASE },
        STATE_DIR,
        store(),
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DIFF_ERROR');
      expect(mockEmitGateEvent).not.toHaveBeenCalled();
    });

    it('ExplicitBase_IsUsedVerbatim', async () => {
      mockGetDiff.mockReturnValue(DIFF_CORPUS.cleanSource ?? '');
      await handleDiffHygiene(
        { featureId: FEATURE_ID, repoRoot: REPO_ROOT, baseBranch: 'release/2026.09' },
        STATE_DIR,
        store(),
      );
      expect(mockGetDiff).toHaveBeenCalledWith(REPO_ROOT, 'release/2026.09');
    });

    it('TelemetrySnapshot_TravelsOnTheCarrier', async () => {
      mockTelemetryState.tools = { exarchos_workflow: {}, exarchos_view: {} };
      mockTelemetryState.totalTokens = 5000;
      mockTelemetryState.totalInvocations = 10;

      const result = await runOn(DIFF_CORPUS.cleanSource ?? '');
      const data = result.data as {
        runtimeMetrics: { sessionTokens: number; toolCount: number; totalInvocations: number };
      };

      expect(data.runtimeMetrics).toEqual({
        sessionTokens: 5000,
        toolCount: 2,
        totalInvocations: 10,
      });
    });

    it('AppendFailure_DoesNotFailTheGate', async () => {
      // Fire-and-forget, as all three were before the fold: a store that will
      // not take the row must not turn an advisory verdict into an error.
      mockEmitGateEvent.mockRejectedValueOnce(new Error('store is down'));
      const result = await runOn(DIFF_CORPUS.multiRule ?? '');
      expect(result.success).toBe(true);
      expect(appendedRows()).toHaveLength(DIFF_HYGIENE_RULES.length);
    });
  });

  // ─── The union property, over generated diffs ─────────────────────────────

  describe('the union property', () => {
    it('UnionOfRuleVerdicts_EqualsTheThreeCheckers', () => {
      // The characterization pins the corpus. This pins everything else: on any
      // composition of the corpus fragments, the aggregate is exactly the three
      // pure checkers' verdicts summed — never a fourth opinion, and never a
      // rule silently dropped from the fold.
      const fragments = CORPUS_KEYS.map((key) => DIFF_CORPUS[key] ?? '');

      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 0, max: fragments.length - 1 }), { minLength: 0, maxLength: 5 }),
          (picks) => {
            const diff = picks.map((index) => fragments[index] ?? '').join('');
            const scan = scanDiffHygiene(diff);

            const economy = checkContextEconomy(diff);
            const resilience = checkOperationalResilience(diff);
            const determinism = checkWorkflowDeterminism({ diffContent: diff });

            const expected = [
              { id: 'context-economy', passed: economy.pass, findingCount: economy.findings.length },
              {
                id: 'operational-resilience',
                passed: resilience.pass,
                findingCount: resilience.findingCount,
              },
              {
                id: 'workflow-determinism',
                passed: determinism.status === 'pass',
                findingCount: determinism.findingCount,
              },
            ];

            expect(
              scan.rules.map((rule) => ({
                id: rule.id,
                passed: rule.passed,
                findingCount: rule.findingCount,
              })),
            ).toEqual(expected);
            expect(scan.findingCount).toBe(
              expected.reduce((total, rule) => total + rule.findingCount, 0),
            );
            expect(scan.passed).toBe(expected.every((rule) => rule.passed));
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
