// ─── Validate PR Stack Handler Tests ────────────────────────────────────────
//
// Tests use a mock VcsProvider instead of mocking execFileSync.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { VcsProvider, PrSummary, PrFilter } from '../../../../src/vcs/provider.js';
import { UnsupportedOperationError } from '../../../../src/vcs/provider.js';

// The composed router calls this handler with ONE argument, so the production
// path resolves its own provider. Mocking the factory is what lets a test stand
// where production stands.
// The mock FORWARDS its argument: `createVcsProvider` resolves the configured
// `vcs.provider` from it and only auto-detects when it is absent, so a stub that
// swallowed the argument could not tell a threaded config from a dropped one.
const mockCreateVcsProvider = vi.fn<(opts?: CreateVcsProviderOpts) => Promise<VcsProvider>>();
vi.mock('../../../../src/vcs/factory.js', () => ({
  createVcsProvider: (opts?: CreateVcsProviderOpts) => mockCreateVcsProvider(opts),
}));

import type { CreateVcsProviderOpts } from '../../../../src/vcs/factory.js';
import type { ResolvedProjectConfig } from '../../../../src/config/resolve.js';
import { handleValidatePrStack } from '../../../../src/verbs/vcs/validate-pr-stack.js';

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

describe('handleValidatePrStack', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockCreateVcsProvider.mockReset();
  });

  it('NoPRs_ReturnsPassedTrue', async () => {
    const provider = createMockProvider({ listPrs: [] });
    const result = await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; prCount: number; errors: readonly string[] };
    expect(data.passed).toBe(true);
    expect(data.prCount).toBe(0);
    expect(data.errors).toEqual([]);
  });

  it('ValidLinearChain_ReturnsPassedTrueWithVisualization', async () => {
    const prs: PrSummary[] = [
      { number: 1, url: '', title: '', baseRefName: 'main', headRefName: 'feat-a', state: 'OPEN' },
      { number: 2, url: '', title: '', baseRefName: 'feat-a', headRefName: 'feat-b', state: 'OPEN' },
      { number: 3, url: '', title: '', baseRefName: 'feat-b', headRefName: 'feat-c', state: 'OPEN' },
    ];
    const provider = createMockProvider({ listPrs: prs });
    const result = await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; prCount: number; report: string; errors: readonly string[] };
    expect(data.passed).toBe(true);
    expect(data.prCount).toBe(3);
    expect(data.errors).toEqual([]);
    expect(data.report).toContain('#1');
    expect(data.report).toContain('#2');
    expect(data.report).toContain('#3');
    expect(data.report).toContain('main');
    expect(data.report).toContain('feat-a');
    expect(data.report).toContain('feat-b');
    expect(data.report).toContain('feat-c');
  });

  it('PRBaseNotInStack_ReturnsPassedFalseWithError', async () => {
    const prs: PrSummary[] = [
      { number: 1, url: '', title: '', baseRefName: 'main', headRefName: 'feat-a', state: 'OPEN' },
      { number: 2, url: '', title: '', baseRefName: 'orphan-branch', headRefName: 'feat-b', state: 'OPEN' },
    ];
    const provider = createMockProvider({ listPrs: prs });
    const result = await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; errors: readonly string[] };
    expect(data.passed).toBe(false);
    expect(data.errors.length).toBeGreaterThan(0);
    expect(data.errors.some((e: string) => e.includes('#2') && e.includes('orphan-branch'))).toBe(true);
  });

  it('MultiplePRsTargetBase_ReturnsPassedFalse', async () => {
    const prs: PrSummary[] = [
      { number: 1, url: '', title: '', baseRefName: 'main', headRefName: 'feat-a', state: 'OPEN' },
      { number: 2, url: '', title: '', baseRefName: 'main', headRefName: 'feat-b', state: 'OPEN' },
    ];
    const provider = createMockProvider({ listPrs: prs });
    const result = await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; errors: readonly string[] };
    expect(data.passed).toBe(false);
    expect(data.errors.some((e: string) => e.includes('Multiple PRs'))).toBe(true);
  });

  it('NoPRTargetsBase_ReturnsPassedFalse', async () => {
    const prs: PrSummary[] = [
      { number: 1, url: '', title: '', baseRefName: 'feat-a', headRefName: 'feat-b', state: 'OPEN' },
      { number: 2, url: '', title: '', baseRefName: 'feat-b', headRefName: 'feat-c', state: 'OPEN' },
    ];
    const provider = createMockProvider({ listPrs: prs });
    const result = await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; errors: readonly string[] };
    expect(data.passed).toBe(false);
    expect(data.errors.some((e: string) => e.includes('No PR targets'))).toBe(true);
  });

  it('ProviderFailure_ReturnsErrorResult', async () => {
    const provider = createMockProvider({
      listPrsError: new Error('gh: command not found'),
    });
    const result = await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('GH_CLI_ERROR');
  });

  it('ForkDetection_BranchUsedAsBaseByMultiplePRs', async () => {
    const prs: PrSummary[] = [
      { number: 1, url: '', title: '', baseRefName: 'main', headRefName: 'feat-a', state: 'OPEN' },
      { number: 2, url: '', title: '', baseRefName: 'feat-a', headRefName: 'feat-b', state: 'OPEN' },
      { number: 3, url: '', title: '', baseRefName: 'feat-a', headRefName: 'feat-c', state: 'OPEN' },
    ];
    const provider = createMockProvider({ listPrs: prs });
    const result = await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; errors: readonly string[] };
    expect(data.passed).toBe(false);
    expect(data.errors.some((e: string) => e.includes('fork'))).toBe(true);
  });

  it('MissingBaseBranch_ReturnsError', async () => {
    const result = await handleValidatePrStack({ baseBranch: '' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('INVALID_INPUT');
  });

  it('UsesProviderListPrs_WithStateOpenFilter', async () => {
    const provider = createMockProvider({ listPrs: [] });
    await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(provider.listPrs).toHaveBeenCalledWith({ state: 'open' });
  });

  // ─── Host capability ─────────────────────────────────────────────────────

  it('NonGitHubProvider_YieldsADeclaredSkip_NotGhCliError', async () => {
    // GitLab and Azure DevOps both throw `UnsupportedOperationError` from
    // `listPrs`, which this handler converts into a hard `GH_CLI_ERROR`. Since
    // the action is a BLOCKING synthesis gate, that turned "this obligation does
    // not apply to your host" into "your synthesis failed".
    const provider: VcsProvider = {
      ...createMockProvider(),
      name: 'gitlab',
      listPrs: vi.fn().mockRejectedValue(new UnsupportedOperationError('gitlab', 'listPrs')),
    };

    const result = await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as { skipped?: boolean; provider?: string; operation?: string };
    expect(data.skipped).toBe(true);
    expect(data.provider).toBe('gitlab');
    expect(data.operation).toBe('validate_pr_stack');
    // The skip happens BEFORE the unsupported call, so nothing throws.
    expect(provider.listPrs).not.toHaveBeenCalled();
  });

  it('SkipBranch_IsReachableInProduction', async () => {
    // Called the way the router calls it: args only. The guard used to read the
    // absent `provider` parameter, which it treats as "unconfigured, GitHub is
    // implicit" — so on a real GitLab repository the skip was unreachable and
    // the handler fell through to a hard failure. Resolving first is what makes
    // the declared control run.
    mockCreateVcsProvider.mockResolvedValue({
      ...createMockProvider(),
      name: 'azure-devops',
    });

    const result = await handleValidatePrStack({ baseBranch: 'main' });

    expect(mockCreateVcsProvider).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.data as { skipped?: boolean }).toMatchObject({
      skipped: true,
      provider: 'azure-devops',
    });

    // A blocking gate must still carry a verdict. The skip descriptor makes it
    // inconclusive, which fails closed at the phase boundary — it is not the
    // vacuous pass that would let an unrunnable control read as coverage.
    const { normalizeGateVerdict } = await import('../../../../src/verbs/gates/gate-utils.js');
    expect(normalizeGateVerdict(result)).toBe('indeterminate');
  });

  it('GitHubProvider_ResolvedByTheFactory_StillRuns', async () => {
    // The guard must not turn into a blanket skip: a resolved GitHub provider
    // is exactly the case the gate exists for.
    mockCreateVcsProvider.mockResolvedValue(createMockProvider({ listPrs: [] }));

    const result = await handleValidatePrStack({ baseBranch: 'main' });

    expect(result.success).toBe(true);
    expect((result.data as { passed: boolean }).passed).toBe(true);
  });

  it('MissingBaseBranch_IsRejectedBeforeAnyProviderIsResolved', async () => {
    const result = await handleValidatePrStack({ baseBranch: '' });

    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(mockCreateVcsProvider).not.toHaveBeenCalled();
  });

  // ─── Provider resolution reads the project's declaration ─────────────────

  it('ConfiguredProvider_ReachesTheFactory_RatherThanHostnameDetection', async () => {
    // `createVcsProvider` prefers `config.vcs.provider` and only falls back to
    // parsing the remote's HOSTNAME. Calling it bare demotes an explicit
    // declaration to a guess — and the guess misses every self-hosted or
    // enterprise host, landing on the GitHub default for a repository that
    // said it was something else.
    mockCreateVcsProvider.mockResolvedValue({ ...createMockProvider(), name: 'gitlab' });
    const projectConfig = { vcs: { provider: 'gitlab' } } as unknown as ResolvedProjectConfig;

    await handleValidatePrStack({ baseBranch: 'main', projectConfig });

    expect(mockCreateVcsProvider).toHaveBeenCalledWith({ config: projectConfig });
  });

  it('Router_InjectsTheDispatchConfig_SoTheArgIsNotADeadCarrier', async () => {
    // The handler reads `args.projectConfig`; nothing would ever write it unless
    // the composite adapter does. Asserting only the handler would leave a
    // parameter no caller fills — the config would still be dropped, just one
    // layer further out.
    mockCreateVcsProvider.mockResolvedValue({ ...createMockProvider(), name: 'gitlab' });
    const projectConfig = { vcs: { provider: 'gitlab' } } as unknown as ResolvedProjectConfig;

    const { handleOrchestrate } = await import('../../../../src/verbs/composite.js');
    await handleOrchestrate(
      { action: 'validate_pr_stack', baseBranch: 'main' },
      { stateDir: '/tmp/validate-pr-stack-router', projectConfig, enableTelemetry: false } as never,
    );

    expect(mockCreateVcsProvider).toHaveBeenCalledWith({ config: projectConfig });
  });
});
