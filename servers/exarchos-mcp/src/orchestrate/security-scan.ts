// ─── Security Scan Composite Action ─────────────────────────────────────────
//
// Orchestrates security scanning by running the scripts/security-scan.sh
// script and emitting gate.executed events for quality-layer gate checks.
// ────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface SecurityScanArgs {
  readonly featureId: string;
  readonly repoRoot?: string;
  readonly baseBranch?: string;
}

interface SecurityScanResult {
  readonly passed: boolean;
  readonly findingCount: number;
  readonly report: string;
}

// ─── Output Parsing ────────────────────────────────────────────────────────

function parseSecurityOutput(output: string): number {
  const findingsMatch = output.match(/Result:\s*FINDINGS\s*\((\d+)\s*security patterns detected\)/);
  if (findingsMatch) {
    return parseInt(findingsMatch[1], 10);
  }
  return 0;
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleSecurityScan(
  args: SecurityScanArgs,
  stateDir: string,
): Promise<ToolResult> {
  // Guard clause: validate required inputs
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  // Build the script command
  const repoRoot = args.repoRoot || process.cwd();
  const baseBranch = args.baseBranch || 'main';

  let stdout = '';
  let passed = false;

  try {
    const output = execFileSync(
      'scripts/security-scan.sh',
      ['--repo-root', repoRoot, '--base-branch', baseBranch],
      { timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    stdout = Buffer.isBuffer(output) ? output.toString('utf-8') : String(output);
    passed = true;
  } catch (err: unknown) {
    const execError = err as {
      status?: number;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };

    // Timeout or spawn errors have no status — treat as script error
    if (execError.status == null) {
      return {
        success: false,
        error: {
          code: 'SCRIPT_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // Exit code 2 = usage error — return as script error
    if (execError.status === 2) {
      const stderr = execError.stderr instanceof Buffer
        ? execError.stderr.toString('utf-8')
        : String(execError.stderr ?? '');
      return {
        success: false,
        error: {
          code: 'SCRIPT_ERROR',
          message: stderr || 'Script usage error',
        },
      };
    }

    // Exit code 1 = findings detected — parse the report
    stdout = execError.stdout instanceof Buffer
      ? execError.stdout.toString('utf-8')
      : String(execError.stdout ?? '');
    passed = false;
  }

  // Parse finding count from stdout
  const findingCount = parseSecurityOutput(stdout);

  // Emit gate.executed event (fire-and-forget: emission failure must not break the gate check)
  try {
    const store = getOrCreateEventStore(stateDir);
    await emitGateEvent(store, args.featureId, 'security-scan', 'quality', passed, {
      dimension: 'D1',
      phase: 'review',
      findingCount,
    });
  } catch { /* fire-and-forget */ }

  // Return structured result
  const result: SecurityScanResult = {
    passed,
    findingCount,
    report: stdout,
  };

  return { success: true, data: result };
}
