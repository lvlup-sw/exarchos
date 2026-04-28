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

// ─── Types ──────────────────────────────────────────────────────────────────

interface VerifyWorktreeBaselineArgs {
  readonly worktreePath: string;
}

type ProjectType =
  | 'Node.js'
  | 'Node.js (bun)'
  | 'Node.js (pnpm)'
  | 'Node.js (yarn)'
  | '.NET'
  | 'Rust'
  | 'Python';

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
function projectTypeFromTestCommand(test: string): ProjectType | undefined {
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
 * Split a resolver test-command string into a `cmd` + `args` tuple suitable
 * for `execFileSync`. Whitespace-tokenized; first token is the executable.
 */
function splitTestCommand(test: string): { cmd: string; args: readonly string[] } {
  const tokens = test.split(/\s+/).filter((t) => t.length > 0);
  const [cmd, ...args] = tokens;
  return { cmd: cmd ?? '', args };
}

function toProjectDetection(runtime: ResolvedRuntime): ProjectDetection | undefined {
  if (runtime.source !== 'detection') return undefined;
  if (runtime.test === null) return undefined;
  const projectType = projectTypeFromTestCommand(runtime.test);
  if (projectType === undefined) return undefined;
  const { cmd, args } = splitTestCommand(runtime.test);
  if (cmd === '') return undefined;
  return { projectType, testCommand: runtime.test, cmd, args };
}

function detectProjectType(worktreePath: string): ProjectDetection | undefined {
  const runtime = resolveTestRuntime(worktreePath);
  return toProjectDetection(runtime);
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
  const { worktreePath } = args;

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
    data: { passed, projectType, testCommand, report },
  };
}
