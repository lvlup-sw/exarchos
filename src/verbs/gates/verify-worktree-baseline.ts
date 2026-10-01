/**
 * Baseline check for a worktree. It resolves the test command through `resolveTestRuntime`, runs it, and returns a markdown report.
 * When the caller supplies `agentBranch`, it also classifies each uncommitted change as a merge-time leak or as dirt.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runCommandSync } from '../../utils/process.js';
import type { ToolResult } from '../../format.js';
import { resolveTestRuntime, type ResolvedRuntime } from '../../config/test-runtime-resolver.js';
import { splitCommand } from '../../config/tokenize-command.js';

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
 * The check uses only local git inspection.
 */
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

type DetectedProjectType =
  | 'Node.js'
  | 'Node.js (bun)'
  | 'Node.js (pnpm)'
  | 'Node.js (yarn)'
  | '.NET'
  | 'Rust'
  | 'Python';

/**
 * Project type label. A built-in test command maps to a `DetectedProjectType`.
 * Any other command gets a label that names its source.
 */
type ProjectType = DetectedProjectType | 'Configured (.exarchos.yml)' | 'Override';

interface ProjectDetection {
  readonly projectType: ProjectType;
  readonly testCommand: string;
  readonly cmd: string;
  readonly args: readonly string[];
}

/** Maps a resolver test command to a project-type label, or to `undefined` for a command outside the built-in set. */
function projectTypeFromTestCommand(test: string): DetectedProjectType | undefined {
  if (test === 'npm run test:run') return 'Node.js';
  if (test === 'bun test') return 'Node.js (bun)';
  if (test === 'pnpm test') return 'Node.js (pnpm)';
  if (test === 'yarn test') return 'Node.js (yarn)';
  if (test === 'dotnet test') return '.NET';
  if (test === 'cargo test') return 'Rust';
  if (test === 'pytest') return 'Python';
  return undefined;
}

/**
 * Accepts a test command from any resolver source, because a `.exarchos.yml` or override command is as authoritative as a detected one.
 * It returns `undefined` for no test command, an empty command, or a command where `splitCommand` throws on an unterminated quote.
 * A command with no built-in label, such as `make test`, gets a label that names its source.
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
 * Parses `git status --porcelain` output into paths, each with a `tracked` flag.
 * Each v1 line holds two status columns, then the path.
 * For a rename or copy (`R` or `C`), the line holds `old -> new`, and the function keeps `new`, because `git hash-object` needs the path on disk.
 * An untracked (`??`) entry gets `tracked: false`, so the caller reports it as dirt with no blob comparison.
 */
function parsePorcelainPaths(porcelain: string): { path: string; tracked: boolean }[] {
  const entries: { path: string; tracked: boolean }[] = [];
  for (const rawLine of porcelain.split('\n')) {
    if (rawLine.trim() === '') continue;
    const xy = rawLine.slice(0, 2);
    let path = rawLine.slice(2).trim();
    if (path === '') continue;
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
 * True when the working blob at `path` is byte-identical to the blob at the same path on `agentBranch`.
 * Git addresses blobs by hash, so equal hashes mean equal bytes. The function returns `false` when either side does not resolve.
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
 * Single-quote a path for safe inclusion in a copy-paste shell remediation.
 * A crafted filename with spaces or shell metacharacters must not turn a
 * suggested `git checkout` into unintended execution.
 */
function shellQuotePath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Classifies each uncommitted path in the worktree against the agent branch tip.
 * A tracked path with a working blob equal to the branch blob is a recoverable `leaked-committed` leak.
 * Every other path is `dirty` and must still block the merge. The function reads git state and changes nothing.
 */
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

export async function handleVerifyWorktreeBaseline(
  args: VerifyWorktreeBaselineArgs,
  _stateDir: string,
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

  const detection = detectProjectType(worktreePath);
  if (!detection) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_PROJECT_TYPE',
        message: `No recognized project files found in ${worktreePath} (package.json, *.csproj, Cargo.toml, pyproject.toml). Manual verification required.`,
      },
    };
  }

  const { projectType, testCommand, cmd, args: cmdArgs } = detection;

  const leakDetection: LeakDetection | undefined = agentBranch
    ? detectLeakedEdits(worktreePath, agentBranch)
    : undefined;

  let passed = true;
  let output = '';
  let exitCode = 0;

  try {
    output = runCommandSync(cmd, cmdArgs as string[], {
      encoding: 'utf-8',
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as string;
  } catch (err: unknown) {
    const execError = err as { status?: number; stdout?: string; stderr?: string };
    passed = false;
    exitCode = execError.status ?? 1;
    output = [execError.stdout ?? '', execError.stderr ?? ''].filter(Boolean).join('\n');
  }

  const report = formatReport(worktreePath, projectType, testCommand, passed, output, exitCode);

  return {
    success: true,
    data: { passed, projectType, testCommand, report, ...(leakDetection ? { leakDetection } : {}) },
  };
}
