// ─── Pre-Synthesis Check Handler Tests ──────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider, PrSummary, PrFilter } from '../vcs/provider.js';

// ─── Mock node:fs ───────────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));

// ─── Mock node:child_process ────────────────────────────────────────────────
// Still needed for git branch --show-current and test/typecheck commands

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

// ─── Mock VCS factory to avoid loading shell.ts/detector.ts ────────────────

vi.mock('../vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { handlePreSynthesisCheck } from './pre-synthesis-check.js';
import { EventStore } from '../event-store/store.js';

// ─── Test Helpers ───────────────────────────────────────────────────────────

interface CheckReport {
  passed: boolean;
  report: string;
  checks: { pass: number; fail: number; skip: number };
}

function makeState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'synthesize',
    workflowType: 'feature',
    tasks: [
      { id: 'T1', status: 'complete' },
      { id: 'T2', status: 'complete' },
    ],
    reviews: {
      overall: { status: 'approved' },
    },
    ...overrides,
  });
}

function setupValidState(stateJson: string): void {
  // Test intent: no .exarchos.yml present — pure detection path. Without this
  // discrimination the universal readFileSync mock returns the workflow state
  // JSON for every path, which the resolver tries to validate as a config and
  // (correctly) rejects.
  vi.mocked(existsSync).mockImplementation((p) => !String(p).endsWith('.exarchos.yml'));
  vi.mocked(readFileSync).mockReturnValue(stateJson);
}

// ─── Mock VcsProvider Helper ────────────────────────────────────────────────

function createMockProvider(overrides: {
  listPrs?: PrSummary[];
  listPrsError?: Error;
} = {}): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    listPrs: overrides.listPrsError
      ? vi.fn().mockRejectedValue(overrides.listPrsError)
      : vi.fn<(filter?: PrFilter) => Promise<PrSummary[]>>().mockResolvedValue(overrides.listPrs ?? []),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    getRepository: vi.fn(),
  };
}

/**
 * Mock execFileSync for git branch --show-current (still uses git CLI, not VcsProvider).
 * Also used for test/typecheck commands.
 */
function mockGitBranch(branch: string = 'feature-branch'): void {
  vi.mocked(execFileSync).mockReturnValueOnce(`${branch}\n` as unknown as Buffer);
}

/** Mock execSync for tests-only (test command + optional typecheck). */
function mockTestsOnly(): void {
  vi.mocked(execSync)
    .mockReturnValueOnce(Buffer.from('Tests: 5 passed'))  // test command
    .mockReturnValueOnce(Buffer.from(''));                  // typecheck command
}

describe('handlePreSynthesisCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Test 1: All checks pass ────────────────────────────────────────────

  it('AllChecksPass_ReturnsPassed', async () => {
    setupValidState(makeState());
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: 'Test', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/state.json' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(true);
    expect(data.checks.fail).toBe(0);
    expect(data.checks.pass).toBeGreaterThanOrEqual(5);
  });

  // ─── Uses VcsProvider for PR stack ────────────────────────────────────

  it('UsesProviderListPrs_ForPrStackCheck', async () => {
    setupValidState(makeState());
    mockGitBranch('feat/my-branch');
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 42, url: '', title: 'My PR', headRefName: 'feat/my-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/state.json' }, provider);

    expect(result.success).toBe(true);
    expect(provider.listPrs).toHaveBeenCalledWith({ state: 'open', head: 'feat/my-branch' });
  });

  // ─── Test 2: State file not found ───────────────────────────────────────

  it('StateFileNotFound_ReturnsError', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/missing.json' });

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.checks.fail).toBeGreaterThanOrEqual(1);
    expect(data.report).toContain('not found');
  });

  // ─── Test 3: Phase not synthesize ───────────────────────────────────────

  it('PhaseNotSynthesize_ReturnsFailWithGuidance', async () => {
    setupValidState(makeState({ phase: 'review' }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/state.json' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.checks.fail).toBeGreaterThanOrEqual(1);
    expect(data.report).toContain('allReviewsPassed');
  });

  // ─── Test 4: Incomplete tasks ───────────────────────────────────────────

  it('IncompleteTasks_ReturnsFailWithDetails', async () => {
    setupValidState(makeState({
      tasks: [
        { id: 'T1', status: 'complete' },
        { id: 'T2', status: 'in-progress' },
        { id: 'T3', status: 'assigned' },
      ],
    }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/state.json' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('T2');
    expect(data.report).toContain('T3');
  });

  // ─── Test 5: Reviews not passed ────────────────────────────────────────

  it('ReviewsNotPassed_ReturnsFailWithDetails', async () => {
    setupValidState(makeState({
      reviews: { overall: { status: 'rejected' } },
    }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/state.json' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('overall');
  });

  // ─── Test 6: Tasks with needs_fixes ────────────────────────────────────

  it('TasksNeedsFixes_ReturnsFailWithDetails', async () => {
    setupValidState(makeState({
      tasks: [
        { id: 'T1', status: 'complete' },
        { id: 'T2', status: 'needs_fixes' },
      ],
    }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/state.json' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('needs_fixes');
    expect(data.report).toContain('T2');
  });

  // ─── Test 7: skipTests=true ────────────────────────────────────────────

  it('SkipTests_SkipsTestExecution', async () => {
    setupValidState(makeState());
    mockGitBranch();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({
      stateFile: '/tmp/state.json',
      skipTests: true,
    }, provider);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(true);
    expect(data.checks.skip).toBeGreaterThanOrEqual(1);
    expect(data.report).toContain('SKIP');
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });

  // ─── Test 8: skipStack=true ────────────────────────────────────────────

  it('SkipStack_SkipsPrStackCheck', async () => {
    setupValidState(makeState());
    mockTestsOnly();

    const result = await handlePreSynthesisCheck({
      stateFile: '/tmp/state.json',
      skipStack: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(true);
    expect(data.checks.skip).toBeGreaterThanOrEqual(1);
    expect(data.report).toContain('SKIP');
  });

  // ─── Test 9: Multiple review shapes ────────────────────────────────────

  it('MultipleReviewShapes_AllHandledCorrectly', async () => {
    setupValidState(makeState({
      reviews: {
        overhaul: { status: 'approved' },
        T1: {
          specReview: { status: 'pass' },
          qualityReview: { status: 'approved' },
        },
        T2: { passed: true },
      },
    }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/state.json' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(true);
    expect(data.report).not.toContain('FAIL');
  });

  // ─── Test 10: Nested review failure ────────────────────────────────────

  it('NestedReviewShape_FailingSubReview_Detected', async () => {
    setupValidState(makeState({
      reviews: {
        T1: {
          specReview: { status: 'pass' },
          qualityReview: { status: 'rejected' },
        },
      },
    }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/state.json' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('qualityReview');
  });

  // ─── Test 11: Legacy review passed=false ───────────────────────────────

  it('LegacyReviewShape_PassedFalse_Detected', async () => {
    setupValidState(makeState({
      reviews: { T1: { passed: false } },
    }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/state.json' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('T1');
  });

  // ─── Test 12: Invalid JSON ────────────────────────────────────────────

  it('InvalidJson_ReturnsFailWithDetail', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('{ invalid json }');

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/state.json' });

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('Invalid JSON');
  });

  // ─── Test 13: No tasks ────────────────────────────────────────────────

  it('NoTasks_ReturnsFailWithDetail', async () => {
    setupValidState(makeState({ tasks: [] }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/state.json' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('No tasks found');
  });

  // ─── Test 14: No reviews ──────────────────────────────────────────────

  it('NoReviews_ReturnsFailWithDetail', async () => {
    setupValidState(makeState({ reviews: {} }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/state.json' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('No review entries');
  });

  // ─── Test 15: Refactor overhaul-update-docs ────────────────────────────

  it('RefactorOverhaulUpdateDocs_ShowsTransitionGuidance', async () => {
    setupValidState(makeState({
      phase: 'overhaul-update-docs',
      workflowType: 'refactor',
    }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/state.json' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('docsUpdated');
  });

  // ─── Test 16: Debug review phase ──────────────────────────────────────

  it('DebugReviewPhase_ShowsTransitionGuidance', async () => {
    setupValidState(makeState({
      phase: 'debug-review',
      workflowType: 'debug',
    }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/state.json' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('reviewPassed');
  });

  // ─── Test 17: Refactor polish track ────────────────────────────────────

  it('RefactorPolishTrack_NotSynthesisEligible', async () => {
    setupValidState(makeState({
      phase: 'polish-implement',
      workflowType: 'refactor',
    }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/state.json' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('polish track');
  });

  // ─── PR Stack: No open PRs ────────────────────────────────────────────

  it('NoPrsForBranch_ReturnsFailForStack', async () => {
    setupValidState(makeState());
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({ listPrs: [] });

    const result = await handlePreSynthesisCheck({ stateFile: '/tmp/state.json' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('No open PRs');
  });

  // ─── Fileless resolution: MCP-only workflow (no .state.json) ───────────
  //
  // INV-1: the event store is the sole source of truth. A workflow created
  // purely through MCP tools may never write a `.state.json` stamp. The gate
  // MUST materialize state from the event store via featureId + eventStore
  // and run the planner-stamp checks against the projected view, NOT require
  // a state file on disk.

  it('FilelessMcpOnly_ResolvesFromEventStore_NoStateFileRequired', async () => {
    // No stateFile on disk — resolver must fall through to the event store.
    vi.mocked(existsSync).mockReturnValue(false);

    const eventStoreDir = await fsPromises.mkdtemp(
      nodePath.join(tmpdir(), 'pre-synth-fileless-'),
    );
    const eventStore = new EventStore(eventStoreDir);
    await eventStore.initialize();

    const featureId = 'fileless-feature';
    await eventStore.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await eventStore.append(featureId, {
      type: 'workflow.transition',
      data: { to: 'synthesize' },
    });
    // Planner-stamp fields (tasks/reviews) land on the projection via a
    // state.patched event — the same path `exarchos_workflow update` uses.
    await eventStore.append(featureId, {
      type: 'state.patched',
      data: {
        patch: {
          tasks: [
            { id: 'T1', status: 'complete' },
            { id: 'T2', status: 'complete' },
          ],
          reviews: { overall: { status: 'approved' } },
        },
      },
    });

    const provider = createMockProvider({
      listPrs: [
        { number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' },
      ],
    });

    const result = await handlePreSynthesisCheck(
      { featureId, eventStore, skipTests: true, skipStack: true },
      provider,
    );

    eventStore.close();
    await fsPromises.rm(eventStoreDir, { recursive: true, force: true });

    // Must NOT fail with INVALID_INPUT / FILE_NOT_FOUND / NO_STATE_SOURCE.
    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    // The state-dependent checks (phase, tasks, reviews) all pass off the
    // projected view — proving fileless resolution worked.
    expect(data.report).not.toContain('not found');
    expect(data.report).toContain('Phase is synthesize');
    expect(data.report).toContain('All tasks complete');
    expect(data.report).toContain('Reviews passed');
  });

  // ─── Malformed stateFile is not masked by the event-store fallback ─────
  //
  // Regression: when an explicit stateFile is corrupt AND a featureId +
  // eventStore fallback is available, resolveWorkflowState silently resolves
  // from the store, so the corruption used to go undetected (the report would
  // even claim the file as source). A corrupt explicit file must surface as the
  // Check-1 "Invalid JSON" failure rather than being masked by the fallback.

  it('MalformedStateFileWithEventStoreFallback_SurfacesInvalidJson', async () => {
    const BAD = '/tmp/corrupt.state.json';
    // The file exists but is unparseable; the event store CAN resolve (valid
    // synthesize state), so the old code would have silently used it.
    vi.mocked(existsSync).mockImplementation((p) => String(p) === BAD);
    vi.mocked(readFileSync).mockReturnValue('{ corrupt json');

    const eventStoreDir = await fsPromises.mkdtemp(
      nodePath.join(tmpdir(), 'pre-synth-corrupt-'),
    );
    const eventStore = new EventStore(eventStoreDir);
    await eventStore.initialize();

    const featureId = 'corrupt-feature';
    await eventStore.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await eventStore.append(featureId, {
      type: 'workflow.transition',
      data: { to: 'synthesize' },
    });
    await eventStore.append(featureId, {
      type: 'state.patched',
      data: {
        patch: {
          tasks: [{ id: 'T1', status: 'complete' }],
          reviews: { overall: { status: 'approved' } },
        },
      },
    });

    const provider = createMockProvider({ listPrs: [] });

    const result = await handlePreSynthesisCheck(
      { stateFile: BAD, featureId, eventStore, skipTests: true, skipStack: true },
      provider,
    );

    eventStore.close();
    await fsPromises.rm(eventStoreDir, { recursive: true, force: true });

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    // Corruption surfaced — NOT silently resolved off the event store.
    expect(data.report).toContain('Invalid JSON');
    // And the downstream state checks did not run off the masked fallback.
    expect(data.report).not.toContain('Phase is synthesize');
  });
});
