/**
 * Baseline check for a worktree. It resolves the test command through `resolveTestRuntime`, runs it, and returns a markdown report.
 * The local approved-check executor runs the test command as a lifecycle check with no stream, read-only in the worktree.
 * When the caller supplies `agentBranch`, the check also classifies each uncommitted change as a merge-time leak or as dirt.
 * Leak detection reads only the closed Git listings and hashes each working file in this process.
 */

import { existsSync } from 'node:fs';
import { gitCommonDirOf } from '../../utils/paths.js';
import { processObservationalGitPath } from '../../utils/git-tree.js';
import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import {
  packageManagerProjectType,
  resolveTestRuntime,
  type ResolvedRuntime,
} from '../../config/test-runtime-resolver.js';
import { BUILTIN_TOOLCHAINS } from '../../config/toolchains.js';
import { splitCommand } from '../../config/tokenize-command.js';
import { HostedAdequacyPending, closedListingBlobs, closedListingChanges, hostedPendingResult } from './gate-runner.js';
import { observeCurrentCheckout } from './gate-utils.js';
import { admitLifecycleLegs } from '../verification/lifecycle-check.js';
import type { CheckExecutor } from '../verification/check-executor.js';

interface VerifyWorktreeBaselineArgs {
  readonly worktreePath: string;
  /**
   * When supplied, the handler classifies each uncommitted change in `worktreePath` against the tip of this branch.
   * A tracked file whose working blob equals the committed blob on the branch is a recoverable `leaked-committed` leak.
   * Its entry names a `git checkout -- <path>` remediation. When absent, the handler skips leak inspection.
   */
  readonly agentBranch?: string;
}

/**
 * At merge time, the main worktree can carry an uncommitted change that is byte-identical to a commit on the agent branch tip.
 * Such a path blocks a fast-forward merge, but it is safe to discard.
 * The leak check classifies each dirty path, so the orchestrator can show the `git checkout -- <path>` remediation.
 */
type LeakClassification = 'leaked-committed' | 'dirty';

interface LeakPathEntry {
  readonly path: string;
  readonly classification: LeakClassification;
  /** Safe remediation command, present only for recoverable leaks. */
  readonly remediation?: string;
}

/** The leak classification of one worktree. `unread` names the cause when the closed listings cannot classify the tree, which counts as dirty. */
interface LeakDetection {
  readonly dirty: boolean;
  readonly paths: readonly LeakPathEntry[];
  readonly unread?: string;
}

/**
 * Project type label. The test command of a package-manager profile or of a toolchain row of the registry takes the `projectType` of that profile or row.
 * Any other command gets a label that names its source.
 */
type ProjectType = string;

interface ProjectDetection {
  readonly projectType: ProjectType;
  readonly testCommand: string;
  readonly cmd: string;
  readonly args: readonly string[];
}

/** The marker files of the built-in toolchains, in priority order. The refusal of a worktree with no test command names them. */
const REGISTRY_MARKERS: readonly string[] = BUILTIN_TOOLCHAINS.flatMap((toolchain) => toolchain.markers);

/**
 * Maps a resolver test command to the `projectType` of its package-manager profile, else of its toolchain row.
 * A command of no profile and no row gives `undefined`.
 */
function projectTypeFromTestCommand(test: string): ProjectType | undefined {
  return (
    packageManagerProjectType(test) ??
    BUILTIN_TOOLCHAINS.find((toolchain) => toolchain.commands.test === test)?.projectType
  );
}

/**
 * Accepts a test command from any resolver source, because a `.exarchos.yml` or override command is as authoritative as a detected one.
 * It returns `undefined` for no test command, an empty command, or a command where `splitCommand` throws on an unterminated quote.
 * A command of no profile and no row, such as `make test`, gets a label that names its source.
 */
function toProjectDetection(runtime: ResolvedRuntime): ProjectDetection | undefined {
  if (runtime.test === null) return undefined;
  let cmd: string;
  let args: readonly string[];
  try {
    ({ cmd, args } = splitCommand(runtime.test));
  } catch {
    return undefined;
  }
  if (cmd === '') return undefined;
  const projectType =
    projectTypeFromTestCommand(runtime.test) ??
    (runtime.source === 'config' ? 'Configured (.exarchos.yml)' : 'Override');
  return { projectType, testCommand: runtime.test, cmd, args };
}

function detectProjectType(worktreePath: string): ProjectDetection | undefined {
  const runtime = resolveTestRuntime(worktreePath);
  return toProjectDetection(runtime);
}

/**
 * Single-quote a path for safe inclusion in a copy-paste shell remediation.
 * A crafted filename with spaces or shell metacharacters must not turn a suggested `git checkout` into unintended execution.
 */
function shellQuotePath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** The leak detection of a tree that the closed listings cannot classify. It counts as dirty. */
function unreadLeaks(unread: string): LeakDetection {
  return { dirty: true, paths: [], unread };
}

/**
 * Classifies each uncommitted path in the worktree against the agent branch tip, with the closed listings only.
 * A tracked path with a working blob equal to the branch blob is a recoverable `leaked-committed` leak.
 * Every other path is `dirty` and must still block the merge. The function reads Git state and changes nothing.
 */
async function detectLeakedEdits(worktreePath: string, agentBranch: string): Promise<LeakDetection> {
  const gitPath = processObservationalGitPath();
  if (gitPath === undefined) return unreadLeaks('No usable Git executable reads the worktree.');
  const observed = await observeCurrentCheckout(gitPath, worktreePath);
  if (observed.kind === 'refused') return unreadLeaks(observed.reason);
  const { observer, checkout } = observed;
  const changes = await closedListingChanges(observer.reads, checkout.gitDir, checkout.checkout, checkout.head);
  if (changes === undefined) return unreadLeaks('The closed Git listings cannot classify the worktree tree.');
  if (changes.length === 0) return { dirty: false, paths: [] };
  const branch = await observer.base(checkout, agentBranch);
  if (branch.kind === 'refused') return unreadLeaks(`The agent branch does not resolve: ${branch.reason}`);
  const blobs = await closedListingBlobs(observer.reads, checkout.gitDir, checkout.checkout, branch.value);
  if (blobs === undefined) return unreadLeaks('The closed Git listing of the agent branch tip cannot be read.');
  const paths = changes.map((change): LeakPathEntry => change.tracked && change.workingBlob !== undefined && blobs.get(change.path) === change.workingBlob
    ? { path: change.path, classification: 'leaked-committed', remediation: `git checkout -- ${shellQuotePath(change.path)}` }
    : { path: change.path, classification: 'dirty' });
  return { dirty: true, paths };
}

function formatReport(
  worktreePath: string,
  projectType: string,
  testCommand: string,
  passed: boolean,
  output: string,
  exitCode: number,
): string {
  const lines: string[] = [
    '## Baseline Verification Report',
    '',
    `**Worktree:** \`${worktreePath}\``,
    `**Project type detected:** ${projectType}`,
    `**Test command:** \`${testCommand}\``,
    '',
    '### Test Output',
    '',
    '```',
    output,
    '```',
    '',
    '---',
    '',
  ];

  if (passed) {
    lines.push('**Result: PASS** — baseline tests succeeded');
  } else {
    lines.push(`**Result: FAIL** — baseline tests failed (exit code ${exitCode})`);
  }

  return lines.join('\n');
}

/**
 * Run the baseline test command in the local executor, read-only in the worktree. A retry of the same operation replays the stored run.
 * A refusal and a pending result keep distinct codes. A run with no verdict is pending and never reads as a failed baseline.
 */
async function localBaselineRun(
  eventStore: EventStore, worktreePath: string, detection: ProjectDetection, executor: CheckExecutor | undefined,
): Promise<{ readonly passed: boolean; readonly output: string; readonly exitCode: number } | ToolResult> {
  let legs: Awaited<ReturnType<typeof admitLifecycleLegs>>;
  try {
    legs = await admitLifecycleLegs({ eventStore, checkout: worktreePath, legs: [{ kind: 'command', argv: [detection.cmd, ...detection.args] }],
      ...(executor === undefined ? {} : { executor }) });
  } catch (error) {
    return hostedPendingResult(error);
  }
  if ('success' in legs) return legs;
  const run = legs[0]?.run;
  if (run?.exitCode === undefined || run.exitCode === null) return hostedPendingResult(new HostedAdequacyPending('The executor returned no baseline test leg.'));
  return { passed: run.exitCode === 0, exitCode: run.exitCode, output: [run.stdout, run.stderr].filter(Boolean).join('\n') };
}

/**
 * Run the baseline in the local executor, with no verifier provisioning.
 *
 * NOT_GIT_WORKTREE comes from the process-free climb of `gitCommonDirOf`, so a subdirectory of a checkout is a Git worktree. A difference from git refuses.
 * Leak detection comes before the test run. The executor needs a clean tree, so a dirty worktree refuses the run, and the refusal carries the leak detection.
 *
 * @param executor - The local check executor. The default is the real executor. A test passes its own executor.
 */
export async function handleVerifyWorktreeBaseline(
  args: VerifyWorktreeBaselineArgs,
  _stateDir: string,
  eventStore: EventStore,
  executor?: CheckExecutor,
): Promise<ToolResult> {
  const { worktreePath, agentBranch } = args;

  if (!worktreePath || !existsSync(worktreePath)) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Worktree path does not exist: ${worktreePath ?? '(empty)'}`,
      },
    };
  }

  try {
    gitCommonDirOf(worktreePath);
  } catch {
    return {
      success: false,
      error: {
        code: 'NOT_GIT_WORKTREE',
        message: `Not a git worktree: ${worktreePath}`,
      },
    };
  }

  const detection = detectProjectType(worktreePath);
  if (!detection) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_PROJECT_TYPE',
        message: `No recognized project files found in ${worktreePath} (${REGISTRY_MARKERS.join(', ')}). Manual verification required.`,
      },
    };
  }

  const { projectType, testCommand } = detection;

  const leakDetection = agentBranch ? await detectLeakedEdits(worktreePath, agentBranch) : undefined;
  const leaks = leakDetection === undefined ? {} : { leakDetection };
  const local = await localBaselineRun(eventStore, worktreePath, detection, executor);
  if ('success' in local) return leakDetection === undefined ? local : { ...local, data: leaks };
  const report = formatReport(worktreePath, projectType, testCommand, local.passed, local.output, local.exitCode);
  return { success: true, data: { passed: local.passed, projectType, testCommand, report, ...leaks } };
}
