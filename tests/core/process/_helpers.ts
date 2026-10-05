/**
 * Shared fixtures for the tests that drive the compiled binary.
 *
 * `ensureBinaryBuilt` rebuilds the host binary when it is absent or older than its inputs. Several
 * test files call it from `beforeAll`, and vitest can run those files in separate OS processes.
 * A promise memo cannot serialize the build across processes, so `withBuildLock` uses an
 * exclusive lock file. The build goes to a scratch directory and an atomic rename puts the binary
 * in place, so no reader sees a partial binary.
 *
 * `deliverCrash` and `awaitProcessDeath` are the crash primitive of the process tier. A crash is a
 * real `SIGKILL` to a live child pid, and `deliverCrash` refuses each in-process substitute.
 *
 * The MCP client generation must match the server generation. The binary is a v2 server, so this
 * file uses the v2 client. A stdio pair of two generations still passes, because the pipes carry
 * JSON-RPC. `tests/unit/sdk-pin-policy.test.ts` keeps the v1 package out of the tree.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isPidAlive } from '../../../src/utils/process.js';
import { spawnAsync } from '../../../tools/test-helpers/spawn.js';
import { rmrf, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/** Returns the nearest ancestor of `startDir` that holds `tools/release/build-binary.ts`. */
export function findRepoRoot(startDir: string): string {
  let cursor = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const marker = path.join(cursor, 'tools', 'release', 'build-binary.ts');
    if (fs.existsSync(marker)) return cursor;
    const next = path.dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  throw new Error(
    `Unable to locate repo root (no tools/release/build-binary.ts in any ancestor of ${startDir})`,
  );
}

/**
 * Returns the `dist/bin/exarchos-<os>-<arch>` path of the host binary, with `.exe` on Windows.
 * An unknown platform or architecture throws, because a fallback to linux-x64 hides a real
 * incompatibility. The mapping copies `getHostTarget()` in `tools/release/build-binary.ts`.
 */
export function hostBinaryPath(repoRoot: string): string {
  const platform = os.platform();
  const arch = os.arch();

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

/** Returns the newest mtime of the files under `dir` that pass `predicate`. */
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
 * Returns the newest mtime of the inputs of the compiled binary. The scan covers the `.ts` files
 * under `src`, `tools/audit` and `tools/release`, because an edit to the build script also makes
 * the binary stale. It also covers the manifest, the npm and bun lockfiles and `tsconfig.json`,
 * because a dependency change alters the bundle when no `.ts` file changes.
 */
function computeSrcNewest(repoRoot: string): number {
  const dirInputs = [
    path.join(repoRoot, 'src'),
    path.join(repoRoot, 'tools', 'audit'),
    path.join(repoRoot, 'tools', 'release'),
    path.join(repoRoot, 'src'),
  ];

  const fileInputs = [
    path.join(repoRoot, 'package.json'),
    path.join(repoRoot, 'package-lock.json'),
    path.join(repoRoot, 'bun.lock'),
    path.join(repoRoot, 'bun.lockb'),
    path.join(repoRoot, 'package.json'),
    path.join(repoRoot, 'package-lock.json'),
    path.join(repoRoot, 'bun.lock'),
    path.join(repoRoot, 'bun.lockb'),
    path.join(repoRoot, 'tsconfig.json'),
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

export interface BuildLockOptions {
  /** The maximum wait for the lock, in milliseconds. */
  readonly timeoutMs?: number;
  /**
   * A lock file older than this value counts as abandoned, and the next waiter reclaims it. The
   * value must stay above the longest real build, or two callers can hold the lock together. The
   * `beforeAll` hooks of the callers time out at up to 240 s, so the default is 10 minutes.
   */
  readonly staleMs?: number;
  /** The poll interval while another caller holds the lock, in milliseconds. */
  readonly pollIntervalMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 300_000;
const DEFAULT_LOCK_STALE_MS = 10 * 60_000;
const DEFAULT_LOCK_POLL_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` under a cross-process lock on `lockPath`.
 *
 * The lock is a file opened with the `wx` flag. The create is atomic in the filesystem, so at
 * most one caller, in any process, holds the lock at a time. The holder writes its pid into the
 * file for diagnosis, and the mtime of the file is the input of the stale check. The function
 * releases the lock when `fn` returns or throws.
 *
 * A waiter reclaims a lock that is older than `staleMs`, so a dead holder does not block each
 * later run. A waiter retries at once after a reclaim, or when the lock disappears between the
 * open and the stat. Otherwise it polls until `timeoutMs` and then throws.
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

      let stillContended = true;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          try {
            fs.unlinkSync(lockPath);
            stillContended = false;
          } catch {
          }
        }
      } catch {
        stillContended = false;
      }
      if (!stillContended) continue;

      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for build lock at ${lockPath}`);
      }
      await sleep(pollIntervalMs);
      continue;
    }

    try {
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      fd = undefined;
      return await fn();
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch {
      }
    }
  }
}

/**
 * Runs the real `bun run tools/release/build-binary.ts --outdir <outDir>` build. A test injects a
 * fake through `EnsureBinaryBuiltOptions.runBuild`. On win32, `bun` is a `.cmd` shim that needs a
 * shell, and `spawnAsync` applies that rule. A raw spawn with no shell gives exit `null` and no
 * output there.
 */
async function defaultRunBuild(repoRoot: string, outDir: string): Promise<void> {
  const result = await spawnAsync(
    'bun',
    ['run', 'tools/release/build-binary.ts', '--outdir', outDir],
    { cwd: repoRoot },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `build-binary.ts failed (exit ${result.status}${
        result.error === undefined ? '' : `, ${result.error.message}`
      }):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

export interface EnsureBinaryBuiltOptions {
  /**
   * The build step. It must write the artifact into `outDir` under the basename of the host
   * binary path. `outDir` is a scratch directory of this call. The default runs the real
   * `tools/release/build-binary.ts`. A test injects a fake, so it can exercise concurrency
   * without `bun`.
   */
  readonly runBuild?: (repoRoot: string, outDir: string) => void | Promise<void>;
  /** `ensureBinaryBuilt` passes it to `withBuildLock`. A test uses it for short timeouts. */
  readonly lockOptions?: BuildLockOptions;
}

/**
 * Builds the host binary when it is absent or older than its inputs, and returns its path.
 *
 * The lock file sits beside the binary in `dist/bin`. The function checks freshness again under
 * the lock, because another process can finish the build during the wait. The build writes to a
 * scratch directory, and one rename on the same volume puts the binary in place. So a reader sees
 * the old complete binary or the new one, and never a partial file.
 */
export async function ensureBinaryBuilt(
  repoRoot: string,
  options: EnsureBinaryBuiltOptions = {},
): Promise<BinaryBuildResult> {
  const binaryPath = hostBinaryPath(repoRoot);

  if (isBinaryFresh(binaryPath, computeSrcNewest(repoRoot))) {
    return { binaryPath, rebuilt: false };
  }

  const lockPath = `${binaryPath}.lock`;

  return withBuildLock(
    lockPath,
    async () => {
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
        fs.renameSync(builtPath, binaryPath);
        return { binaryPath, rebuilt: true };
      } finally {
        rmrf(outDir);
      }
    },
    options.lockOptions,
  );
}

export interface Fixture {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly stateDir: string;
}

/**
 * Starts the binary as `exarchos mcp` with a temporary `WORKFLOW_STATE_DIR` and connects an MCP
 * stdio client to it. When the connect fails, the function removes the temp directory before it
 * throws again, so a failed run leaves no `exarchos-compiled-test-*` directory.
 */
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
    await rmrfAsync(stateDir).catch(() => undefined);
    throw error;
  }
}

/** Closes the client and removes the state directory. It ignores an error in either step. */
export async function closeFixture(fx: Fixture): Promise<void> {
  try {
    await fx.client.close();
  } catch {
  }
  try {
    await rmrfAsync(fx.stateDir);
  } catch {
  }
}

/**
 * Why {@link deliverCrash} refused a request. The process tier needs real faults: a process that
 * stops and leaves the disk as the kernel last saw it. An in-process `throw` runs each `catch` and
 * `finally`, so it proves the error handler and nothing about a crash. An arm that uses one still
 * passes, so the harness refuses it.
 *
 * - `IN_PROCESS_INJECTION`: the request asked for an in-process fault.
 * - `SELF_TARGETED`: the pid is the test process itself.
 * - `NOT_A_LIVE_PROCESS`: no live OS process has that pid, so the kill does nothing.
 */
export type CrashRejectionCode =
  | 'IN_PROCESS_INJECTION'
  | 'SELF_TARGETED'
  | 'NOT_A_LIVE_PROCESS';

/** The typed refusal that {@link deliverCrash} throws. */
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
 * A crash that an arm asks the harness to deliver.
 *
 * - `sigkill`: the real fault, a `SIGKILL` to a live child pid.
 * - `in-process-throw`: rejected. An exception thrown inside the test process.
 * - `in-process-abort`: rejected. Any other in-process abort or unwind hook.
 *
 * The union names the in-process kinds on purpose. A request for one then reaches the harness and
 * fails at runtime with a reason, so a test can assert the refusal.
 */
export type CrashRequest =
  | { readonly kind: 'sigkill'; readonly pid: number | undefined }
  | { readonly kind: 'in-process-throw'; readonly inject: () => never }
  | { readonly kind: 'in-process-abort'; readonly inject: () => void };

/**
 * Delivers a real `SIGKILL` and returns the killed pid, or throws
 * {@link CrashInjectionRejectedError}. The refusal comes first, so the `inject` callback of a
 * rejected request never runs. On win32, Node maps `SIGKILL` to `TerminateProcess`, which is also
 * an unconditional kill: no handler, no `finally` and no flush run.
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
 * Waits until `pid` is gone, so an arm does not read the disk while the killed process is still
 * alive. A pid that survives the timeout throws, because a failed kill is a broken fixture.
 */
export async function awaitProcessDeath(pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await sleep(10);
  }
  throw new Error(`pid ${pid} was still alive ${timeoutMs}ms after SIGKILL`);
}

