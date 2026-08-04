/**
 * Frozen v2.12 legacy transition-decision baseline.
 *
 * This corpus deliberately records what the legacy HSM/guard path does today,
 * including permissive behavior. It is migration input for a future shadow
 * evaluator, not a policy definition and not an enforcement surface.
 */

export const LEGACY_TRANSITION_CORPUS_POSTURE = 'audit-shadow' as const;

export type BuiltInWorkflowType =
  | 'feature'
  | 'debug'
  | 'refactor'
  | 'oneshot'
  | 'discovery';

export const BUILT_IN_WORKFLOW_TYPES: readonly BuiltInWorkflowType[] = Object.freeze([
  'feature',
  'debug',
  'refactor',
  'oneshot',
  'discovery',
]);

export interface LegacyTransitionDecision {
  readonly verdict: 'allow' | 'deny';
  readonly explanation: string;
}

/**
 * `config-bearing` fixtures carry the INJECTED `.exarchos.yml` / tier state the
 * legacy guards read (`_maxPlanRevisions`, `_requiredReviews`,
 * `_mutationEnforcement` / `_mutationThreshold` / `_maxNoCoverage`) or a
 * non-default oneshot synthesis policy. They live in {@link configBearingCorpus},
 * NOT in the frozen {@link legacyTransitionCorpus}, so the frozen baseline keeps
 * its "exactly one representative-pass + one representative-fail per edge"
 * invariant.
 */
export interface LegacyTransitionFixture {
  readonly id: string;
  readonly workflowType: BuiltInWorkflowType;
  readonly from: string;
  readonly to: string;
  readonly scenario:
    | 'representative-pass'
    | 'representative-fail'
    | 'bypass'
    | 'config-bearing';
  readonly state: Readonly<Record<string, unknown>>;
  readonly expected: LegacyTransitionDecision;
}

const allow = (from: string, to: string): LegacyTransitionDecision => ({
  verdict: 'allow',
  explanation: `Legacy HSM admitted ${from} -> ${to}`,
});

const deny = (guardId: string, reason: string): LegacyTransitionDecision => ({
  verdict: 'deny',
  explanation: `Guard '${guardId}' failed: ${reason}`,
});

interface EdgeCases {
  readonly workflowType: BuiltInWorkflowType;
  readonly from: string;
  readonly to: string;
  readonly guardId: string;
  readonly pass: Readonly<Record<string, unknown>>;
  readonly fail: Readonly<Record<string, unknown>>;
  readonly failReason: string;
  /** Captures intentionally permissive guards whose fail-shaped state also passes. */
  readonly failExpected?: LegacyTransitionDecision;
}

function edgeCases(edge: EdgeCases): readonly LegacyTransitionFixture[] {
  const stem = `${edge.workflowType}-${edge.from}-to-${edge.to}`;
  return [
    {
      id: `${stem}-pass`,
      workflowType: edge.workflowType,
      from: edge.from,
      to: edge.to,
      scenario: 'representative-pass',
      state: edge.pass,
      expected: allow(edge.from, edge.to),
    },
    {
      id: `${stem}-fail`,
      workflowType: edge.workflowType,
      from: edge.from,
      to: edge.to,
      scenario: 'representative-fail',
      state: edge.fail,
      expected: edge.failExpected ?? deny(edge.guardId, edge.failReason),
    },
  ];
}

const featureCases: readonly LegacyTransitionFixture[] = [
  ...edgeCases({
    workflowType: 'feature',
    from: 'plan',
    to: 'plan-review',
    guardId: 'plan-artifact-exists',
    pass: { artifacts: { plan: 'docs/specs/feature.md' } },
    fail: {},
    failReason: 'plan-artifact-exists not satisfied',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'plan-review',
    to: 'delegate',
    guardId: 'plan-review-complete',
    pass: { planReview: { approved: true } },
    fail: {},
    failReason: 'plan-review-complete not satisfied: planReview.approved must be true',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'plan-review',
    to: 'blocked',
    guardId: 'revisions-exhausted',
    pass: { planReview: { revisionCount: 1 } },
    fail: { planReview: { revisionCount: 0 } },
    failReason: 'revisions-exhausted not satisfied: 0/1 revisions',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'plan-review',
    to: 'plan',
    guardId: 'plan-review-gaps-found',
    pass: { planReview: { gapsFound: true } },
    fail: {},
    failReason: 'plan-review-gaps-found not satisfied: planReview.gapsFound must be true',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'delegate',
    to: 'review',
    guardId: 'all-tasks-complete+team-disbanded',
    pass: { tasks: [{ id: '001', status: 'complete' }], _events: [] },
    fail: { tasks: [{ id: '001', status: 'in_progress' }], _events: [] },
    failReason: 'all-tasks-complete not satisfied: 1 task(s) incomplete',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'delegate',
    to: 'merge-pending',
    guardId: 'merge-pending-entry',
    pass: {
      _events: [{ type: 'task.completed', data: { worktree: '.worktrees/task-001' } }],
    },
    fail: { _events: [{ type: 'task.completed', data: {} }] },
    failReason:
      'merge-pending-entry not satisfied: latest task.completed event lacks data.worktree / data.worktreePath',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'merge-pending',
    to: 'delegate',
    guardId: 'merge-pending-exit',
    pass: {
      _events: [
        { type: 'task.completed', data: { worktree: '.worktrees/task-001' } },
        { type: 'merge.executed', data: {} },
      ],
    },
    fail: {
      _events: [{ type: 'task.completed', data: { worktree: '.worktrees/task-001' } }],
    },
    failReason:
      'merge-pending-exit not satisfied: no merge.executed/merge.rollback/merge.recovered/merge.aborted event found after the latest task.completed and mergeOrchestrator.phase is not terminal',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'review',
    to: 'synthesize',
    guardId: 'all-reviews-passed',
    pass: { reviews: { quality: { status: 'approved' } } },
    fail: {},
    failReason:
      'state.reviews is missing — set reviews.{name} with status: "pass" or "approved"',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'review',
    to: 'delegate',
    guardId: 'any-review-failed',
    pass: { reviews: { quality: { status: 'failed' } } },
    fail: {},
    failReason: 'state.reviews is missing — cannot determine if any review failed',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'synthesize',
    to: 'delegate',
    guardId: 'synthesize-retryable',
    pass: { synthesis: { lastError: 'push failed', retryCount: 0 } },
    fail: {},
    failReason: 'synthesize-retryable not satisfied: no lastError recorded',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'synthesize',
    to: 'completed',
    guardId: 'pr-url-exists',
    pass: { synthesis: { prUrl: 'https://example.test/pr/1' } },
    fail: {},
    failReason: 'pr-url-exists not satisfied: synthesis.prUrl or artifacts.pr must be set',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'blocked',
    to: 'delegate',
    guardId: 'human-unblocked',
    pass: { unblocked: true },
    fail: {},
    failReason: 'human-unblocked not satisfied: set state.unblocked to true',
  }),
];

const debugCases: readonly LegacyTransitionFixture[] = [
  ...edgeCases({
    workflowType: 'debug',
    from: 'triage',
    to: 'investigate',
    guardId: 'triage-complete',
    pass: { triage: { symptom: 'request fails' } },
    fail: {},
    failReason: 'triage-complete not satisfied',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'investigate',
    to: 'rca',
    guardId: 'thorough-track-selected',
    pass: { track: 'thorough' },
    fail: {},
    failReason: 'thorough-track-selected not satisfied: state.track must be \'thorough\' (current: undefined)',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'investigate',
    to: 'hotfix-implement',
    guardId: 'hotfix-track-selected',
    pass: { track: 'hotfix' },
    fail: {},
    failReason: 'hotfix-track-selected not satisfied: state.track must be \'hotfix\' (current: undefined)',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'investigate',
    to: 'cancelled',
    guardId: 'escalation-required',
    pass: { investigation: { escalate: true } },
    fail: {},
    failReason: 'escalation-required not satisfied',
    // executeTransition handles cancelled as a universal edge before guards.
    failExpected: allow('investigate', 'cancelled'),
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'investigate',
    to: 'completed',
    guardId: 'fix-verified-directly',
    pass: { resolution: { directPush: true, commitSha: 'abc123' } },
    fail: {},
    failReason:
      'fix-verified-directly not satisfied: resolution.directPush and resolution.commitSha required',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'rca',
    to: 'design',
    guardId: 'rca-document-complete',
    pass: { artifacts: { rca: 'docs/rca.md' } },
    fail: {},
    failReason: 'rca-document-complete not satisfied',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'design',
    to: 'debug-implement',
    guardId: 'fix-design-complete',
    pass: { artifacts: { fixDesign: 'docs/fix.md' } },
    fail: {},
    failReason: 'fix-design-complete not satisfied',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'debug-implement',
    to: 'debug-validate',
    guardId: 'implementation-complete',
    pass: { implementation: { complete: true } },
    fail: { implementation: { complete: false } },
    failReason: 'unreachable: implementation-complete always passes',
    failExpected: allow('debug-implement', 'debug-validate'),
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'debug-validate',
    to: 'debug-review',
    guardId: 'validation-passed',
    pass: { validation: { testsPass: true } },
    fail: { validation: { testsPass: false } },
    failReason: 'validation-passed not satisfied',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'debug-review',
    to: 'synthesize',
    guardId: 'review-passed',
    pass: { reviews: { quality: { verdict: 'PASS' } } },
    fail: {},
    failReason:
      'state.reviews is missing — set reviews.{name} with status: "pass" or "approved"',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'hotfix-implement',
    to: 'hotfix-validate',
    guardId: 'implementation-complete',
    pass: { implementation: { complete: true } },
    fail: { implementation: { complete: false } },
    failReason: 'unreachable: implementation-complete always passes',
    failExpected: allow('hotfix-implement', 'hotfix-validate'),
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'hotfix-validate',
    to: 'synthesize',
    guardId: 'validation+pr-requested',
    pass: { validation: { testsPass: true }, synthesis: { requested: true } },
    fail: { validation: { testsPass: false } },
    failReason: 'validation-passed not satisfied',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'hotfix-validate',
    to: 'completed',
    guardId: 'validation-passed',
    pass: { validation: { testsPass: true } },
    fail: { validation: { testsPass: false } },
    failReason: 'validation-passed not satisfied',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'synthesize',
    to: 'debug-implement',
    guardId: 'synthesize-retryable+thorough-track',
    pass: { synthesis: { lastError: 'push failed', retryCount: 0 }, track: 'thorough' },
    fail: { track: 'thorough' },
    failReason: 'synthesize-retryable not satisfied: no lastError recorded',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'synthesize',
    to: 'hotfix-implement',
    guardId: 'synthesize-retryable+hotfix-track',
    pass: { synthesis: { lastError: 'push failed', retryCount: 0 }, track: 'hotfix' },
    fail: { track: 'hotfix' },
    failReason: 'synthesize-retryable not satisfied: no lastError recorded',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'synthesize',
    to: 'completed',
    guardId: 'pr-url-exists',
    pass: { artifacts: { pr: 'https://example.test/pr/2' } },
    fail: {},
    failReason: 'pr-url-exists not satisfied: synthesis.prUrl or artifacts.pr must be set',
  }),
];

const oneshotCases: readonly LegacyTransitionFixture[] = [
  ...edgeCases({
    workflowType: 'oneshot',
    from: 'plan',
    to: 'implementing',
    guardId: 'oneshot-plan-set',
    pass: { artifacts: { plan: 'Implement the small change' } },
    fail: { oneshot: { planSummary: 'summary only' } },
    failReason:
      'oneshot-plan-set not satisfied: state.artifacts.plan is required (a non-empty string of plan contents or a plan path) before transitioning plan → implementing. `oneshot.planSummary` alone does not satisfy this guard, and non-string values (true, objects, numbers) are not accepted.',
  }),
  ...edgeCases({
    workflowType: 'oneshot',
    from: 'implementing',
    to: 'synthesize',
    guardId: 'synthesis-opted-in',
    pass: { oneshot: { synthesisPolicy: 'always' } },
    fail: { oneshot: { synthesisPolicy: 'never' } },
    failReason: 'synthesis-opted-in not satisfied: synthesisPolicy=never (direct-commit path)',
  }),
  ...edgeCases({
    workflowType: 'oneshot',
    from: 'implementing',
    to: 'completed',
    guardId: 'synthesis-opted-out',
    pass: { oneshot: { synthesisPolicy: 'never' } },
    fail: { oneshot: { synthesisPolicy: 'always' } },
    failReason: 'synthesis-opted-out not satisfied: synthesisPolicy=always (synthesize path)',
  }),
  ...edgeCases({
    workflowType: 'oneshot',
    from: 'synthesize',
    to: 'completed',
    guardId: 'merge-verified',
    pass: { _cleanup: { mergeVerified: true } },
    fail: {},
    failReason:
      'Cleanup requires mergeVerified flag — verify PRs are merged via GitHub API before invoking cleanup',
  }),
];

const discoveryCases: readonly LegacyTransitionFixture[] = [
  ...edgeCases({
    workflowType: 'discovery',
    from: 'gathering',
    to: 'synthesizing',
    guardId: 'sources-collected',
    pass: { artifacts: { sources: ['https://example.test/source'] } },
    fail: { artifacts: { sources: [] } },
    failReason: 'sources-collected not satisfied: artifacts.sources must be a non-empty array',
  }),
  ...edgeCases({
    workflowType: 'discovery',
    from: 'synthesizing',
    to: 'completed',
    guardId: 'report-artifact-exists',
    pass: { artifacts: { report: 'docs/report.md' } },
    fail: {},
    failReason: 'report-artifact-exists not satisfied',
  }),
];

const refactorCases: readonly LegacyTransitionFixture[] = [
  ...edgeCases({
    workflowType: 'refactor',
    from: 'explore',
    to: 'brief',
    guardId: 'scope-assessment-complete',
    pass: { explore: { scopeAssessment: 'bounded change' } },
    fail: {},
    failReason: 'scope-assessment-complete not satisfied',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'brief',
    to: 'polish-implement',
    guardId: 'polish-track-selected',
    pass: { track: 'polish' },
    fail: {},
    failReason: 'polish-track-selected not satisfied: state.track must be \'polish\' (current: undefined)',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'brief',
    to: 'overhaul-plan',
    guardId: 'overhaul-track-selected',
    pass: { track: 'overhaul' },
    fail: {},
    failReason: 'overhaul-track-selected not satisfied: state.track must be \'overhaul\' (current: undefined)',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'polish-implement',
    to: 'polish-validate',
    guardId: 'implementation-complete',
    pass: { implementation: { complete: true } },
    fail: { implementation: { complete: false } },
    failReason: 'unreachable: implementation-complete always passes',
    failExpected: allow('polish-implement', 'polish-validate'),
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'polish-validate',
    to: 'polish-update-docs',
    guardId: 'goals-verified',
    pass: { validation: { testsPass: true } },
    fail: { validation: { testsPass: false } },
    failReason: 'goals-verified not satisfied',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'polish-update-docs',
    to: 'completed',
    guardId: 'docs-updated',
    pass: { validation: { docsUpdated: true } },
    fail: { validation: { docsUpdated: false } },
    failReason: 'docs-updated not satisfied',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'overhaul-plan',
    to: 'overhaul-plan-review',
    guardId: 'plan-artifact-exists',
    pass: { artifacts: { plan: 'docs/overhaul-plan.md' } },
    fail: {},
    failReason: 'plan-artifact-exists not satisfied',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'overhaul-plan-review',
    to: 'overhaul-delegate',
    guardId: 'plan-review-complete',
    pass: { planReview: { approved: true } },
    fail: {},
    failReason: 'plan-review-complete not satisfied: planReview.approved must be true',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'overhaul-plan-review',
    to: 'blocked',
    guardId: 'revisions-exhausted',
    pass: { planReview: { revisionCount: 1 } },
    fail: { planReview: { revisionCount: 0 } },
    failReason: 'revisions-exhausted not satisfied: 0/1 revisions',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'overhaul-plan-review',
    to: 'overhaul-plan',
    guardId: 'plan-review-gaps-found',
    pass: { planReview: { gapsFound: true } },
    fail: {},
    failReason: 'plan-review-gaps-found not satisfied: planReview.gapsFound must be true',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'blocked',
    to: 'overhaul-delegate',
    guardId: 'human-unblocked',
    pass: { unblocked: true },
    fail: {},
    failReason: 'human-unblocked not satisfied: set state.unblocked to true',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'overhaul-delegate',
    to: 'overhaul-review',
    guardId: 'all-tasks-complete',
    pass: { tasks: [{ id: '001', status: 'complete' }] },
    fail: { tasks: [{ id: '001', status: 'in_progress' }] },
    failReason: 'all-tasks-complete not satisfied: 1 task(s) incomplete',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'overhaul-review',
    to: 'overhaul-update-docs',
    guardId: 'all-reviews-passed',
    pass: { reviews: { quality: { status: 'approved' } } },
    fail: {},
    failReason:
      'state.reviews is missing — set reviews.{name} with status: "pass" or "approved"',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'overhaul-review',
    to: 'overhaul-delegate',
    guardId: 'any-review-failed',
    pass: { reviews: { quality: { status: 'needs_fixes' } } },
    fail: {},
    failReason: 'state.reviews is missing — cannot determine if any review failed',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'overhaul-update-docs',
    to: 'synthesize',
    guardId: 'docs-updated',
    pass: { validation: { docsUpdated: true } },
    fail: { validation: { docsUpdated: false } },
    failReason: 'docs-updated not satisfied',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'synthesize',
    to: 'overhaul-delegate',
    guardId: 'synthesize-retryable',
    pass: { synthesis: { lastError: 'push failed', retryCount: 0 } },
    fail: {},
    failReason: 'synthesize-retryable not satisfied: no lastError recorded',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'synthesize',
    to: 'completed',
    guardId: 'pr-url-exists',
    pass: { synthesis: { prUrl: 'https://example.test/pr/3' } },
    fail: {},
    failReason: 'pr-url-exists not satisfied: synthesis.prUrl or artifacts.pr must be set',
  }),
];

const bypassCases: readonly LegacyTransitionFixture[] = [
  {
    id: 'bypass-empty-task-collection-is-complete',
    workflowType: 'feature',
    from: 'delegate',
    to: 'review',
    scenario: 'bypass',
    state: { tasks: [], _events: [] },
    expected: allow('delegate', 'review'),
  },
  {
    id: 'bypass-always-pass-implementation-ignores-fail-shaped-state',
    workflowType: 'debug',
    from: 'debug-implement',
    to: 'debug-validate',
    scenario: 'bypass',
    state: { implementation: { complete: false } },
    expected: allow('debug-implement', 'debug-validate'),
  },
  {
    id: 'bypass-patched-plan-approval-is-authoritative',
    workflowType: 'feature',
    from: 'plan-review',
    to: 'delegate',
    scenario: 'bypass',
    state: { planReview: { approved: true }, _events: [] },
    expected: allow('plan-review', 'delegate'),
  },
  {
    id: 'bypass-patched-review-status-is-authoritative',
    workflowType: 'feature',
    from: 'review',
    to: 'synthesize',
    scenario: 'bypass',
    state: { reviews: { patched: { status: 'approved' } }, _events: [] },
    expected: allow('review', 'synthesize'),
  },
  {
    id: 'bypass-unknown-risk-does-not-block-plan-edge',
    workflowType: 'feature',
    from: 'plan',
    to: 'plan-review',
    scenario: 'bypass',
    state: { riskTier: 'unknown', artifacts: { plan: 'docs/specs/feature.md' } },
    expected: allow('plan', 'plan-review'),
  },
  {
    id: 'bypass-stale-gate-event-is-not-consulted',
    workflowType: 'debug',
    from: 'debug-validate',
    to: 'debug-review',
    scenario: 'bypass',
    state: {
      validation: { testsPass: true },
      _events: [
        {
          type: 'gate.executed',
          timestamp: '2000-01-01T00:00:00.000Z',
          data: { gate: 'tests', passed: false },
        },
      ],
    },
    expected: allow('debug-validate', 'debug-review'),
  },
];

export const legacyTransitionCorpus: readonly LegacyTransitionFixture[] = Object.freeze([
  ...featureCases,
  ...debugCases,
  ...refactorCases,
  ...oneshotCases,
  ...discoveryCases,
  ...bypassCases,
]);

// ─── Config-bearing fixtures (the inputs the frozen corpus cannot reach) ───────
//
// The frozen corpus above is generated from DEFAULT / no-config fixtures ONLY.
// That is precisely the input region where the legacy guards and the shared
// admission IR CANNOT disagree about a configured threshold — the guards fall
// back to the same constants the IR hardcoded. Asserting "admission never
// over-admits" over that corpus asserts a safety property on a set where it
// cannot fail.
//
// These fixtures carry the injected config/tier state the legacy guards actually
// read at runtime (`workflow/tools.ts` writes them onto the state before the
// pure guards run):
//
//   `_maxPlanRevisions`   — `.exarchos.yml workflow.maxPlanRevisions`
//   `_requiredReviews`    — the resolved required review dimensions
//   `_mutationEnforcement` / `_mutationThreshold` / `_maxNoCoverage`
//                         — HIGH-tier mutation-adequacy enforcement
//   `oneshot.synthesisPolicy` + `synthesize.requested` events
//                         — the oneshot direct-commit / synthesize branch
//
// plus the value SHAPES the `oneshot-plan-set` guard rejects but a naive
// presence probe admits (`true`, `'   '`, an object).
//
// Every `expected` verdict here is machine-attested against the real guard path
// by `admission/corpus-legacy-baseline.test.ts` — none is hand-transcribed and
// left unverified.

const configCase = (
  id: string,
  workflowType: BuiltInWorkflowType,
  from: string,
  to: string,
  state: Readonly<Record<string, unknown>>,
  verdict: 'allow' | 'deny',
  explanation: string,
): LegacyTransitionFixture => ({
  id,
  workflowType,
  from,
  to,
  scenario: 'config-bearing',
  state,
  expected: { verdict, explanation },
});

/** DEFECT 1(a) — `revisions-exhausted` reads the injected cap, not a constant. */
const planRevisionCapCases: readonly LegacyTransitionFixture[] = [
  configCase(
    'config-max-plan-revisions-3-count-1-denies-blocked',
    'feature',
    'plan-review',
    'blocked',
    { planReview: { revisionCount: 1 }, _maxPlanRevisions: 3 },
    'deny',
    "Guard 'revisions-exhausted' failed: revisions-exhausted not satisfied: 1/3 revisions",
  ),
  configCase(
    'config-max-plan-revisions-3-count-3-allows-blocked',
    'feature',
    'plan-review',
    'blocked',
    { planReview: { revisionCount: 3 }, _maxPlanRevisions: 3 },
    'allow',
    'Legacy HSM admitted plan-review -> blocked at the configured cap',
  ),
  configCase(
    // Discriminating case: under the DEFAULT cap of 1 a count of 0 DENIES, so an
    // admission engine that ignored the injected cap would deny here.
    'config-max-plan-revisions-0-count-0-allows-blocked',
    'feature',
    'plan-review',
    'blocked',
    { planReview: { revisionCount: 0 }, _maxPlanRevisions: 0 },
    'allow',
    'Legacy HSM admitted plan-review -> blocked (cap 0 is immediately exhausted)',
  ),
  configCase(
    'config-refactor-max-plan-revisions-3-count-1-denies-blocked',
    'refactor',
    'overhaul-plan-review',
    'blocked',
    { planReview: { revisionCount: 1 }, _maxPlanRevisions: 3 },
    'deny',
    "Guard 'revisions-exhausted' failed: revisions-exhausted not satisfied: 1/3 revisions",
  ),
];

/** DEFECT 1(b) — `all-reviews-passed` also enforces required dimensions. */
const requiredReviewCases: readonly LegacyTransitionFixture[] = [
  configCase(
    'config-required-reviews-missing-dimension-denies-synthesize',
    'feature',
    'review',
    'synthesize',
    {
      reviews: { quality: { status: 'approved' } },
      _requiredReviews: ['quality', 'security'],
    },
    'deny',
    "Guard 'all-reviews-passed' failed: Missing required review dimensions: security",
  ),
  configCase(
    'config-required-reviews-present-but-empty-entry-denies-synthesize',
    'feature',
    'review',
    'synthesize',
    {
      reviews: { quality: { status: 'approved' }, security: {} },
      _requiredReviews: ['quality', 'security'],
    },
    'deny',
    "Guard 'all-reviews-passed' failed: a present-but-statusless entry is not a review",
  ),
  configCase(
    'config-required-reviews-all-present-allows-synthesize',
    'feature',
    'review',
    'synthesize',
    {
      reviews: { quality: { status: 'approved' }, security: { status: 'pass' } },
      _requiredReviews: ['quality', 'security'],
    },
    'allow',
    'Legacy HSM admitted review -> synthesize with every required dimension present',
  ),
  configCase(
    'config-refactor-required-reviews-missing-dimension-denies-docs',
    'refactor',
    'overhaul-review',
    'overhaul-update-docs',
    {
      reviews: { quality: { status: 'approved' } },
      _requiredReviews: ['quality', 'security'],
    },
    'deny',
    "Guard 'all-reviews-passed' failed: Missing required review dimensions: security",
  ),
];

/** DEFECT 1(b) — HIGH-tier mutation-adequacy enforcement (score + NoCoverage). */
const mutationEnforcementCases: readonly LegacyTransitionFixture[] = [
  configCase(
    'config-high-tier-mutation-score-below-threshold-denies-synthesize',
    'feature',
    'review',
    'synthesize',
    {
      riskTier: 'high',
      reviews: {
        quality: { status: 'pass' },
        'mutation-adequacy': { status: 'pass', mutationScore: 42, noCoverage: 0 },
      },
      _mutationEnforcement: 'block',
      _mutationThreshold: 80,
      _maxNoCoverage: 0,
    },
    'deny',
    "Guard 'all-reviews-passed' failed: mutation-adequacy score 42 is below the enforced threshold 80",
  ),
  configCase(
    'config-high-tier-mutation-score-above-threshold-allows-synthesize',
    'feature',
    'review',
    'synthesize',
    {
      riskTier: 'high',
      reviews: {
        quality: { status: 'pass' },
        'mutation-adequacy': { status: 'pass', mutationScore: 95, noCoverage: 0 },
      },
      _mutationEnforcement: 'block',
      _mutationThreshold: 80,
      _maxNoCoverage: 0,
    },
    'allow',
    'Legacy HSM admitted review -> synthesize with the mutation score above threshold',
  ),
  configCase(
    'config-high-tier-mutation-nocoverage-over-budget-denies-synthesize',
    'feature',
    'review',
    'synthesize',
    {
      riskTier: 'high',
      reviews: {
        quality: { status: 'pass' },
        'mutation-adequacy': { status: 'pass', mutationScore: 95, noCoverage: 7 },
      },
      _mutationEnforcement: 'block',
      _maxNoCoverage: 2,
    },
    'deny',
    "Guard 'all-reviews-passed' failed: 7 uncovered (NoCoverage) mutant(s) exceed the enforced budget of 2",
  ),
  configCase(
    'config-high-tier-mutation-degraded-fails-closed-denies-synthesize',
    'feature',
    'review',
    'synthesize',
    {
      riskTier: 'high',
      reviews: {
        quality: { status: 'pass' },
        'mutation-adequacy': { status: 'pass', degraded: true },
      },
      _mutationEnforcement: 'block',
      _mutationThreshold: 80,
    },
    'deny',
    "Guard 'all-reviews-passed' failed: mutation-adequacy gate degraded — no verifiable score",
  ),
  configCase(
    // Advisory is the DEFAULT posture: the same failing score must NOT block.
    'config-advisory-mutation-below-threshold-allows-synthesize',
    'feature',
    'review',
    'synthesize',
    {
      reviews: {
        quality: { status: 'pass' },
        'mutation-adequacy': { status: 'pass', mutationScore: 42, noCoverage: 7 },
      },
      _mutationEnforcement: 'advisory',
      _mutationThreshold: 80,
      _maxNoCoverage: 2,
    },
    'allow',
    'Legacy HSM admitted review -> synthesize (mutation enforcement is advisory)',
  ),
];

/** DEFECT 1(c) — `oneshot-plan-set` demands a TRIMMED NON-EMPTY STRING. */
const oneshotPlanShapeCases: readonly LegacyTransitionFixture[] = [
  configCase(
    'config-oneshot-plan-boolean-true-denies-implementing',
    'oneshot',
    'plan',
    'implementing',
    { artifacts: { plan: true } },
    'deny',
    "Guard 'oneshot-plan-set' failed: non-string values (true, objects, numbers) are not accepted",
  ),
  configCase(
    'config-oneshot-plan-whitespace-only-denies-implementing',
    'oneshot',
    'plan',
    'implementing',
    { artifacts: { plan: '   ' } },
    'deny',
    "Guard 'oneshot-plan-set' failed: a whitespace-only plan carries no content",
  ),
  configCase(
    'config-oneshot-plan-object-denies-implementing',
    'oneshot',
    'plan',
    'implementing',
    { artifacts: { plan: { path: 'docs/plan.md' } } },
    'deny',
    "Guard 'oneshot-plan-set' failed: non-string values (true, objects, numbers) are not accepted",
  ),
  configCase(
    'config-oneshot-plan-padded-string-allows-implementing',
    'oneshot',
    'plan',
    'implementing',
    { artifacts: { plan: '  docs/plan.md  ' } },
    'allow',
    'Legacy HSM admitted plan -> implementing (a padded but non-blank plan string)',
  ),
];

/**
 * DEFECT 2 — the oneshot DEFAULT `on-request` policy. `readSynthesisPolicy`
 * defaults a MISSING policy to `'on-request'`, under which `synthesisOptedOut`
 * admits the direct-commit edge whenever no `synthesize.requested` event exists.
 * Both outbound edges of `implementing` are covered here, so a shadow authority
 * that denies BOTH (a liveness deadlock) is detectable rather than invisible.
 */
const oneshotSynthesisPolicyCases: readonly LegacyTransitionFixture[] = [
  configCase(
    'config-oneshot-default-on-request-no-event-allows-direct-commit',
    'oneshot',
    'implementing',
    'completed',
    { _events: [] },
    'allow',
    'Legacy HSM admitted implementing -> completed (default on-request, no synthesize request)',
  ),
  configCase(
    'config-oneshot-default-on-request-no-event-denies-synthesize',
    'oneshot',
    'implementing',
    'synthesize',
    { _events: [] },
    'deny',
    "Guard 'synthesis-opted-in' failed: on-request policy with no synthesize.requested event",
  ),
  configCase(
    'config-oneshot-on-request-with-event-allows-synthesize',
    'oneshot',
    'implementing',
    'synthesize',
    {
      oneshot: { synthesisPolicy: 'on-request' },
      _events: [{ type: 'synthesize.requested' }],
    },
    'allow',
    'Legacy HSM admitted implementing -> synthesize (on-request opted in by event)',
  ),
  configCase(
    'config-oneshot-on-request-with-event-denies-direct-commit',
    'oneshot',
    'implementing',
    'completed',
    {
      oneshot: { synthesisPolicy: 'on-request' },
      _events: [{ type: 'synthesize.requested' }],
    },
    'deny',
    "Guard 'synthesis-opted-out' failed: a synthesize.requested event opted into synthesis",
  ),
  configCase(
    // `never` is an ABSOLUTE opt-out: a stray synthesize.requested event must not
    // re-open the synthesize branch.
    'config-oneshot-never-policy-with-request-event-denies-synthesize',
    'oneshot',
    'implementing',
    'synthesize',
    {
      oneshot: { synthesisPolicy: 'never' },
      _events: [{ type: 'synthesize.requested' }],
    },
    'deny',
    "Guard 'synthesis-opted-in' failed: synthesisPolicy=never (direct-commit path)",
  ),
  configCase(
    'config-oneshot-unrecognized-policy-defaults-on-request-allows-direct-commit',
    'oneshot',
    'implementing',
    'completed',
    { oneshot: { synthesisPolicy: 'sometimes' }, _events: [] },
    'allow',
    'Legacy HSM admitted implementing -> completed (unrecognized policy collapses to on-request)',
  ),
];

/**
 * Fixtures carrying real injected config / tier state. Kept SEPARATE from the
 * frozen {@link legacyTransitionCorpus} so the frozen baseline's per-edge
 * pass/fail invariant (asserted by `guard-classification.test.ts` and
 * `hsm-transition-guard.test.ts`) is untouched.
 */
export const configBearingCorpus: readonly LegacyTransitionFixture[] = Object.freeze([
  ...planRevisionCapCases,
  ...requiredReviewCases,
  ...mutationEnforcementCases,
  ...oneshotPlanShapeCases,
  ...oneshotSynthesisPolicyCases,
]);

/**
 * The FULL differential corpus the shadow admission authority is measured
 * against: the frozen default-input baseline PLUS the config-bearing inputs on
 * which a dual-authority drift can actually manifest.
 */
export const transitionAdmissionCorpus: readonly LegacyTransitionFixture[] =
  Object.freeze([...legacyTransitionCorpus, ...configBearingCorpus]);
