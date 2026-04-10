#!/usr/bin/env node

// ─── CLI Entry Point for Claude Code Hooks ──────────────────────────────────
//
// All hook scripts call: node dist/cli.js <command>
// JSON is piped via stdin, JSON result is written to stdout.

import { handlePreCompact } from './cli-commands/pre-compact.js';
import { handleSessionStart } from './cli-commands/session-start.js';
import { handleSessionEnd } from './cli-commands/session-end.js';
import { handleGuard } from './cli-commands/guard.js';
import { handleTaskGate, handleTeammateGate } from './cli-commands/gates.js';
import { handleSubagentContext } from './cli-commands/subagent-context.js';
import { handleSubagentStop } from './cli-commands/subagent-stop.js';
import { handleAssembleContext } from './cli-commands/assemble-context.js';
import { handleEvalRun, resolveEvalsDir } from './cli-commands/eval-run.js';
import { handleEvalCapture } from './cli-commands/eval-capture.js';
import { handleEvalCompare } from './cli-commands/eval-compare.js';
import { handleQualityCheck } from './cli-commands/quality-check.js';
import { handleCalibrate } from './cli-commands/eval-calibrate.js';
import { CalibrateInputSchema } from './evals/calibration-types.js';
import { resolveStateDir, resolveTeamsDir } from './utils/paths.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Result returned by command handlers. */
export interface CommandResult {
  readonly error?: { readonly code: string; readonly message: string };
  readonly [key: string]: unknown;
}

/** A command handler receives parsed stdin data and returns a result. */
type CommandHandler = (stdinData: Record<string, unknown>) => Promise<CommandResult>;

// ─── Known Commands ─────────────────────────────────────────────────────────

const KNOWN_COMMANDS = [
  'pre-compact',
  'session-start',
  'guard',
  'task-gate',
  'teammate-gate',
  'subagent-context',
  'assemble-context',
  'eval-run',
  'eval-capture',
  'eval-compare',
  'quality-check',
  'eval-calibrate',
  'session-end',
  'subagent-stop',
] as const;

type KnownCommand = (typeof KNOWN_COMMANDS)[number];

function isKnownCommand(command: string): command is KnownCommand {
  return (KNOWN_COMMANDS as readonly string[]).includes(command);
}

// ─── Command Handler Registry ───────────────────────────────────────────────

const commandHandlers: Record<KnownCommand, CommandHandler> = {
  'pre-compact': async (stdinData) => handlePreCompact(stdinData, resolveStateDir()),
  'session-start': async (stdinData) => handleSessionStart(stdinData, resolveStateDir(), resolveTeamsDir()),
  'guard': handleGuard,
  'task-gate': handleTaskGate,
  'teammate-gate': handleTeammateGate,
  'subagent-context': handleSubagentContext,
  'assemble-context': async (stdinData) => handleAssembleContext(stdinData, resolveStateDir()),
  'eval-run': async (stdinData) => handleEvalRun(stdinData, resolveEvalsDir()),
  'eval-capture': async (stdinData) => handleEvalCapture(stdinData, resolveStateDir()),
  'eval-compare': async (stdinData) => handleEvalCompare(stdinData, resolveStateDir()),
  'quality-check': async (stdinData) => handleQualityCheck(stdinData, resolveStateDir()),
  'eval-calibrate': async (stdinData) => {
    const parsed = CalibrateInputSchema.safeParse(stdinData);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return {
        error: {
          code: 'INVALID_INPUT',
          message: `Invalid calibrate input: ${firstIssue.path.join('.')} - ${firstIssue.message}`,
        },
      };
    }
    return handleCalibrate(parsed.data, resolveEvalsDir());
  },
  'session-end': async (stdinData) => handleSessionEnd(stdinData, resolveStateDir()),
  'subagent-stop': handleSubagentStop,
};

// ─── Stdin Parsing ──────────────────────────────────────────────────────────

/**
 * Parse a JSON string into a record. Returns an empty object for empty or
 * whitespace-only input. Throws on invalid JSON.
 */
export function parseStdinJson(input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(
      'Expected JSON object, received ' + (Array.isArray(parsed) ? 'array' : typeof parsed),
    );
  }
  return parsed as Record<string, unknown>;
}

// ─── Stdout Output ──────────────────────────────────────────────────────────

/** Write a value as JSON to stdout with a trailing newline. */
export function outputJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ─── Stdin Reader ───────────────────────────────────────────────────────────

/** Read all data from stdin into a string. Resolves immediately with '' when stdin is a TTY. */
export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

// ─── Command Router ─────────────────────────────────────────────────────────

/**
 * Route a command string to the appropriate handler. Returns the handler's
 * result, or an error object for unknown commands.
 */
export async function routeCommand(
  command: string,
  stdinData: Record<string, unknown>,
): Promise<CommandResult> {
  if (!isKnownCommand(command)) {
    return {
      error: {
        code: 'UNKNOWN_COMMAND',
        message: `Unknown command: ${command}`,
      },
    };
  }

  return commandHandlers[command](stdinData);
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Parse --plugin-root from argv if present (used by SessionStart hook)
  const pluginRootIdx = process.argv.indexOf('--plugin-root');
  if (pluginRootIdx !== -1 && process.argv[pluginRootIdx + 1]) {
    process.env.EXARCHOS_PLUGIN_ROOT = process.argv[pluginRootIdx + 1];
  }

  const command = process.argv[2];

  if (!command) {
    outputJson({
      error: {
        code: 'MISSING_COMMAND',
        message: 'Usage: cli.js <command>',
      },
    });
    process.exitCode = 1;
    return;
  }

  const rawInput = await readStdin();
  const stdinData = parseStdinJson(rawInput);
  const result = await routeCommand(command, stdinData);

  outputJson(result);

  if (result.error) {
    // Write error details to stderr so the agent (and hook runner) can see them.
    // Without this, the agent gets "No stderr output" and the task state never transitions.
    process.stderr.write(`[${result.error.code}] ${result.error.message}\n`);

    // Gate commands use exit code 2 to signal "blocked" to the hook runner
    const isGateCommand = command === 'task-gate' || command === 'teammate-gate';
    process.exitCode = isGateCommand && result.error.code === 'GATE_FAILED' ? 2 : 1;
  }
}

// Only run main when executed directly (not when imported for testing)
const isDirectExecution =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1]) ||
    import.meta.url.endsWith(process.argv[1].replace(/\.ts$/, '.js')));

if (isDirectExecution) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    outputJson({
      error: {
        code: 'FATAL',
        message,
      },
    });
    process.exitCode = 1;
  });
}
