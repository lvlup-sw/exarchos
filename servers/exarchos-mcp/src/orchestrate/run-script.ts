// ─── Run Script Orchestrate Action ─────────────────────────────────────────────
//
// Generic script runner that resolves scripts via EXARCHOS_PLUGIN_ROOT,
// validates input for path traversal, and returns structured results.
// ────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import { resolveScript } from '../utils/paths.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface RunScriptArgs {
  readonly script: string;
  readonly args?: readonly string[];
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleRunScript(
  args: RunScriptArgs,
  _stateDir: string,
): Promise<ToolResult> {
  if (!args.script) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'script is required' },
    };
  }

  // Reject path traversal and absolute paths
  if (args.script.includes('..') || args.script.startsWith('/')) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'script name must not contain path traversal or absolute paths' },
    };
  }

  const scriptPath = resolveScript(args.script);
  const scriptArgs = args.args ? [...args.args] : [];

  try {
    const output = execFileSync(scriptPath, scriptArgs, {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      success: true,
      data: { passed: true, exitCode: 0, stdout: output, stderr: '', script: args.script },
    };
  } catch (err: unknown) {
    const execError = err as { status?: number; stdout?: string; stderr?: string };
    if (execError.status != null) {
      return {
        success: true,
        data: {
          passed: false,
          exitCode: execError.status,
          stdout: execError.stdout ?? '',
          stderr: execError.stderr ?? '',
          script: args.script,
        },
      };
    }
    return {
      success: false,
      error: { code: 'SCRIPT_ERROR', message: err instanceof Error ? err.message : String(err) },
    };
  }
}
