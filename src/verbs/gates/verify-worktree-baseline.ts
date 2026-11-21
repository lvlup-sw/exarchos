/**
 * Baseline check for a worktree. It resolves the test command through `resolveTestRuntime`, runs it in the verifier, and returns a markdown report.
 * A provisioned verifier runs the test command under a checkout subject with no stream. No route runs it locally.
 * A machine with no verifier refuses with VERIFIER_NOT_PROVISIONED after the path check, and starts no process.
 */

import { existsSync } from 'node:fs';
import { gitCommonDirOf } from '../../utils/paths.js';
import type { ToolResult } from '../../format.js';
import {
  packageManagerProjectType,
  resolveTestRuntime,
  type ResolvedRuntime,
} from '../../config/test-runtime-resolver.js';
import { BUILTIN_TOOLCHAINS } from '../../config/toolchains.js';
import { splitCommand } from '../../config/tokenize-command.js';
import type { VerificationHostConnector } from '../../contract/verification/harness-verification.js';
import { HostedAdequacyPending, admitLifecycleLegs, hostedPendingResult, hostedRefusal, verifierNotProvisioned } from './gate-runner.js';

interface VerifyWorktreeBaselineArgs {
  readonly worktreePath: string;
  /**
   * A request for leak detection against the tip of this branch. Leak detection needs clean-tree evidence of the harness.
   * A provisioned verifier refuses it, and no route inspects the tree.
   */
  readonly agentBranch?: string;
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
 * Run the baseline test command in the verifier. The single execution rests on the host claim of the deterministic request key.
 * A refusal and a pending result keep distinct codes. A run with no verdict is pending and never reads as a failed baseline.
 */
async function hostedBaselineRun(
  connector: VerificationHostConnector, worktreePath: string, detection: ProjectDetection,
): Promise<{ readonly passed: boolean; readonly output: string; readonly exitCode: number } | ToolResult> {
  let legs: Awaited<ReturnType<typeof admitLifecycleLegs>>;
  try {
    legs = await admitLifecycleLegs({ connector, checkout: worktreePath, legs: [{ kind: 'command', argv: [detection.cmd, ...detection.args] }] });
  } catch (error) {
    return hostedPendingResult(error);
  }
  if ('success' in legs) return legs;
  const run = legs[0]?.run;
  if (run?.exitCode === undefined || run.exitCode === null) return hostedPendingResult(new HostedAdequacyPending('The verifier returned no baseline test leg.'));
  return { passed: run.exitCode === 0, exitCode: run.exitCode, output: [run.stdout, run.stderr].filter(Boolean).join('\n') };
}

/**
 * Run the baseline. A connector comes only from the dispatch context. With no connector, the handler refuses after the path check.
 *
 * NOT_GIT_WORKTREE comes from the process-free climb of `gitCommonDirOf`, so a subdirectory of a checkout is a Git worktree. A difference from git refuses.
 * The handler refuses leak detection, because leak detection needs clean-tree evidence of the harness. The test command runs only in the verifier.
 */
export async function handleVerifyWorktreeBaseline(
  args: VerifyWorktreeBaselineArgs,
  _stateDir: string,
  connector?: VerificationHostConnector,
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

  if (connector === undefined) return verifierNotProvisioned('verify_worktree_baseline');

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

  if (agentBranch) {
    return hostedRefusal('A provisioned verifier refuses baseline leak detection, because it needs clean-tree evidence of the harness. No local route inspects the tree.');
  }
  const hosted = await hostedBaselineRun(connector, worktreePath, detection);
  if ('success' in hosted) return hosted;
  const report = formatReport(worktreePath, projectType, testCommand, hosted.passed, hosted.output, hosted.exitCode);
  return { success: true, data: { passed: hosted.passed, projectType, testCommand, report } };
}
