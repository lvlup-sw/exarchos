/**
 * Shared fixtures for compiled-binary MCP integration tests (task 1.6 +
 * follow-ons). Kept in `test/process/` so vitest's test glob does not try
 * to treat this file as a suite — there are no `describe()` blocks here.
 *
 * Exposes:
 *   - `findRepoRoot()` — walks up from a given directory to the monorepo
 *     root (the ancestor that contains `scripts/build-binary.ts`).
 *   - `hostBinaryPath(repoRoot)` — computes the `dist/bin/exarchos-<os>-<arch>`
 *     path for the host platform, including the `.exe` suffix on Windows.
 *   - `ensureBinaryBuilt(repoRoot)` — the beforeAll rebuild guard: runs
 *     `bun run scripts/build-binary.ts` if the binary is missing or older
 *     than any file under `servers/exarchos-mcp/src/**`.
 *   - `openFixture(binaryPath, repoRoot)` / `closeFixture(fx)` — opens a
 *     live MCP stdio Client against the spawned binary with a hermetic
 *     `WORKFLOW_STATE_DIR` temp directory and tears it down.
 *   - `deliverCrash(request)` / `awaitProcessDeath(pid)` — the T3 crash
 *     primitive (T-39 / DR-29). Delivers a REAL `SIGKILL` to a real, live
 *     child pid and REFUSES every in-process substitute, so a crash arm
 *     cannot be quietly downgraded into a vacuous in-process one.
 *
 * `ensureBinaryBuilt` is `async` and serialized by `withBuildLock` (T-38 /
 * DR-29): multiple `test/process/*.test.ts` files each call it from their own
 * `beforeAll`, and — because this suite's `vitest.config.ts` uses `pool:
 * 'forks'` with default file parallelism — those files run concurrently in
 * SEPARATE OS processes. A plain module-level promise memo only dedupes
 * calls *within one process* and does nothing across forks: two files could
 * still race to spawn `bun build --compile` against the same output path at
 * the same time, producing a torn/half-written binary. `withBuildLock` uses
 * an exclusive lockfile (`open(..., 'wx')`, atomic at the OS level, so it
 * holds across real processes) plus a build-to-temp-dir + atomic-rename
 * sequence, so a partially-written binary is never observable at the
 * canonical path and the real `bun build --compile` work happens at most
 * once per staleness window.
 */

// The client generation MUST track the server's. The binary this fixture
// spawns is a v2 server (DR-0, task 049), so the driving client is v2 too.
// This file drove it with a v1 `Client` until after 049 landed, and it was not
// caught because the removal criterion was measured over `src/` while being
// reported over the package — the guard that now covers this tree is
// `src/__tests__/sdk-pin-policy.test.ts`. It survived that long precisely
// because the stdio pairing is the FORGIVING one: real pipes carry JSON-RPC
// between generations, so this read as passing rather than failing. The
// in-memory pairing is the unforgiving one — two linked-pair implementations
// from different packages connect to their own siblings and present as a hang
// — which is what makes a cross-generation pair here a latent trap rather than
// a loud error.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isPidAlive, needsWindowsShell } from '../../src/utils/process.js';

// ─── Repo-root discovery ────────────────────────────────────────────────────

export function findRepoRoot(startDir: string): string {
  let cursor = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const marker = path.join(cursor, 'scripts', 'build-binary.ts');
    if (fs.existsSync(marker)) return cursor;
    const next = path.dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  throw new Error(
    `Unable to locate repo root (no scripts/build-binary.ts in any ancestor of ${startDir})`,
  );
}

// ─── Host-binary path resolver ──────────────────────────────────────────────

export function hostBinaryPath(repoRoot: string): string {
  const platform = os.platform();
  const arch = os.arch();

  // Refuse to coerce unknown hosts to linux/x64 — pointing the test at
  // the wrong artefact would mask a real incompatibility on uncommon
  // platforms. Mirrors `getHostTarget()` in `scripts/build-binary.ts`.
  let osName: 'linux' | 'darwin' | 'windows';
  if (platform === 'darwin') {
    osName = 'darwin';
  } else if (platform === 'win32') {
    osName = 'windows';
  } else if (platform === 'linux') {
    osName = 'linux';
  } else {
    throw new Error(`unsupported host platform for compiled-binary tests: ${platform}`);
  }

  let archName: 'x64' | 'arm64';
  if (arch === 'x64' || arch === 'arm64') {
    archName = arch;
  } else {
    throw new Error(`unsupported host arch for compiled-binary tests: ${arch}`);
  }

  const ext = osName === 'windows' ? '.exe' : '';
  return path.join(repoRoot, 'dist', 'bin', `exarchos-${osName}-${archName}${ext}`);
}

// ─── Freshness check ────────────────────────────────────────────────────────

function newestMtimeUnder(dir: string, predicate: (p: string) => boolean): number {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && predicate(full)) {
        const mtime = fs.statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      }
    }
  }
  return newest;
}

export interface BinaryBuildResult {
  readonly binaryPath: string;
  readonly rebuilt: boolean;
}

/**
 * The compiled binary's content depends on every input bun bundles plus the
 * build orchestration script itself. Restricting the freshness scan to
 * `servers/exarchos-mcp/src/**` would miss edits to the build pipeline
 * (`scripts/build-binary.ts`) and to root sources that may be bundled in
 * future, leaving a stale binary in place during integration tests. Scanning
 * each tracked input directory keeps the check cheap while catching the
 * realistic edit surfaces.
 */
function computeSrcNewest(repoRoot: string): number {
  const dirInputs = [
    path.join(repoRoot, 'servers', 'exarchos-mcp', 'src'),
    path.join(repoRoot, 'scripts'),
    path.join(repoRoot, 'src'),
  ];

  // Manifest + lockfile mtimes also matter: a `package.json` /
  // `package-lock.json` / `bun.lock` / `bun.lockb` edit can change the
  // dependency graph that bun bundles even when no `.ts` file moved.
  // Include both npm and bun lockfile shapes so a dep bump under either
  // package manager triggers a rebuild — this repo uses npm at the root
  // but bun owns the compiled-binary pipeline.
  const fileInputs = [
    path.join(repoRoot, 'package.json'),
    path.join(repoRoot, 'package-lock.json'),
    path.join(repoRoot, 'bun.lock'),
    path.join(repoRoot, 'bun.lockb'),
    path.join(repoRoot, 'servers', 'exarchos-mcp', 'package.json'),
    path.join(repoRoot, 'servers', 'exarchos-mcp', 'package-lock.json'),
    path.join(repoRoot, 'servers', 'exarchos-mcp', 'bun.lock'),
    path.join(repoRoot, 'servers', 'exarchos-mcp', 'bun.lockb'),
    path.join(repoRoot, 'servers', 'exarchos-mcp', 'tsconfig.json'),
    path.join(repoRoot, 'tsconfig.json'),
  ];

  let srcNewest = 0;
  for (const dir of dirInputs) {
    if (!fs.existsSync(dir)) continue;
    const newest = newestMtimeUnder(dir, (p) => p.endsWith('.ts'));
    if (newest > srcNewest) srcNewest = newest;
  }
  for (const file of fileInputs) {
    if (!fs.existsSync(file)) continue;
    const mtime = fs.statSync(file).mtimeMs;
    if (mtime > srcNewest) srcNewest = mtime;
  }
  return srcNewest;
}

function isBinaryFresh(binaryPath: string, srcNewest: number): boolean {
  if (!fs.existsSync(binaryPath)) return false;
  return fs.statSync(binaryPath).mtimeMs >= srcNewest;
}

// ─── Cross-process build lock (T-38 / DR-29) ────────────────────────────────

export interface BuildLockOptions {
  /** Max time to wait to ACQUIRE the lock before giving up (ms). */
  readonly timeoutMs?: number;
  /**
   * A lock file older than this is treated as abandoned (its holder crashed
   * or was killed) and reclaimed by the next waiter. Must stay comfortably
   * above the longest real build duration — the callers of `ensureBinaryBuilt`
   * carry `beforeAll` hook timeouts up to 240s, so this defaults well above
   * that rather than risking two callers both believing they hold the lock.
   */
  readonly staleMs?: number;
  /** Poll interval while waiting for a contended lock (ms). */
  readonly pollIntervalMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 300_000;
const DEFAULT_LOCK_STALE_MS = 10 * 60_000;
const DEFAULT_LOCK_POLL_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cross-process mutual exclusion guarding `fn`, keyed on `lockPath`.
 *
 * The lock is a plain file created with the `wx` flag — `open(O_CREAT |
 * O_EXCL)` — which is atomic at the OS/filesystem layer: at most one caller,
 * IN ANY PROCESS, ever observes a successful create for a given path at a
 * given time. That is what lets this hold across the separate OS processes
 * `vitest`'s `pool: 'forks'` spawns per test file, not merely across
 * concurrent callers within one process.
 *
 * A holder that dies mid-build (killed test runner, OOM, CI cancellation)
 * would otherwise wedge every subsequent run forever — the `staleMs` window
 * lets a later caller reclaim an abandoned lock rather than hang forever.
 */
export async function withBuildLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  options: BuildLockOptions = {},
): Promise<T> {
  const {
    timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    staleMs = DEFAULT_LOCK_STALE_MS,
    pollIntervalMs = DEFAULT_LOCK_POLL_MS,
  } = options;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const start = Date.now();
  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      // Someone else holds the lock. If it looks abandoned, reclaim it;
      // otherwise wait and retry.
      let stillContended = true;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          try {
            fs.unlinkSync(lockPath);
            stillContended = false; // reclaimed — retry the open immediately
          } catch {
            /* another caller already reclaimed it — fall through to retry */
          }
        }
      } catch {
        // Lock vanished between the EEXIST and the stat — the holder just
        // released it; retry immediately rather than sleeping.
        stillContended = false;
      }
      if (!stillContended) continue;

      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for build lock at ${lockPath}`);
      }
      await sleep(pollIntervalMs);
      continue;
    }

    // Lock acquired: stamp it with our PID (diagnostic only, also what
    // anchors the mtime the staleness check above reads) and run the
    // guarded work, always releasing on the way out — including on throw.
    try {
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      fd = undefined;
      return await fn();
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    }
  }
}

// ─── Build orchestration ────────────────────────────────────────────────────

/**
 * Runs the real `bun run scripts/build-binary.ts --outdir <outDir>` build.
 * Extracted so tests can inject a fake in its place (`EnsureBinaryBuiltOptions
 * .runBuild`) without shelling out to `bun` or racing the real artifact path.
 */
function defaultRunBuild(repoRoot: string, outDir: string): void {
  // `bun` on win32 is a `.cmd`/`.ps1` shim, which `spawnSync` cannot resolve
  // without a shell — it returns `status: null` with no stdout/stderr, which the
  // check below reported as an opaque "build-binary.ts failed (exit null)".
  // The repo already owns this rule in `utils/process.ts`; reuse it rather than
  // re-deriving the platform test here.
  const useShell = needsWindowsShell('bun');
  const result = spawnSync(
    'bun',
    ['run', 'scripts/build-binary.ts', '--outdir', outDir],
    {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf8',
      ...(useShell ? { shell: true } : {}),
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `build-binary.ts failed (exit ${result.status}${
        result.error === undefined ? '' : `, ${result.error.message}`
      }):\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
}

export interface EnsureBinaryBuiltOptions {
  /**
   * Build step to run when a (re)build is needed. Must produce the artifact
   * at `<outDir>/<basename of the host binary path>`; `outDir` is a scratch
   * directory unique to this call. Defaults to the real
   * `bun run scripts/build-binary.ts --outdir <outDir>` invocation. Tests
   * inject a fake here so concurrency can be exercised hermetically, without
   * shelling out to `bun`.
   */
  readonly runBuild?: (repoRoot: string, outDir: string) => void | Promise<void>;
  /** Forwarded to `withBuildLock` — test-only knob for fast timeouts. */
  readonly lockOptions?: BuildLockOptions;
}

export async function ensureBinaryBuilt(
  repoRoot: string,
  options: EnsureBinaryBuiltOptions = {},
): Promise<BinaryBuildResult> {
  const binaryPath = hostBinaryPath(repoRoot);

  if (isBinaryFresh(binaryPath, computeSrcNewest(repoRoot))) {
    return { binaryPath, rebuilt: false };
  }

  // Lockfile lives beside the artifact it guards so it inherits the same
  // `dist/bin` directory (created below) and is trivially discoverable when
  // debugging a stuck build.
  const lockPath = `${binaryPath}.lock`;

  return withBuildLock(
    lockPath,
    async () => {
      // Re-check freshness now that we hold the lock: another
      // process/worker may have completed the build while we were waiting
      // for our turn, in which case there is nothing left to do.
      if (isBinaryFresh(binaryPath, computeSrcNewest(repoRoot))) {
        return { binaryPath, rebuilt: false };
      }

      const outDir = path.join(
        path.dirname(binaryPath),
        `.build-tmp-${process.pid}-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2)}`,
      );
      fs.mkdirSync(outDir, { recursive: true });
      try {
        const runBuild = options.runBuild ?? defaultRunBuild;
        await runBuild(repoRoot, outDir);

        const builtPath = path.join(outDir, path.basename(binaryPath));
        if (!fs.existsSync(builtPath)) {
          throw new Error(`Binary missing after build: ${builtPath}`);
        }

        fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
        // Atomic rename into place: `rename()` is a single filesystem
        // operation on the same volume, so any concurrent reader of
        // `binaryPath` observes either the previous complete artifact or the
        // new complete one — never a partially-written file.
        fs.renameSync(builtPath, binaryPath);
        return { binaryPath, rebuilt: true };
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    },
    options.lockOptions,
  );
}

// ─── Transport fixture ──────────────────────────────────────────────────────

export interface Fixture {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly stateDir: string;
}

export async function openFixture(binaryPath: string, repoRoot: string): Promise<Fixture> {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'exarchos-compiled-test-'));
  const transport = new StdioClientTransport({
    command: binaryPath,
    args: ['mcp'],
    env: {
      ...process.env,
      WORKFLOW_STATE_DIR: stateDir,
      EXARCHOS_PLUGIN_ROOT: repoRoot,
      LOG_LEVEL: 'error',
    } as Record<string, string>,
    stderr: 'pipe',
  });

  const client = new Client(
    { name: 'compiled-binary-integration-test', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    return { client, transport, stateDir };
  } catch (error) {
    // Connect can fail if the spawned binary exits early (missing
    // dependency, invalid env, etc.). The temp dir we just minted would
    // otherwise leak — clean up before rethrowing so successive test
    // runs don't accumulate `/tmp/exarchos-compiled-test-*` directories.
    await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function closeFixture(fx: Fixture): Promise<void> {
  try {
    await fx.client.close();
  } catch {
    /* ignore — transport already torn down */
  }
  try {
    await fsp.rm(fx.stateDir, { recursive: true, force: true });
  } catch {
    /* ignore — temp dir may have been cleaned by GC */
  }
}

// ─── T3 crash injection: REAL process death only (T-39 / DR-29) ─────────────

/**
 * Why this guard exists.
 *
 * The whole value of the T3 tier is that its faults are real: a process that
 * STOPS EXISTING mid-operation, leaving the disk exactly as the kernel last saw
 * it. An in-process `throw` looks superficially similar and is far cheaper to
 * write, but it is a different experiment entirely — it runs the `catch` block,
 * the `finally` cleanups and every unwind path, so it proves the happy-path
 * error handler works while proving NOTHING about an actual crash. A T3 arm
 * that quietly downgrades to one is vacuous, and vacuous in a way no assertion
 * in the arm itself would reveal (it still goes green).
 *
 * So the downgrade is made IMPOSSIBLE TO PERFORM QUIETLY: every crash in this
 * tier is delivered through {@link deliverCrash}, which refuses anything that
 * is not the real thing — by name (`in-process-throw` / `in-process-abort`),
 * by self-targeting (a "kill" aimed at the test runner's own pid is in-process
 * by definition), and by liveness (a pid that is not a live OS process cannot
 * be killed, so a fabricated one is rejected rather than silently no-op'ing).
 */
export type CrashRejectionCode =
  /** The request asked for an in-process fault instead of a real process death. */
  | 'IN_PROCESS_INJECTION'
  /** The "child" pid is this very process — an in-process fault wearing a pid. */
  | 'SELF_TARGETED'
  /** No live OS process carries that pid, so nothing would actually be killed. */
  | 'NOT_A_LIVE_PROCESS';

/** Typed, loud refusal from {@link deliverCrash}. */
export class CrashInjectionRejectedError extends Error {
  constructor(
    readonly code: CrashRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = 'CrashInjectionRejectedError';
  }
}

/**
 * A crash a T3 arm can ask the harness to deliver.
 *
 * The in-process shapes are modelled DELIBERATELY rather than omitted: a union
 * with only `sigkill` in it would be refused by the type checker, and a
 * contributor reaching for the cheap fault would simply not call the harness at
 * all. Naming them here means the request is expressible, reaches the harness,
 * and is rejected AT RUNTIME with an explanation — which is what makes the
 * rejection testable and the downgrade visible.
 */
export type CrashRequest =
  /** The real thing: SIGKILL (TerminateProcess on win32) to a live child pid. */
  | { readonly kind: 'sigkill'; readonly pid: number | undefined }
  /** REJECTED — an exception thrown inside the test process. */
  | { readonly kind: 'in-process-throw'; readonly inject: () => never }
  /** REJECTED — any other in-process abort/unwind hook. */
  | { readonly kind: 'in-process-abort'; readonly inject: () => void };

/**
 * Deliver a REAL, unconditional process kill, or refuse loudly.
 *
 * Returns the pid that was killed. The `inject` callback of a rejected request
 * is NEVER invoked — the refusal happens before any in-process fault can run,
 * so a rejected arm cannot accidentally half-execute its cheap substitute.
 *
 * Note on `SIGKILL` on win32: Node maps it to `TerminateProcess`, which is a
 * genuine unconditional kill — no handler, no `finally`, no flush. It is the
 * right primitive here, and a graceful shutdown is NOT an acceptable stand-in.
 */
export function deliverCrash(request: CrashRequest): number {
  if (request.kind !== 'sigkill') {
    throw new CrashInjectionRejectedError(
      'IN_PROCESS_INJECTION',
      `refusing a '${request.kind}' fault: the process tier (T3 / DR-29) proves what survives a ` +
        `process that stops existing mid-operation. An in-process fault runs the catch block, the ` +
        `finally cleanups and every unwind path, so it demonstrates the error handler and nothing ` +
        `about a real crash. Spawn a real child process and pass { kind: 'sigkill', pid } instead.`,
    );
  }

  const { pid } = request;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    throw new CrashInjectionRejectedError(
      'NOT_A_LIVE_PROCESS',
      `refusing to deliver SIGKILL to pid ${String(pid)}: not a valid process id, so nothing would ` +
        `actually be killed and the arm would pass without ever crashing anything.`,
    );
  }
  if (pid === process.pid) {
    throw new CrashInjectionRejectedError(
      'SELF_TARGETED',
      `refusing to deliver SIGKILL to pid ${pid}: that is the test process itself. A fault aimed at ` +
        `the runner is an in-process fault wearing a pid — kill a real child instead.`,
    );
  }
  if (!isPidAlive(pid)) {
    throw new CrashInjectionRejectedError(
      'NOT_A_LIVE_PROCESS',
      `refusing to deliver SIGKILL to pid ${pid}: no live process carries it (it already exited, or ` +
        `it was never spawned), so the kill would be a no-op and the arm would prove nothing.`,
    );
  }

  process.kill(pid, 'SIGKILL');
  return pid;
}

/**
 * Block until `pid` is gone, so an arm never inspects the disk while the killed
 * process is still, briefly, alive. Throws rather than returning a boolean: a
 * kill that did not take is a broken fixture, not a condition to branch on.
 */
export async function awaitProcessDeath(pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await sleep(10);
  }
  throw new Error(`pid ${pid} was still alive ${timeoutMs}ms after SIGKILL`);
}

