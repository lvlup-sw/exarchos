// Tests for `handlePreSynthesisCheck`. They test the verdict of the provider, so the phase-gate
// runner is a stub that calls only the provider. `unrunbooked-gate-evidence-dispatch.test.ts` tests
// the evidence over real dispatch. The VCS factory mock keeps `shell.ts` and `detector.ts` unloaded.
// The cases call the handler below `dispatch()`. `gateWiring` supplies the feature id, the state
// directory and the event store in place of dispatch.
//
// A call with no connector refuses before the runner, so each verdict case passes a stub connector,
// a stubbed branch observation and stubbed legs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider, PrSummary, PrFilter } from '../../../../src/vcs/provider.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('../../../../src/verbs/gates/gate-runner.js', async (importOriginal) => ({
  verifierNotProvisioned: (await importOriginal<typeof import('../../../../src/verbs/gates/gate-runner.js')>()).verifierNotProvisioned,
  runPhaseGateWithEvidence: vi.fn(async (request) => {
    try {
      return await request.executeProvider(
        {
          gateClass: request.gateClass,
          providerRef: 'test-provider',
          actionName: 'test-provider',
        },
        request.providerInput,
      );
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'GATE_PROVIDER_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }),
  admitLifecycleLegs: vi.fn(),
  hostedPendingResult: vi.fn((error: unknown) => { throw error; }),
  hostedRefusal: vi.fn((message: string) => ({ success: false, error: { code: 'HOSTED_VERIFICATION_REFUSED', message } })),
}));

vi.mock('../../../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

vi.mock('../../../../src/verbs/gates/gate-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/verbs/gates/gate-utils.js')>()),
  observeCurrentCheckout: vi.fn(),
}));

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { handlePreSynthesisCheck } from '../../../../src/verbs/gates/pre-synthesis-check.js';
import { admitLifecycleLegs, runPhaseGateWithEvidence } from '../../../../src/verbs/gates/gate-runner.js';
import { observeCurrentCheckout, type CurrentCheckoutRead } from '../../../../src/verbs/gates/gate-utils.js';
import { createVcsProvider } from '../../../../src/vcs/factory.js';
import type { VerificationHostConnector } from '../../../../src/contract/verification/harness-verification.js';
import { EventStore } from '../../../../src/events/store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const STATE_DIR = '/tmp/test-pre-synthesis-check';
const FEATURE_ID = 'pre-synthesis-feature';

let currentStore: EventStore;

/**
 * Builds a store whose events project to the given state. The event store is the authoritative state
 * source, so each case feeds its state through a store and not only through the file mock.
 * The projection skips `phase` and `workflowType` in a `state.patched` event, so they arrive as
 * lifecycle events.
 */
function storeFrom(stateJson: string): EventStore {
  const { phase, workflowType, ...patch } = JSON.parse(stateJson) as Record<string, unknown>;
  const events: { type: string; data: Record<string, unknown> }[] = [
    { type: 'workflow.started', data: { featureId: FEATURE_ID, workflowType: workflowType ?? 'feature' } },
  ];
  if (typeof phase === 'string') {
    events.push({ type: 'workflow.transition', data: { to: phase } });
  }
  events.push({ type: 'state.patched', data: { patch } });
  return {
    append: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue(events),
  } as unknown as EventStore;
}

/** A store with nothing usable to say — the no-state-source case. */
function unavailableStore(): EventStore {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockRejectedValue(new Error('store unavailable')),
  } as unknown as EventStore;
}

function gateWiring(): { featureId: string; stateDir: string; eventStore: EventStore } {
  return { featureId: FEATURE_ID, stateDir: STATE_DIR, eventStore: currentStore };
}

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

/**
 * Reports `.exarchos.yml` as absent, so the toolchain resolver uses detection. Otherwise the shared
 * `readFileSync` mock returns the state JSON as the config file, and the resolver rejects it.
 */
function setupValidState(stateJson: string): void {
  vi.mocked(existsSync).mockImplementation((p) => !String(p).endsWith('.exarchos.yml'));
  vi.mocked(readFileSync).mockReturnValue(stateJson);
  currentStore = storeFrom(stateJson);
}

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

/** Queues one constrained observation of the current checkout on the branch. The branch lookup uses the constrained reader. */
function mockGitBranch(branch: string = 'feature-branch'): void {
  const read = {
    kind: 'observed',
    checkout: { checkout: '/repo', repository: '/repo/.git', gitDir: '/repo/.git', branch: `refs/heads/${branch}`, head: 'c'.repeat(40) },
    observer: {},
  } as unknown as CurrentCheckoutRead;
  vi.mocked(observeCurrentCheckout).mockResolvedValueOnce(read);
}

/** The signed test leg and typecheck leg of the verifier, both green. */
function passingLegs() {
  const run = { end: 'exited' as const, exitCode: 0, stdout: 'Tests: 5 passed', stderr: '', outputDigest: 'a'.repeat(64) };
  return [{ name: 'test', kind: 'command' as const, run }, { name: 'typecheck', kind: 'typecheck' as const, run }];
}

/** Queues the green signed test and typecheck legs of the verifier. */
function mockTestsOnly(): void {
  vi.mocked(admitLifecycleLegs).mockResolvedValueOnce(passingLegs());
}

/** A connector whose verifier no case reaches directly. The hosted helper is a stub in this file. */
const connector: VerificationHostConnector = {
  publicKey: 'unused', gitPath: '/nonexistent/git', resourceId: 'unused', profileId: 'unused',
  client: {
    submit: async () => ({ kind: 'unavailable', reason: 'unused' }),
    retrieve: async () => ({ kind: 'unavailable', reason: 'unused' }),
  },
};

describe('handlePreSynthesisCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentStore = unavailableStore();
    vi.mocked(observeCurrentCheckout).mockResolvedValue({ kind: 'refused', reason: 'No branch is stubbed' });
    vi.mocked(admitLifecycleLegs).mockResolvedValue(passingLegs());
  });

  it('AllChecksPass_ReturnsPassed', async () => {
    setupValidState(makeState());
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: 'Test', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/state.json' }, provider, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(true);
    expect(data.checks.fail).toBe(0);
    expect(data.checks.pass).toBeGreaterThanOrEqual(5);
  });

  it('UsesProviderListPrs_ForPrStackCheck', async () => {
    setupValidState(makeState());
    mockGitBranch('feat/my-branch');
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 42, url: '', title: 'My PR', headRefName: 'feat/my-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/state.json' }, provider, connector);

    expect(result.success).toBe(true);
    expect(provider.listPrs).toHaveBeenCalledWith({ state: 'open', head: 'feat/my-branch' });
  });

  it('StateFileNotFound_ReturnsError', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/missing.json' }, undefined, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.checks.fail).toBeGreaterThanOrEqual(1);
    expect(data.report).toContain('not found');
  });

  it('PhaseNotSynthesize_ReturnsFailWithGuidance', async () => {
    setupValidState(makeState({ phase: 'review' }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/state.json' }, provider, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.checks.fail).toBeGreaterThanOrEqual(1);
    expect(data.report).toContain('allReviewsPassed');
  });

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

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/state.json' }, provider, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('T2');
    expect(data.report).toContain('T3');
  });

  it('ReviewsNotPassed_ReturnsFailWithDetails', async () => {
    setupValidState(makeState({
      reviews: { overall: { status: 'rejected' } },
    }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/state.json' }, provider, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('overall');
  });

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

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/state.json' }, provider, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('needs_fixes');
    expect(data.report).toContain('T2');
  });

  it('SkipTests_SkipsTestExecution', async () => {
    setupValidState(makeState());
    mockGitBranch();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({
      ...gateWiring(),
      stateFile: '/tmp/state.json',
      skipTests: true,
    }, provider, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(true);
    expect(data.checks.skip).toBeGreaterThanOrEqual(1);
    expect(data.report).toContain('SKIP');
    expect(admitLifecycleLegs).not.toHaveBeenCalled();
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });

  it('SkipStack_SkipsPrStackCheck', async () => {
    setupValidState(makeState());
    mockTestsOnly();

    const result = await handlePreSynthesisCheck({
      ...gateWiring(),
      stateFile: '/tmp/state.json',
      skipStack: true,
    }, undefined, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(true);
    expect(data.checks.skip).toBeGreaterThanOrEqual(1);
    expect(data.report).toContain('SKIP');
  });

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

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/state.json' }, provider, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(true);
    expect(data.report).not.toContain('FAIL');
  });

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

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/state.json' }, provider, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('qualityReview');
  });

  it('LegacyReviewShape_PassedFalse_Detected', async () => {
    setupValidState(makeState({
      reviews: { T1: { passed: false } },
    }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/state.json' }, provider, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('T1');
  });

  it('InvalidJson_ReturnsFailWithDetail', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('{ invalid json }');

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/state.json' }, undefined, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('Invalid JSON');
  });

  it('NoTasks_ReturnsFailWithDetail', async () => {
    setupValidState(makeState({ tasks: [] }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/state.json' }, provider, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('No tasks found');
  });

  it('NoReviews_ReturnsFailWithDetail', async () => {
    setupValidState(makeState({ reviews: {} }));
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/state.json' }, provider, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('No review entries');
  });

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

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/state.json' }, provider, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('docsUpdated');
  });

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

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/state.json' }, provider, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('reviewPassed');
  });

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

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/state.json' }, provider, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('polish track');
  });

  it('NoPrsForBranch_ReturnsFailForStack', async () => {
    setupValidState(makeState());
    mockGitBranch();
    mockTestsOnly();

    const provider = createMockProvider({ listPrs: [] });

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: '/tmp/state.json' }, provider, connector);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('No open PRs');
  });

  /**
   * A workflow that only MCP tools create can have no `.state.json` stamp. The gate must project the
   * state from the event store and run the phase, task and review checks against that view.
   */
  it('FilelessMcpOnly_ResolvesFromEventStore_NoStateFileRequired', async () => {
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

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), featureId, eventStore, skipTests: true, skipStack: true },
      provider, connector,
    );

    eventStore.close();
    await rmrfAsync(eventStoreDir);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.report).not.toContain('not found');
    expect(data.report).toContain('Phase is synthesize');
    expect(data.report).toContain('All tasks complete');
    expect(data.report).toContain('Reviews passed');
  });

  /**
   * The event-store fallback must not hide a corrupt explicit state file. The store holds a valid
   * synthesize state, so a silent fallback passes the phase check. The report must show "Invalid JSON".
   */
  it('MalformedStateFileWithEventStoreFallback_SurfacesInvalidJson', async () => {
    const BAD = '/tmp/corrupt.state.json';
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

    const result = await handlePreSynthesisCheck({
      ...gateWiring(), stateFile: BAD, featureId, eventStore, skipTests: true, skipStack: true },
      provider, connector,
    );

    eventStore.close();
    await rmrfAsync(eventStoreDir);

    expect(result.success).toBe(true);
    const data = result.data as CheckReport;
    expect(data.passed).toBe(false);
    expect(data.report).toContain('Invalid JSON');
    expect(data.report).not.toContain('Phase is synthesize');
  });

  /** A provisioned route sends the test and typecheck legs to the verifier in one stopping request and runs no local command. */
  it('Provisioned_TestsRunOnlyThroughHostedLifecycleLegs', async () => {
    setupValidState(makeState());
    const run = { end: 'exited' as const, exitCode: 0, stdout: '', stderr: '', outputDigest: 'a'.repeat(64) };
    vi.mocked(admitLifecycleLegs).mockResolvedValue([{ name: 'test', kind: 'command', run }, { name: 'typecheck', kind: 'typecheck', run }]);

    const result = await handlePreSynthesisCheck({ ...gateWiring(), repoRoot: '/repo', skipStack: true }, createMockProvider(), connector);

    expect(result.success).toBe(true);
    expect((result.data as CheckReport).report).toContain('**PASS**: Tests pass');
    expect(admitLifecycleLegs).toHaveBeenCalledTimes(1);
    expect(admitLifecycleLegs).toHaveBeenCalledWith(expect.objectContaining({
      connector, checkout: '/repo', stopAfterTestFailure: true, streamId: FEATURE_ID,
    }));
    expect(vi.mocked(admitLifecycleLegs).mock.calls[0]?.[0].legs[0]?.kind).toBe('command');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  /** A provisioned route refuses a caller test-command override before any request. */
  it('Provisioned_TestCommandOverride_RefusesBeforeAnyRequest', async () => {
    setupValidState(makeState());

    const result = await handlePreSynthesisCheck({ ...gateWiring(), repoRoot: '/repo', skipStack: true, testCommand: 'node test.cjs' }, createMockProvider(), connector);

    expect(result).toMatchObject({ success: false, error: { code: 'HOSTED_VERIFICATION_REFUSED' } });
    expect(admitLifecycleLegs).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  /** With no connector, the check refuses after argument validation, also for `skipTests` and `skipStack`, before the runner, the provider and any read. */
  it('NoConnector_RefusesWithVerifierNotProvisioned', async () => {
    setupValidState(makeState());
    for (const flags of [{}, { skipTests: true, skipStack: true }]) {
      const result = await handlePreSynthesisCheck({ ...gateWiring(), stateFile: '/tmp/state.json', ...flags }, createMockProvider());

      expect(result).toMatchObject({ success: false, error: { code: 'VERIFIER_NOT_PROVISIONED' } });
    }
    expect(runPhaseGateWithEvidence).not.toHaveBeenCalled();
    expect(createVcsProvider).not.toHaveBeenCalled();
    expect(observeCurrentCheckout).not.toHaveBeenCalled();
    expect(admitLifecycleLegs).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  /**
   * The PR-stack branch comes from the constrained observation of the absolute checkout root with the connector Git path.
   * A detached HEAD or another refused observation fails the check, and the provider gets no query.
   */
  it('PrStack_ConstrainedBranchRead_UsesConnectorGitPathAndFailsClosed', async () => {
    setupValidState(makeState());
    const provider = createMockProvider({
      listPrs: [{ number: 1, url: '', title: '', headRefName: 'feature-branch', baseRefName: 'main', state: 'OPEN' }],
    });
    vi.mocked(observeCurrentCheckout).mockResolvedValueOnce({ kind: 'refused', reason: 'The checkout HEAD is detached' });

    const result = await handlePreSynthesisCheck({ ...gateWiring(), stateFile: '/tmp/state.json' }, provider, connector);

    expect(observeCurrentCheckout).toHaveBeenCalledWith(connector.gitPath, nodePath.resolve('.'));
    expect((result.data as CheckReport).report).toContain('Could not determine current branch');
    expect(provider.listPrs).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
