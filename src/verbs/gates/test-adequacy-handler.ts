/**
 * The `check_test_adequacy` handler. It runs the kill probe (mutation testing at N=1) over the diff of a task and persists subject-bound evidence.
 * `test-adequacy.ts` holds the probe itself. This handler wires the production seams.
 *
 * It resolves `repoRoot`, with the worktree-aware `auto` mode. It reads the diff and its base through the constrained Git reader.
 * A segment diffs the two exact commits of its coordinate. A direct call diffs from the merge base of the caller base and the observed head.
 * It reads the test terms of the verification profile: the pinned profile of a segment, else the profile that resolves live at `repoRoot`.
 *
 * The local executor runs the probe command in two disposable copies: the exact head, and the head with the task sources at the base.
 * The live checkout and its Git state never change.
 *
 * Evidence persistence is idempotent on the trusted operation id.
 * The result is an advisory carrier: `success: true`, with `data.passed` set from the probe verdict. A failed probe is a finding, not a tool error.
 */

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import {
  observeCurrentCheckout,
  profileOf,
  profilePathOf,
  resolvePolicySkip,
  SKIPPED_BY_POLICY,
  WHOLE_SUITE_TIMEOUT_MS,
  withProfileRoute,
  type ClosedGateVerdict,
  type GateAdvisorySkip,
  type GateCarrierVerdict,
  type ProfiledGateArgs,
} from './gate-utils.js';
import { runGatePreflight } from '../pure/gate-preflight.js';
import { runDurableGateProducer } from './durable-gate-producer.js';
import { probeArgv } from '../../config/verification-profile.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import type { RiskTier } from '../../workflow/verification-policy.js';
import type { VerificationProfile } from '../../workflow/verification/profile.js';
import type { CheckPlan } from '../../contract/verification/harness-verification.js';
import {
  runProbe,
  selectAdequacyPaths,
  probeNotRun,
  interpretProbeVerdict,
  verdictOf,
  type AdequacyDiscriminant,
  type AdequacyDisposition,
  type ProbeResult,
  type RunOutcome,
} from './test-adequacy.js';
import { assertNever } from '../../contract/error-families.js';
import { contentDigest } from '../../contract/capsule/capsule-digest.js';
import { CapsuleBaseRefSchema } from '../../contract/capsule/exarchos-capsule.js';
import { processObservationalGitPath } from '../../utils/git-tree.js';
import {
  pendingOfDirectCall, refusedCheckResult, runApprovedCheck, type CheckExecutor, type LegObservation,
} from '../verification/check-executor.js';

/** The probe term of the verification profile. */
type ProbeTerm = VerificationProfile['tests']['probe'];

export interface TestAdequacyArgs extends ProfiledGateArgs {
  readonly featureId: string;
  readonly taskId: string;
  /** The task branch (HEAD side of the diff). When it is present, it must be the branch of the checkout. */
  readonly branch?: string;
  /**
   * The branch that the task forked from. The diff starts at the merge base of this ref and the task head.
   * There is no default, because a guessed base judges other work. Without a base, the gate blocks with `base-missing`.
   */
  readonly baseBranch?: string;
  /**
   * The repo to probe. A literal path is used as given. `'auto'` resolves the agent worktree of the calling delegation.
   * When absent, the handler uses `process.cwd()`.
   */
  readonly repoRoot?: string;
  /** Explicit agent worktree path — preferred resolver seam for 'auto'. */
  readonly worktreePath?: string;
  /**
   * Legacy compatibility field. Evidence idempotency is bound exclusively to
   * the trusted DispatchContext operationId.
   */
  readonly operationId?: string;

  /**
   * Legacy phase carrier retained for public input compatibility. Evidence is
   * attributed to the active persisted phaseAttemptId.
   */
  readonly phase?: string;

  /**
   * The task's stamped risk tier. When provided together with
   * {@link boundaryTouching}, the handler self-skips when the resolved
   * verification sequence does not include this gate (`skipped-by-policy`).
   * Absent (legacy callers) → the gate runs unconditionally.
   */
  readonly riskTier?: RiskTier;
  /** The task's stamped boundary-touching flag. See {@link riskTier}. */
  readonly boundaryTouching?: boolean;
  /**
   * The resolved project config. The dispatch adapter passes it, so the self-skip reads the same policy as the delegation stamp.
   * A `verification:` cell in `.exarchos.yml` that excludes this gate makes the stamp drop it and this handler skip it.
   * When absent, the resolver uses the built-in table.
   */
  readonly projectConfig?: ResolvedProjectConfig;
}

/** The time limit of one scoped test run of the probe. */
const SCOPED_TEST_TIMEOUT_MS = 120_000;

/**
 * The time limit of one run in the file form `form`: the given limit, else the limit of the form.
 * The `none` form runs a whole suite, so it takes the limit of a whole suite.
 *
 * @internal Exported so that a test can read the limit of each form without a run.
 */
export function runTimeoutOf(form: ProbeTerm['files'], timeoutMs?: number): number {
  return timeoutMs ?? (form === 'none' ? WHOLE_SUITE_TIMEOUT_MS : SCOPED_TEST_TIMEOUT_MS);
}

/** Writes a list of exit codes as text, such as `1` or `1 or 101`. */
function exitCodeList(codes: readonly number[]): string {
  return codes.join(' or ');
}

/**
 * The run outcome of one probe leg of the local executor. Exit 0 is green, and a test-failure exit code of the toolchain is red.
 * Each other end of the leg gives no verdict, with its cause.
 */
export function probeRunOutcome(run: LegObservation, redCodes: readonly number[]): Exclude<RunOutcome, { kind: 'unresolved' }> {
  const output = { stdout: run.stdout, stderr: run.stderr };
  switch (run.end) {
    case 'exited':
      if (run.exitCode === 0) return { kind: 'ran', result: 'green', ...output };
      if (run.exitCode !== null && redCodes.includes(run.exitCode)) return { kind: 'ran', result: 'red', ...output };
      return { kind: 'no-verdict', cause: 'unknown-exit-code', ...output,
        detail: `the command exited ${run.exitCode ?? 'with no status'}, and only exit ${exitCodeList(redCodes)} reads as a red run` };
    case 'timeout': return { kind: 'no-verdict', cause: 'timeout', detail: 'the executor stopped the run at its time limit', ...output };
    case 'output-limit': return { kind: 'no-verdict', cause: 'overflow', detail: 'the executor stopped the run at its output limit', ...output };
    case 'unavailable': return { kind: 'no-verdict', cause: 'did-not-start', detail: run.detail ?? 'the test command did not start', ...output };
    case 'refused': return { kind: 'no-verdict', cause: 'did-not-start', detail: run.detail ?? 'the executor refused the test command', ...output };
    case 'signal': return { kind: 'no-verdict', cause: 'signal', detail: `the signal ${run.signal ?? 'SIGKILL'} stopped the run`, ...output };
  }
}

/** The reviewed typed scope of a resolved probe term for the adequacy probe: its argv and its file form. */
export function adequacyPlan(probe: ProbeTerm): CheckPlan {
  return {
    operation: 'adequacy',
    legs: probe.command.state === 'resolved' ? [{ name: 'probe', kind: 'probe', argv: [...probe.command.argv] }] : [],
    files: probe.files,
  };
}

/** The changed files, the deleted subset of them, the base of the diff and the head, or the detail of a failed read. */
export type TaskDiffRead =
  | { readonly ok: true; readonly files: string[]; readonly deletedFiles: string[]; readonly base: string; readonly head: string }
  | { readonly ok: false; readonly detail: string };

/** A status token of `git diff --no-renames --name-status`: one status letter, as no rename or copy record occurs. */
const NAME_STATUS_TOKEN = /^[ADMTUX]$/;

/**
 * Parses the NUL-separated output of `git diff -z --no-renames --name-status`. Each record is a status token and one path.
 * A record that does not parse returns null, so the caller fails closed and does not probe a partial list.
 */
function parseNameStatus(stdout: string): { files: string[]; deletedFiles: string[] } | null {
  const tokens = stdout.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  if (tokens.length % 2 !== 0) return null;
  const files: string[] = [];
  const deletedFiles: string[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const status = tokens[index] ?? '';
    const file = tokens[index + 1] ?? '';
    if (!NAME_STATUS_TOKEN.test(status) || file.length === 0) return null;
    files.push(file);
    if (status === 'D') deletedFiles.push(file);
  }
  return { files, deletedFiles };
}

/** The range of one task diff: the exact commits of a coordinate, or a caller base and an optional task branch. */
export type TaskDiffRange =
  | { readonly kind: 'coordinate'; readonly coordinate: NonNullable<ProfiledGateArgs['coordinate']> }
  | { readonly kind: 'base'; readonly baseRef: string; readonly branch?: string };

/** The full ref of a branch name. */
function branchRefOf(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
}

/**
 * Reads the task diff through the constrained reader, with no status, no checkout filter and no write.
 * A coordinate diffs its base commit and its head, and the checkout must hold that head.
 * A caller base diffs from the merge base of the base and the observed head. A named branch must be the branch of the checkout.
 * A base outside the safe ref pattern of the capsule refuses before Git sees it.
 *
 * Rename detection is off, so a renamed file is a deletion and an addition. A failed read gives `ok: false`, never an empty diff.
 */
export async function readTaskDiff(repoRoot: string, range: TaskDiffRange): Promise<TaskDiffRead> {
  const gitPath = processObservationalGitPath();
  if (gitPath === undefined) return { ok: false, detail: 'no usable Git executable reads the task diff' };
  const observed = await observeCurrentCheckout(gitPath, repoRoot);
  if (observed.kind === 'refused') return { ok: false, detail: `the checkout was not observed: ${observed.reason}` };
  const { observer, checkout } = observed;
  try {
    let base: string;
    if (range.kind === 'coordinate') {
      if (checkout.head !== range.coordinate.observedHeadCommit) return { ok: false, detail: 'the checkout does not hold the coordinate head' };
      await observer.reads.requireCommit(checkout.gitDir, checkout.checkout, range.coordinate.diffBaseCommit);
      base = range.coordinate.diffBaseCommit;
    } else {
      if (!CapsuleBaseRefSchema.safeParse(range.baseRef).success) {
        return { ok: false, detail: `the base ${JSON.stringify(range.baseRef)} is not a safe ref, so no merge base was resolved` };
      }
      if (range.branch !== undefined && branchRefOf(range.branch) !== checkout.branch) {
        return { ok: false, detail: `the branch ${JSON.stringify(range.branch)} is not the branch of the checkout ${checkout.branch}` };
      }
      const resolved = await observer.base(checkout, range.baseRef);
      if (resolved.kind === 'refused') return { ok: false, detail: `the base ${range.baseRef} was not resolved: ${resolved.reason}` };
      base = (await observer.reads.mergeBase(checkout.gitDir, checkout.checkout, resolved.value, checkout.head)).trim();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) return { ok: false, detail: `the merge base of ${range.baseRef} and the head is not a commit` };
    }
    const parsed = parseNameStatus(await observer.reads.nameStatus(checkout.gitDir, checkout.checkout, base, checkout.head));
    if (parsed === null) return { ok: false, detail: `the diff from ${base} to ${checkout.head} gave output that does not parse` };
    return { ok: true, ...parsed, base, head: checkout.head };
  } catch (error) {
    return { ok: false, detail: `the diff was not read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The probe detail when the caller names no base. */
const BASE_MISSING_DETAIL =
  'no base was supplied (`baseBranch`), so the task diff has nothing to be measured from. ' +
  'Pass the branch the task forked from: settle reads it from the capsule, and the primitive ' +
  "path takes it from prepare_delegation's `baseBranch`";

/**
 * Runs the preflight, then the kill probe inside the durable gate producer.
 * The preflight validates the dispatch context and the inputs, and resolves the worktree-aware `auto` repo root.
 * A policy skip returns a labelled advisory skip, not proof, because the ladder routed the gate out of the sequence.
 * The profile gives the test globs, the test-support segments and the probe command. An unresolved glob term or probe command blocks.
 * A blocked selection, a failed diff and an unresolved probe command start no executor.
 *
 * @param executor - The local check executor, {@link runApprovedCheck} by default. A test passes its own executor.
 */
export async function handleTestAdequacy(
  args: TestAdequacyArgs,
  stateDir: string,
  eventStore: EventStore,
  executor: CheckExecutor = runApprovedCheck,
): Promise<ToolResult> {
  const pre = await runGatePreflight(
    {
      featureId: args.featureId,
      taskId: args.taskId,
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      handlerName: 'handleTestAdequacy',
      requireTaskId: true,
    },
    eventStore,
  );
  if (!pre.ok) return pre.result;
  const repoRoot = pre.repoRoot;
  const baseBranch = args.baseBranch && args.baseBranch.trim().length > 0 ? args.baseBranch.trim() : undefined;

  try {
    return await runDurableGateProducer(
      {
        coordinate: args.coordinate,
        gateClass: 'test-adequacy',
        featureId: args.featureId,
        taskId: args.taskId,
        ...(args.branch ? { branch: args.branch } : {}),
        ...(baseBranch ? { baseRef: baseBranch } : {}),
        repoRoot,
        stateDir,
        eventStore,
      },
      async () => {
        const policySkip = resolvePolicySkip({
          gateName: 'check_test_adequacy',
          riskTier: args.riskTier,
          boundaryTouching: args.boundaryTouching,
          config: args.projectConfig,
        });
        if (policySkip) {
          return {
            success: true,
            data: {
              passed: true,
              skipped: true,
              disposition: 'advisory-skip',
              verdict: 'indeterminate',
              completeness: 'complete',
              redObserved: false,
              restoredClean: true,
              probedTests: [],
              discriminant: SKIPPED_BY_POLICY,
              reason: policySkip.reason,
            } satisfies AdequacyCarrier,
          };
        }

        if (baseBranch === undefined && args.coordinate === undefined) {
          return {
            success: true,
            data: buildAdequacyCarrier(probeNotRun('base-missing', BASE_MISSING_DETAIL, args.riskTier), args.riskTier),
          };
        }
        return runLocalProbe(args, repoRoot, eventStore, executor, baseBranch ?? '');
      },
    );
  } catch (error) {
    return pendingOfDirectCall(error, args.coordinate !== undefined);
  }
}

/**
 * Reads the task diff, selects the probe paths and runs the probe in the local executor.
 * The executor binds the request, then runs the probe leg in the head image and, after a green run, in the reverted image.
 * A refusal of the executor is a failed carrier, which the producer records with no verdict.
 */
async function runLocalProbe(
  args: TestAdequacyArgs, repoRoot: string, eventStore: EventStore, executor: CheckExecutor, baseBranch: string,
): Promise<ToolResult> {
  const profile = profileOf(args, repoRoot);
  const { tests } = profile;
  const diff = await readTaskDiff(repoRoot, args.coordinate === undefined
    ? { kind: 'base', baseRef: baseBranch, ...(args.branch ? { branch: args.branch } : {}) }
    : { kind: 'coordinate', coordinate: args.coordinate });
  const selectionArgs = {
    changedFiles: diff.ok ? diff.files : [],
    ...(diff.ok ? { deletedFiles: diff.deletedFiles } : { diffFailed: true }),
    ...(args.riskTier ? { riskTier: args.riskTier } : {}),
    terms: {
      globs: tests.globs,
      supportSegments: tests.support.segments,
      probeGlobs: tests.probe.command.state === 'resolved' ? tests.probe.globs : undefined,
      withRoute: (reason: string) => withProfileRoute(args, reason),
    },
  };
  const carrierProfile = { path: profilePathOf(args, repoRoot), unscoped: tests.probe.files === 'none' };
  const probe = tests.probe;
  const command = probe.command;
  const selected = selectAdequacyPaths(selectionArgs);
  if (!diff.ok || command.state === 'unresolved' || 'blocked' in selected || selected.testFiles.length === 0) {
    const result = await runProbe({ ...selectionArgs, runTests: async () => command.state === 'unresolved'
      ? { kind: 'unresolved', reason: command.reason }
      : { kind: 'no-verdict', cause: 'did-not-start', detail: 'the probe has no run to start' } });
    return { success: true, data: buildAdequacyCarrier(result, args.riskTier, carrierProfile) };
  }
  const ran = await executor({
    eventStore, operation: 'test-adequacy', streamId: args.featureId, taskId: args.taskId, plan: adequacyPlan(probe),
    profileDigest: contentDigest(profile), checkout: repoRoot, coordinate: args.coordinate, selection: selected.testFiles,
    workspace: 'disposable-copy', revert: { base: diff.base, sources: selected.sourceFiles }, head: diff.head,
    legTimeoutMs: runTimeoutOf(probe.files),
  }, (session) => runProbe({ ...selectionArgs, runTests: async ({ source, testFiles }) =>
    probeRunOutcome(await session.run({ leg: 0, append: probeArgv(probe.files, [], testFiles), image: source }), probe.failureExitCodes.codes) }));
  return ran.kind === 'refused' ? refusedCheckResult(ran.reason) : { success: true, data: buildAdequacyCarrier(ran.value, args.riskTier, carrierProfile) };
}

/**
 * The advisory carrier the gate returns, derived from the probe's verdict.
 * It states the closed gate verdict, so the evidence verdict does not depend on how a reader combines the other fields.
 */
export interface AdequacyCarrier extends ClosedGateVerdict {
  readonly passed: boolean;
  readonly disposition: AdequacyDisposition;
  /** The check with no verdict of a `degraded` carrier: the scoped run that the `none` form leaves out. */
  readonly advisorySkips?: readonly GateAdvisorySkip[];
  readonly redObserved: boolean;
  readonly restoredClean: boolean;
  readonly probedTests: readonly string[];
  readonly skipped?: boolean;
  readonly discriminant?: string;
  readonly report?: string;
  readonly reason?: string;
}

/**
 * The carrier verdict of a probe that blocks on an indeterminate cause.
 * A red run on the task source and a run with no verdict say nothing about the tests of the task, so they give `indeterminate`.
 * A probe that ran no test says nothing about them too, so `unprobed-test-paths` and `profile-unresolved` give `indeterminate`.
 * The other causes keep the `fail` that they gave before the carrier stated a verdict. A change of them needs a decision of the owner.
 */
const BLOCKED_CAUSE_VERDICT: Readonly<Record<AdequacyDiscriminant, GateCarrierVerdict>> = {
  'no-new-tests': 'fail',
  'diff-failed': 'fail',
  'revert-conflict': 'fail',
  'restore-failed': 'fail',
  'base-missing': 'fail',
  'baseline-red': 'indeterminate',
  'run-no-verdict': 'indeterminate',
  'unprobed-test-paths': 'indeterminate',
  'profile-unresolved': 'indeterminate',
};

/** What the carrier states about the profile of a run: the words that name its source, and whether the run took no file list. */
interface CarrierProfile {
  readonly path: string;
  readonly unscoped: boolean;
}

/** The advisory skip of a verdict that rests on a run of the whole command. */
const UNSCOPED_RUN: GateAdvisorySkip = { name: 'Scoped run', cause: 'unscoped-run' };

/**
 * Translates a {@link ProbeResult} into the advisory carrier with an exhaustive switch on the verdict union.
 * An `indeterminate` verdict (the probe cannot run) must be handled here, so it cannot arrive as a success.
 * An indeterminate verdict that degrades to an advisory skip carries `skipped: true` and the verdict `indeterminate`, so a reader can tell a skip from a pass.
 * `verdictOf` uses the stamped union, or rebuilds one fail-closed, so a legacy-shaped result is judged by the union too.
 * A new verdict variant fails the build at `assertNever`.
 *
 * The probe is one check, so a carrier states the completeness `complete`.
 * The exception is a conclusive verdict of a run with no file list. That verdict stands, and the carrier states `degraded` with the mark `unscoped-run`.
 * The report names the source of the profile. A carrier of a call that read no profile has no such words.
 */
function buildAdequacyCarrier(probe: ProbeResult, riskTier?: RiskTier, profile?: CarrierProfile): AdequacyCarrier {
  const verdict = verdictOf(probe);
  const interpretation = interpretProbeVerdict(verdict, riskTier);
  const report = [profile === undefined ? '' : `${profile.path}.`, interpretation.report ?? '']
    .filter((part) => part.length > 0)
    .join(' ');
  const unscopedVerdict = profile?.unscoped === true && verdict.kind !== 'indeterminate';

  const base = {
    passed: interpretation.passed,
    disposition: interpretation.disposition,
    completeness: unscopedVerdict ? 'degraded' : 'complete',
    ...(unscopedVerdict ? { advisorySkips: [UNSCOPED_RUN] } : {}),
    redObserved: probe.redObserved === true,
    restoredClean: probe.restoredClean !== false,
    probedTests: probe.probedTests ?? [],
    ...(report.length > 0 ? { report } : {}),
  } satisfies Omit<AdequacyCarrier, 'verdict'>;

  switch (verdict.kind) {
    case 'passed':
      return { ...base, verdict: 'pass' };
    case 'failed':
      return { ...base, verdict: 'fail' };
    case 'indeterminate':
      return {
        ...base,
        verdict: interpretation.skipped ? 'indeterminate' : BLOCKED_CAUSE_VERDICT[verdict.cause],
        discriminant: verdict.cause,
        ...(interpretation.skipped ? { skipped: true } : {}),
      };
    default:
      return assertNever(verdict, 'ProbeVerdict');
  }
}
