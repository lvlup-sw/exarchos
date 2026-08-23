// ─── Verify Worktree Baseline Orchestrate Action ────────────────────────────
//
// Validates a worktree path, delegates project-type/test-command resolution to
// the unified test runtime resolver (`config/test-runtime-resolver.ts`), runs
// the resolved test command, and returns a structured markdown report.
// Every toolchain the resolver knows is reachable here — the label and the
// marker list both come from the registry, so neither can name a shorter set
// than the detector actually uses.
//
// The baseline has THREE outcomes, not two: a runner that never started, or one
// killed at its wall clock, measured nothing and must not be recorded as a
// failing baseline.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runCommandSync } from '../../utils/process.js';
import type { ToolResult } from '../../format.js';
import { resolveTestRuntime, type ResolvedRuntime } from '../../config/test-runtime-resolver.js';
import { splitCommand } from '../../config/tokenize-command.js';
import { BUILTIN_TOOLCHAINS, detectToolchain } from '../../config/toolchains.js';
import { classifyCommandFailure, inconclusiveReason } from '../pure/command-outcome.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Wall clock the baseline run is given. Declared rather than left to the
 * platform default (there is none — `execFileSync` waits forever), because a
 * check that can stop returning is worse than one that reports it could not
 * conclude.
 */
const BASELINE_TIMEOUT_MS = 15 * 60 * 1000;

interface VerifyWorktreeBaselineArgs {
  readonly worktreePath: string;
  /**
   * #1301: when supplied, the handler inspects the (main) worktree for
   * uncommitted modifications and classifies each against this agent branch
   * tip. A working-tree blob byte-identical to the same path already committed
   * on the agent branch is flagged as a recoverable `leaked-committed` leak
   * (the #1301 mirroring symptom) — distinct from unrelated local dirt — and a
   * safe `git checkout -- <path>` remediation is surfaced. Omitting this arg
   * skips leak inspection entirely (back-compat for non-merge callers).
   */
  readonly agentBranch?: string;
}

// ─── Leak Detection (#1301) ──────────────────────────────────────────────────
//
// At merge time the orchestrator's MAIN worktree sometimes carries an
// uncommitted modification that is byte-identical to a change already
// committed on the agent branch tip (issue #1301 "working-tree mirroring
// leak"). Such a path FF-blocks the merge but is in fact safe to discard. This
// backstop classifies each dirty path so the orchestrator can surface the
// documented `git checkout -- <path>` remediation instead of treating the leak
// as opaque dirt. This is purely local git inspection — no cross-process
// locking, no distributed primitives.

type LeakClassification = 'leaked-committed' | 'dirty';

interface LeakPathEntry {
  readonly path: string;
  readonly classification: LeakClassification;
  /** Safe remediation command, present only for recoverable leaks. */
  readonly remediation?: string;
}

interface LeakDetection {
  readonly dirty: boolean;
  readonly paths: readonly LeakPathEntry[];
}

/**
 * Human-readable project-type label. Detected repositories are labelled by the
 * toolchain registry itself; config/override paths, which may name a command no
 * toolchain owns, get a source tag instead.
 */
const CONFIGURED_LABEL = 'Configured (.exarchos.yml)';
const OVERRIDE_LABEL = 'Override';

interface ProjectDetection {
  readonly projectType: string;
  readonly testCommand: string;
  readonly cmd: string;
  readonly args: readonly string[];
}

// ─── Project Detection (delegates to resolver) ──────────────────────────────

/**
 * The registry's own label for whatever toolchain this worktree is.
 *
 * Previously derived by comparing the resolved test command against a list of
 * command literals, which recognized four of the registry's toolchains and
 * silently mislabelled the rest — and went stale the moment a command string
 * changed. The registry already carries the label, so read it there: the
 * package-manager nuance the literal list encoded (`pnpm test`, `bun test`)
 * is not lost, because the report prints the resolved command on its own line.
 */
function projectTypeFromRegistry(worktreePath: string): string | undefined {
  return detectToolchain(worktreePath)?.projectType;
}

/**
 * The marker files detection actually looks for, read off the registry so the
 * "nothing recognized here" message cannot name a shorter list than the one the
 * detector uses.
 */
function recognizedMarkers(): string {
  return [...new Set(BUILTIN_TOOLCHAINS.flatMap((tc) => tc.markers))].join(', ');
}

function toProjectDetection(
  runtime: ResolvedRuntime,
  worktreePath: string,
): ProjectDetection | undefined {
  // Honor the resolver's output regardless of source (#1109 MCP-parity):
  // a `.exarchos.yml`-supplied test command is just as authoritative as one
  // produced by detection, and overrides supplied to setup-worktree should be
  // runnable too. The only blocking condition is "no test command at all".
  if (runtime.test === null) return undefined;
  // Quote-aware tokenizer (config/override commands may include quoted args
  // like `pytest -k "slow api"`). Throws on unterminated quotes — surface
  // that as an unknown project type rather than crashing the handler.
  let cmd: string;
  let args: readonly string[];
  try {
    ({ cmd, args } = splitCommand(runtime.test));
  } catch {
    return undefined;
  }
  if (cmd === '') return undefined;
  // A worktree may resolve a command with no toolchain behind it (a `make test`
  // in `.exarchos.yml`, or an override). Fall back to a source-tagged label so
  // the report is still informative.
  const projectType =
    projectTypeFromRegistry(worktreePath) ??
    (runtime.source === 'config' ? CONFIGURED_LABEL : OVERRIDE_LABEL);
  return { projectType, testCommand: runtime.test, cmd, args };
}

function detectProjectType(worktreePath: string): ProjectDetection | undefined {
  const runtime = resolveTestRuntime(worktreePath);
  return toProjectDetection(runtime, worktreePath);
}

/** Run a git command in the worktree, returning trimmed stdout or `null` on error. */
function gitCapture(worktreePath: string, args: readonly string[]): string | null {
  try {
    const out = execFileSync('git', ['-C', worktreePath, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as string;
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Parse `git status --porcelain` output into the set of tracked, modified
 * paths. We only care about content modifications to tracked files (the leak
 * symptom); untracked (`??`) and deletion entries are reported as dirt without
 * a blob comparison.
 */
function parsePorcelainPaths(porcelain: string): { path: string; tracked: boolean }[] {
  const entries: { path: string; tracked: boolean }[] = [];
  for (const rawLine of porcelain.split('\n')) {
    if (rawLine.trim() === '') continue;
    // Porcelain v1: XY<space>path  (X=index status, Y=worktree status). The
    // two status columns are fixed-width; the path begins after them and any
    // separating whitespace. Slicing the leading two columns then trimming is
    // tolerant of the single-space separator without eating path characters.
    const xy = rawLine.slice(0, 2);
    let path = rawLine.slice(2).trim();
    if (path === '') continue;
    // Porcelain v1 renders renames/copies (status R or C) as "old -> new".
    // The blob on disk lives at `new`, so `git hash-object` must resolve the
    // post-rename path — passing the raw "old -> new" string is not a real
    // file and silently fails leak detection. Only split on the rename arrow
    // for R/C entries so a literal " -> " inside an ordinary filename (git
    // would quote such names) is left intact.
    if (xy.includes('R') || xy.includes('C')) {
      const arrowIdx = path.indexOf(' -> ');
      if (arrowIdx !== -1) {
        path = path.slice(arrowIdx + 4).trim();
        if (path === '') continue;
      }
    }
    const tracked = !xy.includes('?');
    entries.push({ path, tracked });
  }
  return entries;
}

/**
 * Blob-comparison helper: is the working-tree content at
 * `path` byte-identical to the same path committed on `agentBranch`? Git
 * content-addresses blobs by SHA, so equal hashes ⇒ identical bytes. Returns
 * `false` if either side cannot be resolved (e.g. path absent on the branch).
 */
function workingBlobMatchesBranch(
  worktreePath: string,
  path: string,
  agentBranch: string,
): boolean {
  const workingHash = gitCapture(worktreePath, ['hash-object', '--', path]);
  if (workingHash === null || workingHash === '') return false;
  const branchHash = gitCapture(worktreePath, ['rev-parse', `${agentBranch}:${path}`]);
  if (branchHash === null || branchHash === '') return false;
  return workingHash === branchHash;
}

/**
 * Inspect the worktree for uncommitted modifications and classify each path
 * against the agent branch tip. A tracked path whose working-tree blob is
 * byte-identical to the agent-branch-committed blob is a recoverable
 * `leaked-committed` leak (#1301); everything else is genuine `dirty` content
 * that must still block the merge. Classification + remediation only — this
 * function never mutates the worktree.
 */
/**
 * Single-quote a path for safe inclusion in a copy-paste shell remediation.
 * A crafted filename with spaces or shell metacharacters must not turn a
 * suggested `git checkout` into unintended execution.
 */
function shellQuotePath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

function detectLeakedEdits(worktreePath: string, agentBranch: string): LeakDetection {
  const porcelain = gitCapture(worktreePath, ['status', '--porcelain']);
  if (porcelain === null || porcelain === '') {
    return { dirty: false, paths: [] };
  }

  const paths: LeakPathEntry[] = parsePorcelainPaths(porcelain).map(({ path, tracked }) => {
    if (tracked && workingBlobMatchesBranch(worktreePath, path, agentBranch)) {
      return {
        path,
        classification: 'leaked-committed' as const,
        remediation: `git checkout -- ${shellQuotePath(path)}`,
      };
    }
    return { path, classification: 'dirty' as const };
  });

  return { dirty: paths.length > 0, paths };
}

// ─── Report Formatting ──────────────────────────────────────────────────────

/**
 * What the baseline run established. `indeterminate` is not a softer `fail`:
 * a runner that never started, or one killed at its wall clock, observed
 * nothing about the worktree, and recording that as a failing baseline would
 * send a caller off to fix tests that were never executed.
 */
type BaselineStatus = 'pass' | 'fail' | 'indeterminate';

function formatReport(
  worktreePath: string,
  projectType: string,
  testCommand: string,
  status: BaselineStatus,
  output: string,
  exitCode: number,
  reason: string | undefined,
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

  if (status === 'pass') {
    lines.push('**Result: PASS** — baseline tests succeeded');
  } else if (status === 'indeterminate') {
    lines.push(
      `**Result: INDETERMINATE** — the baseline was not measured (${reason ?? 'the command did not run to completion'})`,
    );
  } else {
    lines.push(`**Result: FAIL** — baseline tests failed (exit code ${exitCode})`);
  }

  return lines.join('\n');
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleVerifyWorktreeBaseline(
  args: VerifyWorktreeBaselineArgs,
  _stateDir: string,
): Promise<ToolResult> {
  const { worktreePath, agentBranch } = args;

  // 1. Validate worktreePath exists
  if (!worktreePath || !existsSync(worktreePath)) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Worktree path does not exist: ${worktreePath ?? '(empty)'}`,
      },
    };
  }

  // 2. Verify it's a git worktree
  try {
    execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-dir'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return {
      success: false,
      error: {
        code: 'NOT_GIT_WORKTREE',
        message: `Not a git worktree: ${worktreePath}`,
      },
    };
  }

  // 3. Detect project type via the unified resolver
  const detection = detectProjectType(worktreePath);
  if (!detection) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_PROJECT_TYPE',
        message:
          `No recognized project files found in ${worktreePath} (${recognizedMarkers()}). ` +
          'Manual verification required.',
      },
    };
  }

  const { projectType, testCommand, cmd, args: cmdArgs } = detection;

  // 3b. Merge-time leak backstop (#1301). Only runs when the caller
  // supplies the agent branch tip to compare against — non-merge callers keep
  // the prior pure-baseline behavior.
  const leakDetection: LeakDetection | undefined = agentBranch
    ? detectLeakedEdits(worktreePath, agentBranch)
    : undefined;

  // 4. Run test command
  let status: BaselineStatus = 'pass';
  let output = '';
  let exitCode = 0;
  let reason: string | undefined;

  try {
    output = runCommandSync(cmd, cmdArgs as string[], {
      encoding: 'utf-8',
      cwd: worktreePath,
      timeout: BASELINE_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as string;
  } catch (err: unknown) {
    const failure = classifyCommandFailure(err);
    exitCode = failure.exitCode;
    output = [failure.stdout, failure.stderr].filter(Boolean).join('\n');
    const inconclusive = inconclusiveReason(testCommand, failure);
    if (inconclusive === null) {
      status = 'fail';
    } else {
      status = 'indeterminate';
      reason = inconclusive;
      if (output === '') output = inconclusive;
    }
  }

  // 5. Build report and return
  const report = formatReport(
    worktreePath,
    projectType,
    testCommand,
    status,
    output,
    exitCode,
    reason,
  );

  return {
    success: true,
    data: {
      // Only an observed green baseline is a pass; an unmeasured one is not.
      passed: status === 'pass',
      status,
      projectType,
      testCommand,
      report,
      ...(reason !== undefined ? { reason } : {}),
      ...(leakDetection ? { leakDetection } : {}),
    },
  };
}
