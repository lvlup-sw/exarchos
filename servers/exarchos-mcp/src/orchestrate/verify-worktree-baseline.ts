// ─── Verify Worktree Baseline Orchestrate Action ────────────────────────────
//
// Validates a worktree path, auto-detects project type (Node.js, .NET, Rust),
// runs the appropriate test command, and returns a structured markdown report.
// Ported from scripts/verify-worktree-baseline.sh.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface VerifyWorktreeBaselineArgs {
  readonly worktreePath: string;
}

type ProjectType = 'Node.js' | '.NET' | 'Rust';

interface ProjectDetection {
  readonly projectType: ProjectType;
  readonly testCommand: string;
  readonly cmd: string;
  readonly args: readonly string[];
}

// ─── Project Detection ──────────────────────────────────────────────────────

export function detectProjectType(worktreePath: string): ProjectDetection | undefined {
  if (existsSync(`${worktreePath}/package.json`)) {
    return {
      projectType: 'Node.js',
      testCommand: 'npm run test:run',
      cmd: 'npm',
      args: ['run', 'test:run'],
    };
  }

  // Check for *.csproj files
  try {
    const entries = readdirSync(worktreePath);
    if (entries.some((e) => String(e).endsWith('.csproj'))) {
      return {
        projectType: '.NET',
        testCommand: 'dotnet test',
        cmd: 'dotnet',
        args: ['test'],
      };
    }
  } catch {
    // readdirSync failure — fall through
  }

  if (existsSync(`${worktreePath}/Cargo.toml`)) {
    return {
      projectType: 'Rust',
      testCommand: 'cargo test',
      cmd: 'cargo',
      args: ['test'],
    };
  }

  return undefined;
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

  // 3. Detect project type
  const detection = detectProjectType(worktreePath);
  if (!detection) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_PROJECT_TYPE',
        message: `No recognized project files found in ${worktreePath} (package.json, *.csproj, Cargo.toml). Manual verification required.`,
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
