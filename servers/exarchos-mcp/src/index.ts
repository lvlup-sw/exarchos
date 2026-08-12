#!/usr/bin/env node

import type { V2McpServer } from './sdk/seam.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { logger } from './logger.js';
import { resolveStateDir as resolveStateDirFromPaths, STORE_DB_FILENAME } from './utils/paths.js';
import { EventStore } from './events/store.js';
import { SnapshotStore } from './projections/views/snapshot-store.js';
import {
  ANTHROPIC_NATIVE_CACHING,
  createInMemoryResolver,
} from './capabilities/resolver.js';

// Storage backend
import type { StorageBackend } from './storage/backend.js';

// EventStore is now threaded via DispatchContext — no module-level injection needed
import { configureCleanupSnapshotStore } from './workflow/cleanup.js';
import { configureStateStoreBackend } from './workflow/state-store.js';

// New dispatch layer
import { initializeContext } from './core/context.js';
// NOTE: `createMcpServer` is intentionally NOT imported at the top level —
// task 021 made MCP SDK loading dynamic to keep CLI cold-start under the
// 250ms p95 budget. See dynamic import at `createServer()` below.
import { buildCli, runCli, resolvePackageVersion } from './adapters/cli.js';
import { isHookCommand, handleHookCommand } from './adapters/hooks.js';
import type { DispatchContext } from './core/dispatch.js';

// NOTE: `./adapters/mcp.js` and the MCP SDK are intentionally NOT imported at
// the top level. They pull the MCP SDK (~60ms module-graph load) and the full
// tool-registration closure. Since the CLI-cold-start path (DR-5 / task 021)
// must stay under the p95=250ms budget, we load them only in two places:
//   1. `createServer()` — explicitly async, used by tests + library callers.
//   2. `adapters/cli.ts`'s `mcp` command — dynamic import inside the action.
// The CLI path for `wf status`, `describe`, hooks etc. never pays that cost.

// ─── Constants ───────────────────────────────────────────────────────────────

export const SERVER_NAME = 'exarchos-mcp';
// Reconciled with root `package.json.version` — sync-versions automation
// (task 2.4) is deferred. Both this constant and the static one in
// `adapters/mcp.ts` MUST be bumped in lockstep with `package.json` and
// `.claude-plugin/plugin.json.metadata.compat.minBinaryVersion`. See
// the v2.9 release blockers in PR #1176 description.
export const SERVER_VERSION = '2.12.0-preview.3';

// ─── Mode Detection ─────────────────────────────────────────────────────────

/**
 * Detect whether this process was invoked as the long-running MCP server
 * (`exarchos mcp`) rather than a short-lived CLI command.
 *
 * F-022-2: Use a strict positional check — `mcp` is only an MCP-mode
 * invocation when it is the first positional argument (argv[2]). A looser
 * `argv.includes('mcp')` check is unsafe because feature IDs like
 * `exarchos event append -f mcp ...` or view names like `--view mcp` would
 * flip detection.
 *
 * Exported for unit testing; callers should pass `process.argv` directly.
 */
export function isMcpServerInvocation(argv: readonly string[]): boolean {
  return argv[2] === 'mcp';
}

// ─── Server Options ─────────────────────────────────────────────────────────

export interface CreateServerOptions {
  /**
   * Optional storage backend for test injection. When omitted in test
   * harnesses the backend is wired through the `createServer()` path
   * directly; the production CLI/MCP entrypoint always goes through
   * `initializeBackend()` which hard-fails if no SQLite driver is
   * available (DR-3, v2.11 substrate-cut Phase 4).
   */
  backend?: StorageBackend;
}

// ─── Backend Initialization ─────────────────────────────────────────────────

/**
 * Initialize a SqliteBackend for the given state directory.
 *
 * Post-v2.11 (substrate-cut DR-3 / Phase 4) the SQLite backend is the
 * sole event-store substrate. There is no JSONL fallback, no migration
 * importer, and no graceful degradation — the function either returns
 * an initialized `SqliteBackend` or throws.
 *
 * Failure modes:
 *   1. SQLite driver unavailable. If the SqliteBackend module fails to
 *      load (no `better-sqlite3` on Node, no `bun:sqlite` under Bun),
 *      throws an Error naming both drivers and the resolution paths.
 *      Pre-Phase-4 this branch logged a warning and returned `undefined`
 *      so callers fell through to a "JSONL-only mode" the substrate no
 *      longer supports.
 *   2. Legacy v2.10 state directory. If `stateDir` contains any
 *      `*.events.jsonl` files (the canonical v2.10 substrate marker)
 *      AND no SQLite database file, throws telling the operator they
 *      must either stay on v2.10 or wipe the state dir to start fresh
 *      on v2.11. The JSONL importer that used to handle this on first
 *      boot was removed in this phase.
 *   3. Corrupt SQLite database. `SqliteBackend.initialize()` raises
 *      `SqliteCorruptError` (SQLITE_CORRUPT / SQLITE_NOTADB). Per DR-12 /
 *      T10 corruption is non-recoverable and operator-visible by design:
 *      silent auto-rebuild would destroy the byte evidence operators
 *      need to root-cause and would mask data-loss surfaces. The error
 *      is not caught here — let it propagate so startup terminates.
 */
/**
 * Internal seam — production code lets the default loader run, tests can
 * inject a stub that simulates `bun:sqlite`/`better-sqlite3` failing to
 * resolve. Exported only so the Phase-4 hardening test can reach in;
 * not part of the supported surface.
 *
 * @internal
 */
export type SqliteBackendLoader = () => Promise<{
  SqliteBackend: typeof import('./storage/sqlite-backend.js').SqliteBackend;
}>;

const defaultSqliteBackendLoader: SqliteBackendLoader = () =>
  import('./storage/sqlite-backend.js');

export async function initializeBackend(
  stateDir: string,
  loadSqliteBackend: SqliteBackendLoader = defaultSqliteBackendLoader,
): Promise<StorageBackend> {
  // DR-11 B-5: the leaf DB name comes from the shared `STORE_DB_FILENAME`
  // constant (utils/paths.ts) — the same one `resolveStorePath` and the
  // event-store appender's lazily-constructed backend use — so the CLI/plugin
  // backend init cannot drift from the other computations of the store path.
  const dbPath = path.join(stateDir, STORE_DB_FILENAME);

  // Phase A: legacy-state-dir guard. Cheap top-level scan — do not
  // recurse. The presence of `*.events.jsonl` plus the absence of a
  // SQLite database is the unambiguous v2.10 fingerprint. Operators
  // hitting this need clear direction; silently producing a fresh
  // empty SQLite DB next to the legacy JSONL would look successful
  // but quietly orphan all of their prior workflow state.
  let stateEntries: string[];
  try {
    stateEntries = fs.readdirSync(stateDir);
  } catch {
    stateEntries = [];
  }
  const hasLegacyJsonl = stateEntries.some((name) => name.endsWith('.events.jsonl'));
  const hasSqliteDb = stateEntries.some(
    (name) => name === STORE_DB_FILENAME || name === 'events.db',
  );
  if (hasLegacyJsonl && !hasSqliteDb) {
    throw new Error(
      `Legacy v2.10 JSONL state directory detected at ${stateDir}. ` +
        `v2.11 has removed the JSONL importer — either stay on v2.10 ` +
        `to use this state, or wipe the state directory to start fresh on v2.11.`,
    );
  }

  // Phase B: load the SqliteBackend module. Failure here means neither
  // `better-sqlite3` (Node) nor `bun:sqlite` (Bun) resolves on this
  // platform. Pre-v2.11 this branch logged and returned undefined, then
  // callers limped along on the JSONL substrate. Post-DR-3 there is no
  // JSONL substrate; failing here is the only correct behavior.
  let SqliteBackend: typeof import('./storage/sqlite-backend.js').SqliteBackend;
  try {
    ({ SqliteBackend } = await loadSqliteBackend());
  } catch (importErr) {
    const reason = importErr instanceof Error ? importErr.message : String(importErr);
    throw new Error(
      `SQLite driver unavailable — install better-sqlite3 (Node) or run under bun (bun:sqlite). ` +
        `Both drivers failed to load: ${reason}.`,
    );
  }

  // Phase C: open and initialize the database. We do NOT catch
  // initialization failures. `SqliteBackend.initialize()` raises
  // `SqliteCorruptError` (SQLITE_CORRUPT / SQLITE_NOTADB) and other
  // typed errors that operators must see — silent auto-rebuild was the
  // pre-Tier-1 behavior, and it depended on the JSONL→SQLite migration
  // runner re-importing legacy event bytes. With Tier 1 ripped (#1259)
  // and the importer removed in Phase 4 there is no recovery path;
  // deleting a corrupt DB now equals data loss. Let the error propagate.
  const backend = new SqliteBackend(dbPath);
  backend.initialize();
  return backend;
}

// ─── Backend Cleanup ────────────────────────────────────────────────────────

/**
 * Register a process exit handler that closes the storage backend.
 */
export function registerBackendCleanup(backend: StorageBackend): void {
  process.on('exit', () => {
    try {
      backend.close();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to close storage backend on exit');
    }
  });
}

// ─── Server Factory (backward compat) ────────────────────────────────────────

/**
 * Creates an MCP server with the given state directory and options.
 *
 * Async wrapper that initializes DispatchContext inline and delegates to
 * `createMcpServer()`. The underlying MCP SDK + tool-registration graph is
 * loaded lazily via dynamic import so that CLI cold-start paths
 * (e.g. `exarchos wf status`) do not pay the ~60ms MCP-SDK module-load cost.
 *
 * For new code, prefer `initializeContext()` +
 * `import('./adapters/mcp.js').createMcpServer()` directly.
 */
export async function createServer(
  stateDir: string,
  options?: CreateServerOptions,
): Promise<V2McpServer> {
  const backend = options?.backend;

  // Configure module-level stores (EventStore is threaded via DispatchContext)
  configureStateStoreBackend(backend);

  const eventStore = new EventStore(stateDir, { backend });

  // SnapshotStore is still module-level (out of scope for EventStore threading)
  configureCleanupSnapshotStore(new SnapshotStore(stateDir));

  const enableTelemetry = process.env.EXARCHOS_TELEMETRY !== 'false';

  // Default to always-on cache hints with an env kill switch (T051, DR-14).
  // Mirror of `core/context.ts:buildDefaultCapabilityResolver` — kept inline
  // because this entrypoint runs before the module-graph cost we shed in
  // `initializeContext` is acceptable.
  const capabilityResolver =
    process.env.EXARCHOS_DISABLE_CACHE_HINTS === '1'
      ? createInMemoryResolver([])
      : createInMemoryResolver([ANTHROPIC_NATIVE_CACHING]);

  // DR-2 (T16): thread the storage handle (when present) onto the context
  // so consumers do not need to import `bun:sqlite` directly. The same
  // backend was already passed to `EventStore` above; surfacing it on
  // `DispatchContext` is what closes the DI gap.
  //
  // DR-6 (Task 015): slim `tools/list` registration is ON by default in the
  // production dispatch context — every visible tool advertises its compact
  // `slimDescription` (which points at the `describe` action, the on-demand
  // full-detail path, per INV-5a) instead of the base blurb + every action
  // signature. This is the one-line context flip that takes the always-loaded
  // registration from ~7,851 tok/session to the slim ceiling. `describe`
  // remains the bounded path for per-action schemas and negative-space
  // ("Do NOT use for …") guidance.
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry, capabilityResolver, storage: backend, slimRegistration: true };

  // Lazy-load the MCP adapter so the CLI cold-start path doesn't incur the
  // MCP-SDK import cost. See module-level note on top of file.
  const { createMcpServer } = await import('./adapters/mcp.js');
  return createMcpServer(ctx);
}

// ─── State Directory Resolution ──────────────────────────────────────────────

export async function resolveStateDir(): Promise<string> {
  return resolveStateDirFromPaths();
}

// ─── Hook CLI Utilities ──────────────────────────────────────────────────
// Inlined from cli.ts to avoid importing the full module (and its eval deps).

function hookParseStdinJson(input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (trimmed.length === 0) return {};
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Expected JSON object, received ' + (Array.isArray(parsed) ? 'array' : typeof parsed));
  }
  return parsed as Record<string, unknown>;
}

function hookOutputJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function hookReadStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

async function main() {
  // ─── Hook Command Fast Path ────────────────────────────────────────────────
  // Observer hook commands (session-start, session-end) are invoked as
  // subprocesses by Claude Code with tight timeouts (10-30s). They only need
  // lightweight state-dir access, not the full SQLite backend or hydration.
  // Intercept them here before the expensive initialization path. #1476: the
  // former enforcement/control hooks were retired — enforcement now lives
  // entirely inside the MCP tools.
  const hookCommand = process.argv[2];
  if (hookCommand !== undefined && isHookCommand(hookCommand)) {
    const result = await handleHookCommand(
      hookCommand,
      process.argv,
      hookReadStdin,
      hookParseStdinJson,
      hookOutputJson,
    );
    if (result.handled && result.exitCode) {
      process.exitCode = result.exitCode;
    }
    return;
  }

  // ─── Version Fast Path ─────────────────────────────────────────────────────
  // Printing the version is a stateless operation — it must not open the
  // SQLite event store. Initializing the backend here both wastes cold-start
  // budget and, under concurrent invocations against a shared/contended state
  // dir, can race on WAL recovery and surface SQLITE_BUSY_RECOVERY (the
  // `exarchos --version` E2E flake). Resolve the version via the same source
  // `buildCli().version()` uses and exit before any backend work. The global
  // `--version` / `-V` flag is only meaningful as the leading token; once a
  // subcommand is present Commander owns the parse.
  const versionArg = process.argv[2];
  if (versionArg === '--version' || versionArg === '-V') {
    process.stdout.write(`${resolvePackageVersion()}\n`);
    return;
  }

  // Same stateless guarantee, but for the `version` *subcommand* (distinct from
  // the `--version` flag above; see `adapters/cli.ts` "Top-level version
  // command"). Plain `exarchos version` prints the identical string yet — until
  // this branch — fell through to `initializeBackend()` and opened the SQLite
  // event store. Under concurrent invocation against a shared/contended state
  // dir (the E2E preflight spawns `exarchos version` from every vitest worker)
  // that races on WAL recovery and surfaces SQLITE_BUSY_RECOVERY, which the
  // fatal handler reports via the async logger + immediate `process.exit(1)` —
  // i.e. exit 1 with empty stderr. Short-circuit the plain form here with the
  // same output and no backend work. The `version --check-plugin-root <path>`
  // diagnostic carries a trailing arg, so it still routes through Commander
  // below where its compat-check action lives.
  if (versionArg === 'version' && process.argv[3] === undefined) {
    process.stdout.write(`${resolvePackageVersion()}\n`);
    return;
  }

  // ─── run-tests Fast Path ─────────────────────────────────────────────────
  // `exarchos run-tests` is invoked by the agents' post-test PostToolUse hook
  // (#1470/#1483 F1). It resolves the consumer's test command at runtime and
  // execs it, so the shipped agent artifacts stay toolchain-neutral. Like the
  // version path it is stateless — it must not open the SQLite backend. It is
  // deliberately NOT a HOOK_COMMAND: that set is observe-only (#1476 ADR) and
  // never executes a workload; run-tests runs the suite, so it lives here.
  if (process.argv[2] === 'run-tests') {
    const { handleRunTests } = await import('./cli-commands/run-tests.js');
    process.exitCode = handleRunTests(process.argv.slice(3), { cwd: process.cwd() });
    return;
  }

  // ─── verify-worktree-boundary Fast Path ──────────────────────────────────
  // `exarchos verify-worktree-boundary` is the PreToolUse boundary guard for
  // task-isolated agents (#1301). The Claude Code hook feeds the tool call as
  // JSON on stdin; the guard denies (exit 2) any write that escapes the
  // worktree. Like run-tests it is stateless — it must NOT open the SQLite
  // backend, and it must stay fast (it runs before every agent file write).
  if (process.argv[2] === 'verify-worktree-boundary') {
    const { handleVerifyWorktreeBoundary } = await import(
      './cli-commands/verify-worktree-boundary.js'
    );
    // Read the hook payload from stdin. Guard against an interactive TTY (no
    // piped input): `fs.readFileSync(0)` would block forever waiting on the
    // terminal. With no payload there is nothing to evaluate — allow.
    const stdin = process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8');
    process.exitCode = handleVerifyWorktreeBoundary(stdin);
    return;
  }

  const stateDir = await resolveStateDir();

  // Ensure state directory exists
  fs.mkdirSync(stateDir, { recursive: true });

  // Initialize the SQLite backend. Post-v2.11 substrate-cut (DR-3 /
  // Phase 4) this either returns a usable backend or throws — the
  // pre-v2.11 "JSONL fallback" branch is gone. Errors propagate to
  // `main()`'s catch, which logs and exits with code 1.
  const backend = await initializeBackend(stateDir);
  registerBackendCleanup(backend);

  // DR-6 (Task 015): the shipped `exarchos mcp` server is dispatched from this
  // context (buildCli → cli.ts `mcp` action → createMcpServer(ctx)), so the
  // slim-registration flip must land here too — not only on the `createServer`
  // library factory above. `slimRegistration` is read solely by
  // `buildToolDescription` at tools/list registration (adapters/mcp.ts); CLI
  // dispatch ignores it, so setting it on the ctx shared with `buildCli` is
  // inert for every non-MCP subcommand.
  const ctx: DispatchContext = {
    ...(await initializeContext(stateDir, {
      backend,
      projectRoot: process.cwd(),
    })),
    slimRegistration: true,
  };

  // Unified entry point — all routing via Commander CLI.
  // `exarchos mcp` starts the MCP server; other commands are CLI mode.
  // No args shows help. DR-5: runCli installs exitOverride and funnels
  // Commander parse errors through the shared INVALID_INPUT contract so
  // the CLI facade rejects malformed input with the same `error.code` as
  // the MCP dispatch path.
  const program = buildCli(ctx);

  // ─── Execution-Mode Detection (F-021-5) ────────────────────────────────────
  // Server-mode-only work (hook-event sidecar merge + lifecycle compaction)
  // runs via a commander `preAction` hook instead of a positional `argv[2]`
  // check. The hook fires immediately before the `mcp` subcommand's
  // `action()` and is a no-op for every other command, which keeps CLI
  // cold-start (`wf status`, `vw *`, `schema`, etc.) free of the work that
  // only makes sense when the process stays alive. See DR-5 / task 021
  // cold-start budget.
  //
  // Future global flags like `--verbose` in front of `mcp` would have broken
  // the old `argv[2] === 'mcp'` check; the `actionCommand.name()` lookup is
  // robust to flag positioning. Coordinates with F-022-2.
  //
  // Note: the `inSidecarMode` gate that previously guarded this block was
  // removed in v2.11 (#1082) — the EventStore no longer enters sidecar
  // mode. The hook-event merger still runs unconditionally on the server
  // path so writes from CLI hook subprocesses (which deliberately bypass
  // the EventStore for cold-start reasons) get reconciled in.
  program.hook('preAction', async (_thisCommand, actionCommand) => {
    if (actionCommand.name() !== 'mcp') return;

    {
      const { startPeriodicMerge } = await import('./storage/sidecar-scheduler.js');
      const drainHandle = await startPeriodicMerge(stateDir, ctx.eventStore, undefined, { immediate: true });
      process.on('exit', () => drainHandle.stop());
    }

    // Lifecycle management: compact old workflows and rotate telemetry (fire-and-forget)
    void import('./storage/lifecycle.js')
      .then(({ checkCompaction, rotateTelemetry, DEFAULT_LIFECYCLE_POLICY }) => {
        void checkCompaction(backend, stateDir, DEFAULT_LIFECYCLE_POLICY).catch((err) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Lifecycle compaction failed');
        });
        void rotateTelemetry(backend, stateDir, DEFAULT_LIFECYCLE_POLICY).catch((err) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Telemetry rotation failed');
        });
      })
      .catch((err) => {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to load lifecycle module');
      });
  });

  // F-024: runCli installs exitOverride and funnels Commander parse errors
  // through the shared INVALID_INPUT contract.
  await runCli(program, process.argv);
}

/**
 * Decide whether this module is being executed directly (vs imported as a
 * library) by comparing `import.meta.url` to `process.argv[1]`.
 *
 * Two encoding hazards have to be handled:
 *   1. `import.meta.url` is a standard file:// URL, so path segments containing
 *      spaces or non-ASCII characters are percent-encoded (`%20` etc.) while
 *      `process.argv[1]` is a raw OS path. `fileURLToPath()` decodes and
 *      converts the URL into a platform path string.
 *   2. On Windows, decoded paths use backslashes but `argv[1]` may come
 *      through either separator style depending on the launcher. We normalize
 *      both sides to forward slashes before comparison.
 *
 * Without these, Windows users hit a silent CLI no-op — `main()` never ran
 * because `endsWith` never matched. See #1085.
 *
 * On Linux, `npm link` installs a symlink (e.g. `~/.local/bin/exarchos` →
 * `.../dist/exarchos.js`). `argv[1]` is the symlink path, but Node resolves
 * symlinks for ESM modules so `import.meta.url` points at the real file. The
 * `endsWith` check then misses and the CLI silently no-ops. Resolving
 * `argv[1]` through `realpathSync` before comparing closes that gap. See #1158.
 *
 * Exported for unit testing; callers should pass `import.meta.url` and
 * `process.argv[1]` directly.
 */
export function isDirectExecution(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  const modulePath = fileURLToPath(metaUrl).replace(/\\/g, '/');
  const resolvedArgv = (() => {
    try {
      return realpathSync(argv1).replace(/\\/g, '/');
    } catch {
      return argv1.replace(/\\/g, '/');
    }
  })();
  return (
    modulePath.endsWith(resolvedArgv) ||
    modulePath.endsWith(resolvedArgv.replace(/\.ts$/, '.js'))
  );
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    logger.fatal({ err }, 'MCP server fatal error');
    process.exit(1);
  });
}
