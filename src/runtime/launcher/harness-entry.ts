/**
 * The explicit harness entry. It owns the launch composition, and the governor CLI does not reach it.
 * `--identity` prints the component identity as one JSON line and opens nothing.
 * `<harness> [--feature <id>] [--dry-run] [--json]` runs crash recovery for a real launch, then the launcher verb.
 * The entry checks the harness and the flags before it opens the store or runs recovery.
 *
 * It builds its context with `detectVcs: false`, so it makes no observational Git read and does not prime a Git path.
 * Its Git starts are the launcher Git runner and the teardown origin probe.
 * The release ships it only as a compiled Bun binary, so no Node path runs this module.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command, CommanderError } from 'commander';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { StorageBackend } from '../../storage/backend.js';
import type { ToolResult } from '../../format.js';
import { logger } from '../../logger.js';
import { resolveStateDir, STORE_DB_FILENAME } from '../../utils/paths.js';
import { TIER1_HARNESSES } from './harness-registry.js';
import { LauncherVerbSchema, runLauncherVerb, renderDryRunPlan, isDryRunPlan } from './verb.js';
import {
  makeLauncherLifecycleDeps,
  recoverBeforeLaunch,
  type LauncherWiringOverrides,
} from './production-deps.js';

/** The build-time version that `tools/release/build-binary.ts` inlines. It is absent outside the compiled binary. */
declare const EXARCHOS_BUILD_VERSION: string | undefined;

/** The exit codes of the harness entry. The values are the same as the exit codes of the governor CLI. */
export const HARNESS_EXIT_CODES: Readonly<{
  SUCCESS: number;
  INVALID_INPUT: number;
  HANDLER_ERROR: number;
  UNCAUGHT_EXCEPTION: number;
}> = {
  SUCCESS: 0,
  INVALID_INPUT: 1,
  HANDLER_ERROR: 2,
  UNCAUGHT_EXCEPTION: 3,
};

/** The error code of a refused input. The launcher verb uses the same code. */
const INVALID_INPUT_CODE = 'INVALID_INPUT';

/** The name of the harness binary in help and error output. */
const HARNESS_PROGRAM_NAME = 'exarchos-harness';

/** Supplies the dispatch context. The entry calls it only after the harness and the flags pass the checks. */
export type HarnessContextProvider = () => Promise<DispatchContext>;

/** Returns the build version, or `unknown` outside the compiled binary. */
function harnessVersion(): string {
  return typeof EXARCHOS_BUILD_VERSION === 'string' && EXARCHOS_BUILD_VERSION.length > 0
    ? EXARCHOS_BUILD_VERSION
    : 'unknown';
}

/** Writes the component identity as one JSON line on stdout. */
export function writeHarnessIdentity(): void {
  process.stdout.write(
    JSON.stringify({
      component: 'harness',
      version: harnessVersion(),
      buildIdentity: Reflect.get(globalThis, '__harnessBuildIdentity__'),
    }) + '\n',
  );
}

/**
 * Writes a result. With `--json`, stdout gets the raw ToolResult as one line.
 * Without `--json`, a dry-run plan prints as text, and another success prints the one-line ToolResult on stdout.
 * A failure prints its code and message on stderr.
 */
function writeResult(result: ToolResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.success && isDryRunPlan(result.data)) {
    process.stdout.write(`${renderDryRunPlan(result.data)}\n`);
    return;
  }
  if (result.success) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stderr.write(`${result.error?.code ?? 'ERROR'}: ${result.error?.message ?? 'launch failed'}\n`);
}

/** Maps a launcher result to the exit code of the entry. */
function exitCodeOf(result: ToolResult): number {
  if (result.success) return HARNESS_EXIT_CODES.SUCCESS;
  return result.error?.code === INVALID_INPUT_CODE
    ? HARNESS_EXIT_CODES.INVALID_INPUT
    : HARNESS_EXIT_CODES.HANDLER_ERROR;
}

/**
 * Builds the Commander program of the harness entry. It has one command for each Tier-1 harness.
 * The action checks the flags first, then calls `provideContext`, then runs recovery for a real launch and the verb.
 * A thrown error maps to `UNCAUGHT_EXCEPTION`. An unknown harness has no command, so Commander refuses it before any action runs.
 */
export function buildHarnessProgram(
  provideContext: HarnessContextProvider,
  overrides: LauncherWiringOverrides = {},
): Command {
  const base = overrides.base ?? process.cwd();
  const repoRoot = overrides.repoRoot ?? base;
  const program = new Command(HARNESS_PROGRAM_NAME)
    .description('Launch a harness through the Exarchos lifecycle under harness authority')
    .version(harnessVersion());
  program.exitOverride();

  for (const harness of TIER1_HARNESSES) {
    program
      .command(harness)
      .description(
        `Launch the ${harness} harness (spawn, place, observe, teardown). Use --dry-run to preview the derived worktree path and event plan.`,
      )
      .option('--feature <id>', 'Feature id to associate with the launch worktree')
      .option('--dry-run', 'Print the derived worktree path and event plan without a worktree or a process')
      .option('--json', 'Output the raw ToolResult as one JSON line')
      .action(async (opts: Record<string, unknown>) => {
        const isJson = opts.json === true;
        const parsed = LauncherVerbSchema.safeParse({
          harness,
          feature: typeof opts.feature === 'string' ? opts.feature : undefined,
          dryRun: opts.dryRun === true,
        });
        if (!parsed.success) {
          const message = parsed.error.issues
            .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
            .join('; ');
          writeResult({ success: false, error: { code: INVALID_INPUT_CODE, message } }, isJson);
          process.exitCode = HARNESS_EXIT_CODES.INVALID_INPUT;
          return;
        }
        const { feature, dryRun } = parsed.data;

        try {
          const ctx = await provideContext();
          if (!dryRun) {
            await recoverBeforeLaunch(ctx, repoRoot, overrides);
          }
          const result = await runLauncherVerb(
            { harness, feature, dryRun },
            { base, lifecycleDeps: makeLauncherLifecycleDeps(ctx, overrides) },
          );
          writeResult(result, isJson);
          process.exitCode = exitCodeOf(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeResult({ success: false, error: { code: 'UNCAUGHT_EXCEPTION', message } }, isJson);
          process.exitCode = HARNESS_EXIT_CODES.UNCAUGHT_EXCEPTION;
        }
      });
  }

  return program;
}

/**
 * Opens the SQLite backend with the rules of the governor startup.
 * A directory with legacy `*.events.jsonl` files and no database refuses before a database file exists.
 * A failed driver load refuses. A corrupt store error passes through, and the entry never rebuilds the store.
 */
async function openHarnessBackend(stateDir: string): Promise<StorageBackend> {
  let entries: string[];
  try {
    entries = fs.readdirSync(stateDir);
  } catch {
    entries = [];
  }
  const hasLegacyJsonl = entries.some((name) => name.endsWith('.events.jsonl'));
  const hasSqliteDb = entries.some((name) => name === STORE_DB_FILENAME || name === 'events.db');
  if (hasLegacyJsonl && !hasSqliteDb) {
    throw new Error(
      `Legacy v2.10 JSONL state directory detected at ${stateDir}. ` +
        'v2.11 has removed the JSONL importer. Stay on v2.10 to use this state, or wipe the state directory to start fresh.',
    );
  }

  let driver: typeof import('../../storage/sqlite-backend.js');
  try {
    driver = await import('../../storage/sqlite-backend.js');
  } catch (importErr) {
    const reason = importErr instanceof Error ? importErr.message : String(importErr);
    throw new Error(`SQLite driver unavailable. Both drivers failed to load: ${reason}.`);
  }

  const backend = new driver.SqliteBackend(path.join(stateDir, STORE_DB_FILENAME));
  backend.initialize();
  return backend;
}

/** Closes the backend when the process exits. */
function closeBackendAtExit(backend: StorageBackend): void {
  process.on('exit', () => {
    try {
      backend.close();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to close storage backend on exit');
    }
  });
}

/**
 * The production context provider. It resolves the state directory, creates it, opens the backend
 * and builds the context with the working directory as the project root and `detectVcs: false`.
 * The project durability thus applies before the first append, and no VCS detection runs.
 */
async function openHarnessContext(): Promise<DispatchContext> {
  const stateDir = resolveStateDir();
  fs.mkdirSync(stateDir, { recursive: true });
  const backend = await openHarnessBackend(stateDir);
  closeBackendAtExit(backend);
  const { initializeContext } = await import('../../dispatch/core/context.js');
  return initializeContext(stateDir, { backend, projectRoot: process.cwd(), detectVcs: false });
}

/**
 * Runs the entry. `--identity` prints the identity and opens nothing. Every other argument list goes through the program.
 * A Commander refusal exits with `INVALID_INPUT`, and a help or version display exits 0.
 */
async function main(): Promise<void> {
  if (process.argv.length === 3 && process.argv[2] === '--identity') {
    writeHarnessIdentity();
    return;
  }
  const program = buildHarnessProgram(openHarnessContext);
  try {
    await program.parseAsync([...process.argv]);
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    process.exitCode = err.exitCode === 0 ? HARNESS_EXIT_CODES.SUCCESS : HARNESS_EXIT_CODES.INVALID_INPUT;
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(`UNCAUGHT_EXCEPTION: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = HARNESS_EXIT_CODES.UNCAUGHT_EXCEPTION;
  });
}
