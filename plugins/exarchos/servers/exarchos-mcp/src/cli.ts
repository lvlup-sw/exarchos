#!/usr/bin/env node

// ─── CLI Entry Point for Claude Code Hooks ──────────────────────────────────
//
// All hook scripts call: node dist/cli.js <command>
// JSON is piped via stdin, JSON result is written to stdout.

import { handlePreCompact } from './cli-commands/pre-compact.js';
import { resolveStateDir } from './workflow/state-store.js';

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
] as const;

type KnownCommand = (typeof KNOWN_COMMANDS)[number];

function isKnownCommand(command: string): command is KnownCommand {
  return (KNOWN_COMMANDS as readonly string[]).includes(command);
}

// ─── Stub Handlers ──────────────────────────────────────────────────────────

function createStubHandler(command: string): CommandHandler {
  return async (_stdinData: Record<string, unknown>): Promise<CommandResult> => ({
    error: {
      code: 'NOT_IMPLEMENTED',
      message: `${command} handler not yet implemented`,
    },
  });
}

const commandHandlers: Record<KnownCommand, CommandHandler> = {
  'pre-compact': async (stdinData) => handlePreCompact(stdinData, resolveStateDir()),
  'session-start': createStubHandler('session-start'),
  'guard': createStubHandler('guard'),
  'task-gate': createStubHandler('task-gate'),
  'teammate-gate': createStubHandler('teammate-gate'),
  'subagent-context': createStubHandler('subagent-context'),
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
    process.exitCode = 1;
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
