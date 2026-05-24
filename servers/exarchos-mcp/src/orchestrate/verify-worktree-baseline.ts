// ─── Verify Worktree Baseline Orchestrate Action ────────────────────────────
//
// Validates a worktree path, delegates project-type/test-command resolution to
// the unified test runtime resolver (`config/test-runtime-resolver.ts`), runs
// the resolved test command, and returns a structured markdown report.
// Ported from scripts/verify-worktree-baseline.sh; migrated to resolver in
// refactor #1199 T08, intentionally closing the prior Python detection gap.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import { resolveTestRuntime, type ResolvedRuntime } from '../config/test-runtime-resolver.js';
import { splitCommand } from '../config/tokenize-command.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface VerifyWorktreeBaselineArgs {
  readonly worktreePath: string;
  /**
   * T-08 (#1301): when supplied, the handler inspects the (main) worktree for
   * uncommitted modifications and classifies each against this agent branch
   * tip. A working-tree blob byte-identical to the same path already committed
   * on the agent branch is flagged as a recoverable `leaked-committed` leak
   * (the #1301 mirroring symptom) — distinct from unrelated local dirt — and a
   * safe `git checkout -- <path>` remediation is surfaced. Omitting this arg
   * skips leak inspection entirely (back-compat for non-merge callers).
   */
  readonly agentBranch?: string;
}

// ─── T-08 (#1301): Leak Detection ─────────────────────────────────────────────
//
// At merge time the orchestrator's MAIN worktree sometimes carries an
// uncommitted modification that is byte-identical to a change already
// committed on the agent branch tip (issue #1301 "working-tree mirroring
// leak"). Such a path FF-blocks the merge but is in fact safe to discard. This
// backstop classifies each dirty path so the orchestrator can surface the
// documented `git checkout -- <path>` remediation instead of treating the leak
// as opaque dirt. INV-15: this is purely local git inspection — no
// cross-process locking, no distributed primitives.

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
 * Project type label. Detection paths use the narrow `DetectedProjectType`
 * union; config/override paths fall back to a source-tagged label when the
 * test command isn't in the built-in set.
 */
type ProjectType = DetectedProjectType | 'Configured (.exarchos.yml)' | 'Override';

interface ProjectDetection {
  readonly projectType: ProjectType;
  readonly testCommand: string;
  readonly cmd: string;
  readonly args: readonly string[];
}

// ─── Project Detection (delegates to resolver) ──────────────────────────────

/**
 * Map a resolver test-command string to a human-readable project-type label.
 * Discriminates the widened `ProjectType` union from the resolver's
 * package-manager-aware test command.
 */
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

function toProjectDetection(runtime: ResolvedRuntime): ProjectDetection | undefined {
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
  // For config/override sources we may not have a built-in label for the test
  // command (e.g., `make test`). Fall back to a source-tagged label so the
  // report is still informative.
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
    const path = rawLine.slice(2).trim();
    if (path === '') continue;
    const tracked = !xy.includes('?');
    entries.push({ path, tracked });
  }
  return entries;
}

/**
 * Blob-comparison helper (T-08 REFACTOR): is the working-tree content at
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
        remediation: `git checkout -- ${path}`,
      };
    }
    return { path, classification: 'dirty' as const };
  });

  return { dirty: paths.length > 0, paths };
}

// ─── Report Formatting ──────────────────────────────────────────────────────

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
        message: `No recognized project files found in ${worktreePath} (package.json, *.csproj, Cargo.toml, pyproject.toml). Manual verification required.`,
      },
    };
  }

  const { projectType, testCommand, cmd, args: cmdArgs } = detection;

  // 3b. T-08 (#1301): merge-time leak backstop. Only runs when the caller
  // supplies the agent branch tip to compare against — non-merge callers keep
  // the prior pure-baseline behavior.
  const leakDetection: LeakDetection | undefined = agentBranch
    ? detectLeakedEdits(worktreePath, agentBranch)
    : undefined;

  // 4. Run test command
  let passed = true;
  let output = '';
  let exitCode = 0;

  try {
    output = execFileSync(cmd, cmdArgs as string[], {
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

  // 5. Build report and return
  const report = formatReport(worktreePath, projectType, testCommand, passed, output, exitCode);

  return {
    success: true,
    data: { passed, projectType, testCommand, report, ...(leakDetection ? { leakDetection } : {}) },
  };
}
