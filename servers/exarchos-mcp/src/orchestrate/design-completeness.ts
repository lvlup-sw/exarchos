// ─── Design Completeness Composite Action ───────────────────────────────────
//
// Orchestrates design document completeness checks at the ideate→plan boundary.
// Wraps scripts/verify-ideate-artifacts.sh and emits gate.executed events for
// IdeateReadinessView and CodeQualityView flywheel integration.
//
// This gate is ADVISORY — failures inform but do not block phase transitions.
// ────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import type { ToolResult } from '../format.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';

// ─── Result Types ───────────────────────────────────────────────────────────

interface DesignCompletenessResult {
  readonly passed: boolean;
  readonly advisory: boolean;
  readonly findings: string[];
  readonly checkCount: number;
  readonly passCount: number;
  readonly failCount: number;
}

// ─── Output Parsing ─────────────────────────────────────────────────────────

function parseScriptOutput(output: string): DesignCompletenessResult {
  const lines = output.split('\n');

  // Extract FAIL findings
  const findings = lines
    .filter((line) => line.includes('**FAIL**'))
    .map((line) => line.replace(/^-\s*\*\*FAIL\*\*:\s*/, '').trim());

  // Parse summary line: "**Result: PASS** (4/4 checks passed)" or "**Result: FAIL** (2/4 checks failed)"
  const summaryLine = lines.find((line) => line.startsWith('**Result:'));
  let checkCount = 0;
  let passCount = 0;
  let failCount = 0;
  let passed = false;

  if (summaryLine) {
    passed = summaryLine.includes('PASS');
    const countMatch = summaryLine.match(/\((\d+)\/(\d+)\s+checks/);
    if (countMatch) {
      const numerator = parseInt(countMatch[1], 10);
      checkCount = parseInt(countMatch[2], 10);
      if (passed) {
        passCount = numerator;
        failCount = checkCount - passCount;
      } else {
        failCount = numerator;
        passCount = checkCount - failCount;
      }
    }
  }

  return {
    passed,
    advisory: true,
    findings,
    checkCount,
    passCount,
    failCount,
  };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleDesignCompleteness(
  args: { featureId: string; stateFile?: string; designPath?: string },
  stateDir: string,
): Promise<ToolResult> {
  // 1. Validate input
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  const streamId = args.featureId;

  // 2. Build script command
  const scriptPath = path.resolve(stateDir, '..', '..', 'scripts', 'verify-ideate-artifacts.sh');
  const stateFile = args.stateFile ?? path.join(stateDir, `${streamId}.json`);

  const scriptArgs = ['--state-file', stateFile];
  if (args.designPath) {
    scriptArgs.push('--design-file', args.designPath);
  }

  // 3. Run the script
  let output: string;

  try {
    const result = execFileSync(
      scriptPath,
      scriptArgs,
      { encoding: 'buffer', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    output = result.toString('utf-8');
  } catch (err: unknown) {
    const execError = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    const stdout = execError.stdout instanceof Buffer ? execError.stdout.toString('utf-8') : '';
    const stderr = execError.stderr instanceof Buffer ? execError.stderr.toString('utf-8') : '';

    // Timeout or spawn errors have no status — propagate as handler failure
    if (execError.status == null) {
      return {
        success: false,
        error: {
          code: 'SCRIPT_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // Exit code 2 = usage error — propagate as handler failure
    if (execError.status === 2) {
      return {
        success: false,
        error: {
          code: 'DESIGN_COMPLETENESS_FAILED',
          message: stderr || 'Script usage error (exit code 2)',
        },
      };
    }

    // Exit code 1 = checks failed (expected advisory failure)
    output = stdout;
  }

  // 4. Parse output
  const parsed = parseScriptOutput(output);

  // 5. Emit gate.executed event
  try {
    const store = getOrCreateEventStore(stateDir);
    await emitGateEvent(store, streamId, 'design-completeness', 'design', parsed.passed, {
      dimension: 'D1',
      phase: 'ideate',
      advisory: true,
      findings: parsed.findings,
      checkCount: parsed.checkCount,
      passCount: parsed.passCount,
      failCount: parsed.failCount,
    });
  } catch {
    // Fire-and-forget: event emission failure must not break the gate check
  }

  // 6. Return result
  return {
    success: true,
    data: parsed,
  };
}
