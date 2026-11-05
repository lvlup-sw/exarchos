/**
 * The `check_mock_boundary` orchestrate action. It runs the mock-boundary gate on the diff of a
 * task and persists subject-bound evidence. The pure core `mock-boundary.ts` does the detection.
 * This handler resolves the repo root and parses the `baseRef...HEAD` diff. It reads the test globs and the
 * `firstParty` globs of the verification profile, resolves the gate severity, and persists the evidence.
 *
 * The result is an advisory carrier: `success: true`, with `data.passed` as the verdict. An
 * unowned mock is a finding, not a tool error.
 *
 * A non-empty `reason` acknowledges an intentional unowned mock. The gate then passes at each
 * severity, and the evidence records the acknowledgement. The findings stay in the result.
 *
 * The gate never guesses a base. A run with no `baseBranch` gives the advisory finding `base-missing`.
 * That run passes, and it is not a skip.
 */

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import {
  defaultGitExec,
  profileOf,
  profilePathOf,
  resolvePolicySkip,
  SKIPPED_BY_POLICY,
  withProfileRoute,
  type ProfiledGateArgs,
} from './gate-utils.js';
import { runGatePreflight } from '../pure/gate-preflight.js';
import { runDurableGateProducer } from './durable-gate-producer.js';
import type { RiskTier } from '../../workflow/verification-policy.js';
import { resolveGateSeverity } from './gate-severity.js';
import { DEFAULTS, resolveConfig, type ResolvedProjectConfig } from '../../config/resolve.js';
import { DEFAULT_FIRST_PARTY_GLOBS } from '../../config/exarchos-config-schema.js';
import { loadExarchosConfigOutcome, type ExarchosConfigOutcome } from '../../config/load-exarchos-config.js';
import { PROFILE_UNRESOLVED, type VerificationProfile } from '../../workflow/verification/profile.js';
import type { GitExec } from '../pure/execute-merge.js';
import {
  detectMockFindings,
  type FileDiff,
  type AddedLine,
  type MockFinding,
} from './mock-boundary.js';
import {
  classifyHermeticDependency,
  resolveHermeticDouble,
} from '../../config/toolchains.js';

/**
 * Builds the next-action steer for an unowned mock. The steer names what to do, not only what is
 * wrong. A dependency in a known class gets its concrete hermetic double, with its fidelity,
 * cadence, and caveat. An unclassified dependency gets the generic menu.
 */
export function steerForFinding(finding: MockFinding): string {
  const depClass = classifyHermeticDependency(finding.mockedTarget);
  if (depClass !== null) {
    const d = resolveHermeticDouble(depClass);
    return (
      `replace the mock of \`${finding.mockedTarget}\` (${depClass}) with ` +
      `${d.double} [fidelity: ${d.fidelity}; cadence: ${d.cadence}]` +
      (d.caveat ? ` — ${d.caveat}` : '') +
      ` — mocking an unowned dependency asserts against a fiction (the mock ` +
      `cannot be checked against the real contract)`
    );
  }
  return (
    `replace the mock of \`${finding.mockedTarget}\` with a hermetic fixture / ` +
    `contract-verified stub / a fake — mocking an unowned dependency asserts ` +
    `against a fiction (the mock cannot be checked against the real contract)`
  );
}

export interface MockBoundaryHandlerArgs extends ProfiledGateArgs {
  readonly featureId: string;
  readonly taskId: string;
  /** The task branch (HEAD side of the diff). Defaults to the current branch. */
  readonly branch?: string;
  /**
   * The base ref that the branch forked from, which is the merge-base target. It has no default.
   * Without it, the gate reports the advisory finding `base-missing` and does not block.
   */
  readonly baseBranch?: string;
  /**
   * Repo to check. The handler uses a literal path as is. `'auto'` resolves the agent worktree of
   * the calling delegation. Without a value, the handler uses `process.cwd()`.
   */
  readonly repoRoot?: string;
  /** Explicit agent worktree path — preferred resolver seam for 'auto'. */
  readonly worktreePath?: string;
  /** Legacy field. Evidence idempotency uses only the trusted DispatchContext. */
  readonly operationId?: string;
  /**
   * Escape hatch: a reason that acknowledges an intentional unowned mock. When it is non-empty,
   * the gate passes at each severity and durable evidence records the acknowledgement.
   */
  readonly reason?: string;
  /**
   * The stamped risk tier of the task. With {@link boundaryTouching} also present, the handler
   * skips itself when the resolved verification sequence omits this gate. Without both stamps,
   * the gate runs.
   */
  readonly riskTier?: RiskTier;
  /** The task's stamped boundary-touching flag. See {@link riskTier}. */
  readonly boundaryTouching?: boolean;
  /**
   * The resolved project config from the dispatch adapter. The self-skip routing thus uses the
   * same policy sequence as the delegation stamp. Without it, the resolver uses the built-in
   * table. In a segment it is the config of the checkout, and it also gives the severity.
   * {@link loadConfig} is separate and reads the per-worktree terms and severity of a direct call.
   */
  readonly projectConfig?: ResolvedProjectConfig;
  /** Test seam. Defaults to `defaultGitExec`. */
  readonly gitExec?: GitExec;
  /** Config reader of a direct call, for the profile and the review-gate severity. Defaults to `loadExarchosConfigOutcome`. */
  readonly loadConfig?: (worktreePath: string) => ExarchosConfigOutcome;
}

/** The discriminant of a run that names no base. */
const BASE_MISSING = 'base-missing';

/** The report of a run that names no base. */
const BASE_MISSING_REPORT =
  'check_mock_boundary did not scan: no base was supplied (`baseBranch`), so the new test hunks have nothing to be measured from. ' +
  'Pass the branch that the task forked from. The task-completion runbook binds it from the capsule `baseRef`.';

/** What one run reads: the profile, the config of the severity, and the error of a config that does not load. */
interface MockBoundaryReading {
  /** Absent for a config that does not load. The run then keeps the fallback of the seeded globs. */
  readonly profile?: VerificationProfile;
  readonly severityConfig: ResolvedProjectConfig;
  readonly configLoadError?: string;
}

/**
 * Reads the terms of one run. A pinned profile comes with the config of the checkout that the capsule pins, so a segment reads no worktree config.
 * A direct call reads the config once through `args.loadConfig`, and it resolves the profile with that read.
 * A config that does not load gives no profile, so the caller keeps the fallback and reads no unresolved term.
 */
function readTerms(args: MockBoundaryHandlerArgs, repoRoot: string): MockBoundaryReading {
  if (args.verificationProfile !== undefined) {
    return { profile: args.verificationProfile.profile, severityConfig: args.projectConfig ?? DEFAULTS };
  }
  const outcome = (args.loadConfig ?? loadExarchosConfigOutcome)(repoRoot);
  if (outcome.kind === 'invalid') return { severityConfig: DEFAULTS, configLoadError: outcome.message };
  const profile = profileOf(args, repoRoot, { loadConfig: () => outcome });
  if (outcome.kind === 'absent') return { profile, severityConfig: DEFAULTS };
  try {
    return { profile, severityConfig: resolveConfig(outcome.result.config) };
  } catch (err) {
    return { profile, severityConfig: DEFAULTS, configLoadError: err instanceof Error ? err.message : String(err) };
  }
}

/** The advisory skip of a term that the profile does not resolve. The gate is advisory, so the skip does not block. */
function unresolvedTermSkip(args: MockBoundaryHandlerArgs, repoRoot: string, termReason: string): ToolResult {
  const reason = `${profilePathOf(args, repoRoot)}. ${withProfileRoute(args, termReason)}`;
  return {
    success: true,
    data: { passed: true, skipped: true, findings: [], report: reason, discriminant: PROFILE_UNRESOLVED, reason },
  };
}

const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses a unified `git diff baseRef...HEAD` into {@link FileDiff} entries, one per changed file.
 * Each entry holds only the added lines, with their post-image line numbers. A mock that the diff
 * deletes is thus never flagged.
 *
 * The post-image cursor starts at each hunk header and advances on added and context lines. For a
 * rename, the entry uses the `b/` path.
 */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let currentPath: string | undefined;
  let currentAdded: AddedLine[] = [];
  let newLine = 0;

  const flush = (): void => {
    if (currentPath !== undefined) {
      files.push({ path: currentPath, addedLines: currentAdded });
    }
  };

  for (const raw of diff.split('\n')) {
    const fileMatch = raw.match(DIFF_GIT_RE);
    if (fileMatch) {
      flush();
      currentPath = fileMatch[2];
      currentAdded = [];
      newLine = 0;
      continue;
    }
    if (currentPath === undefined) {
      continue;
    }
    const hunkMatch = raw.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      newLine = Number.parseInt(hunkMatch[1] ?? '0', 10);
      continue;
    }
    if (raw.startsWith('+')) {
      if (raw.startsWith('+++')) continue;
      currentAdded.push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      if (raw.startsWith('---')) continue;
      continue;
    }
    if (raw.startsWith('\\')) {
      continue;
    }
    if (newLine > 0) newLine += 1;
  }
  flush();
  return files;
}

/**
 * Runs the mock-boundary gate for one task.
 *
 * The profile is the pinned profile, or the profile that resolves at the repo root. `profilePath` names which.
 * An unresolved glob term or `firstParty` term gives an advisory skip with `profile-unresolved`.
 *
 * A missing or malformed `.exarchos.yml` falls back to the default globs and severity, and never
 * fails the gate. A malformed file, or a file whose review settings do not resolve, also sets `configLoadError`.
 *
 * The diff uses `--no-ext-diff`, because a `diff.external` wrapper replaces the unified diff and gives zero findings. A git failure gives zero findings.
 *
 * The gate fails only when the severity is blocking, an unowned mock exists, and no `reason` is given.
 * The built-in severity is `warning`, so only a project override makes the gate block.
 * Steers appear only when findings exist and no `reason` is given.
 *
 * With no base, the gate passes after the policy skip with `base-missing` and an `indeterminate` verdict, and reads no diff.
 */
export async function handleMockBoundary(
  args: MockBoundaryHandlerArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  const pre = await runGatePreflight(
    {
      featureId: args.featureId,
      taskId: args.taskId,
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      handlerName: 'handleMockBoundary',
      requireTaskId: true,
    },
    eventStore,
  );
  if (!pre.ok) return pre.result;
  const repoRoot = pre.repoRoot;
  const baseRef = args.baseBranch && args.baseBranch.trim().length > 0 ? args.baseBranch.trim() : undefined;

  return runDurableGateProducer(
    {
      gateClass: 'mock-boundary',
      featureId: args.featureId,
      taskId: args.taskId,
      ...(args.branch ? { branch: args.branch } : {}),
      ...(baseRef ? { baseRef } : {}),
      repoRoot,
      stateDir,
      eventStore,
    },
    async () => {
      const policySkip = resolvePolicySkip({
        gateName: 'check_mock_boundary',
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
            findings: [],
            report: policySkip.reason,
            discriminant: SKIPPED_BY_POLICY,
          },
        };
      }

      if (baseRef === undefined) {
        return {
          success: true,
          data: {
            passed: true,
            verdict: 'indeterminate',
            findings: [],
            report: BASE_MISSING_REPORT,
            discriminant: BASE_MISSING,
          },
        };
      }

      const gitExec = args.gitExec ?? defaultGitExec;
      const { profile, severityConfig, configLoadError } = readTerms(args, repoRoot);
      const globTerm = profile?.tests.globs;
      if (globTerm?.state === 'unresolved') return unresolvedTermSkip(args, repoRoot, globTerm.reason);
      const firstPartyTerm = profile?.firstParty;
      if (firstPartyTerm?.state === 'unresolved') return unresolvedTermSkip(args, repoRoot, firstPartyTerm.reason);

      const severity = resolveGateSeverity('mock-boundary', 'D1', severityConfig);

      const diffResult = gitExec(repoRoot, ['diff', '--no-ext-diff', `${baseRef}...HEAD`]);
      const fileDiffs = diffResult.exitCode === 0 ? parseUnifiedDiff(diffResult.stdout) : [];
      const findings = detectMockFindings(fileDiffs, {
        firstPartyGlobs: firstPartyTerm?.globs ?? DEFAULT_FIRST_PARTY_GLOBS,
        ...(globTerm === undefined ? {} : { testGlobs: globTerm.globs }),
      });

      const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
      const escapeHatch = reason.length > 0 ? { acknowledged: true, reason } : undefined;

      const hasFindings = findings.length > 0;
      const passed = !hasFindings || escapeHatch !== undefined || severity !== 'blocking';

      const nextActions =
        hasFindings && escapeHatch === undefined ? findings.map(steerForFinding) : [];

      return {
        success: true,
        data: {
          passed,
          findings,
          severity,
          profilePath: profilePathOf(args, repoRoot),
          ...(escapeHatch ? { escapeHatch } : {}),
          ...(nextActions.length > 0 ? { next_actions: nextActions } : {}),
          ...(configLoadError === undefined ? {} : { configLoadError }),
        },
      };
    },
  );
}
