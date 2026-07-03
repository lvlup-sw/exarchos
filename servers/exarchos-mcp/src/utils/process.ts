import {
  execFileSync,
  spawn,
  spawnSync,
  type ExecFileSyncOptions,
  type SpawnOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Check if a process with the given PID is alive.
 *
 * Implementation: `process.kill(pid, 0)` sends signal 0, which performs the
 * kernel-level permission and existence check without actually delivering a
 * signal. Throwing means the PID does not exist (ESRCH) or the caller lacks
 * permission to signal it (EPERM); in both cases we treat the holder as
 * not-alive, which is safe because a permission failure means the PID was
 * reassigned to a process the current user cannot manage anyway.
 *
 * Known caveats (F-022-5):
 *
 *   1. PID-namespace ambiguity (Docker / containers). `kill(pid, 0)` is
 *      always scoped to the *current* namespace. If the event-store state
 *      directory is shared across containers via a host-mounted volume,
 *      a PID written by a process in container A will be interpreted in
 *      container B's PID namespace — where it either doesn't exist or
 *      matches an unrelated process. Lock attribution is therefore
 *      unreliable across containers and should not be relied on.
 *
 *   2. PID reuse on busy systems. Linux recycles PIDs once the kernel's
 *      PID counter wraps (default max_pid is 32768, higher on 64-bit).
 *      A stale lock file left behind by a crashed holder can have its PID
 *      reassigned to an unrelated live process, which this check will
 *      misattribute as "still alive" and refuse to reclaim.
 *
 * Future iterations should pair the PID with a start-time fingerprint
 * (/proc/<pid>/stat starttime on Linux) or an argv0 match to detect the
 * reuse case, and embed a container/hostname identifier for the namespace
 * case.
 */
export function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Package managers / task runners that ship as `.cmd` batch shims on Windows.
 * Since the CVE-2024-27980 fix (Node >= 20.12.2), `child_process.execFile*`
 * refuses to launch a `.cmd`/`.bat` directly — it throws `EINVAL` unless
 * `shell: true` is set. Native binaries (`git`, `cargo`, …) are real `.exe`s and
 * spawn fine without a shell.
 */
const WINDOWS_CMD_SHIMS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'corepack']);

/**
 * Whether `command` is a package-manager shim that needs a shell to launch on
 * the given platform — true only for a bare shim name (no path / extension) on
 * win32. Pure and platform-injectable so the win32 branch is unit-testable on
 * the Linux CI host. (#1623)
 */
export function needsWindowsShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false;
  // A path or an already-extensioned/explicit binary is launched as given.
  if (command.includes('/') || command.includes('\\') || command.includes('.')) {
    return false;
  }
  return WINDOWS_CMD_SHIMS.has(command);
}

/**
 * `execFileSync` that launches Windows package-manager shims correctly.
 *
 * On win32 a bare `npm`/`npx`/… resolves to a `.cmd` shim that `execFile` can't
 * start without a shell (CVE-2024-27980 / Node >= 20.12.2 -> `EINVAL`). For
 * those commands this runs through `cmd.exe` (`shell: true`, which resolves the
 * `.cmd` via `PATHEXT`) and double-quotes whitespace-bearing args so paths
 * survive the shell's tokenization. Everywhere else (and off Windows) it is a
 * thin pass-through, preserving `execFileSync` semantics — returns stdout,
 * throws on a non-zero exit.
 *
 * Args MUST be trusted (fixed subcommands / resolved file paths): with
 * `shell: true`, an arg containing shell metacharacters could inject. (#1623)
 */
export function runCommandSync(
  command: string,
  args: readonly string[],
  options: ExecFileSyncOptions = {},
): string | Buffer {
  if (needsWindowsShell(command)) {
    const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
    return execFileSync(command, quoted, { ...options, shell: true });
  }
  return execFileSync(command, args as string[], options);
}

/**
 * `spawnSync` that launches Windows package-manager shims correctly — the
 * non-throwing sibling of {@link runCommandSync}.
 *
 * Returns the full `SpawnSyncReturns` (status / stdout / stderr / error) instead
 * of throwing on a non-zero exit, for callers that branch on the exit code
 * rather than on a thrown error. The win32 `.cmd`-shim handling is identical to
 * `runCommandSync`: a bare `npm`/`npx`/… is launched through `cmd.exe`
 * (`shell: true`, resolved via `PATHEXT`) with whitespace-bearing args quoted;
 * everything else (and all of POSIX) is a thin pass-through preserving
 * `spawnSync` semantics.
 *
 * Args MUST be trusted (fixed subcommands / resolved file paths): with
 * `shell: true`, an arg containing shell metacharacters could inject. (#1623)
 */
export function spawnCommandSync(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
  if (needsWindowsShell(command)) {
    const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
    return spawnSync(command, quoted, { ...options, shell: true });
  }
  return spawnSync(command, args as string[], options);
}

// ---------------------------------------------------------------------------
// Async, long-lived, cross-OS harness spawn (DR-4 / DR-8).
//
// One interface launches a supervised harness CLI child across win32 and POSIX
// with NO shell-injection hazard. The distinction from the *sync* helpers above
// is intentional: those are short-lived, throw/return-on-exit command runners;
// this is a long-lived child the launcher supervises (pid / exit / kill).
// ---------------------------------------------------------------------------

/**
 * Pure-data spawn request (DR-4): a closed shape of `command / args / cwd / env`
 * — string / array / record only, **no function-typed fields / behavior hooks**,
 * so no per-harness behavior can hide inside a descriptor. `stdio` is an optional
 * mode string (still pure data), defaulting to `'inherit'` so the operator sees
 * the supervised harness.
 */
export interface AsyncSpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdio?: 'inherit' | 'ignore' | 'pipe';
}

/** Terminal outcome of a supervised child. */
export interface SpawnExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Handle over a live supervised child. Exposes only what a supervisor needs —
 * `pid` for liveness attribution ({@link isPidAlive}), an `exit` promise for the
 * terminal, and `kill` for teardown — deliberately NOT the raw streams.
 */
export interface ChildHandle {
  readonly pid: number | undefined;
  readonly exit: Promise<SpawnExit>;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Structured, non-throwing failure surface for the spawn primitive. */
export type SpawnErrorCode = 'COMMAND_NOT_FOUND' | 'SPAWN_FAILED';

/**
 * A structured spawn failure. Unknown/unresolvable commands surface as a
 * *rejected promise* carrying this (a caught, coded outcome) rather than an
 * uncaught synchronous throw.
 */
export class SpawnError extends Error {
  readonly code: SpawnErrorCode;
  constructor(code: SpawnErrorCode, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'SpawnError';
    this.code = code;
  }
}

/**
 * Minimal structural view of a spawned child — the seam tests inject a fake
 * over. `node:child_process`'s `ChildProcess` satisfies this structurally, so
 * the default path needs no cast.
 */
export interface SpawnedChild {
  readonly pid?: number | undefined;
  on(event: 'spawn', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** The concrete `(file, args, options)` handed to `child_process.spawn`. */
export interface SpawnPlan {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

/** Pure result of planning a spawn: a launchable plan or a structured error. */
export type SpawnPlanResult =
  | { readonly ok: true; readonly plan: SpawnPlan }
  | { readonly ok: false; readonly error: SpawnError };

/**
 * Resolves a bare win32 command name to its real on-disk shim path (e.g.
 * `myharness` → `C:\\…\\myharness.cmd`). Injectable so the win32 resolution
 * branch is unit-testable on the POSIX CI host with a fake resolver.
 */
export type Win32CommandResolver = (command: string) => string | null;

/** Injectable seams for {@link spawnHarnessChild} (default → real spawn / host platform). */
export interface SpawnDeps {
  readonly spawn?: (file: string, args: readonly string[], options: SpawnOptions) => SpawnedChild;
  readonly platform?: NodeJS.Platform;
  readonly resolveWin32Command?: Win32CommandResolver;
}

/** True when `command` is an explicit path or already carries an extension. */
function commandHasPathOrExt(command: string): boolean {
  return command.includes('/') || command.includes('\\') || path.extname(command) !== '';
}

/**
 * Quote a single token per the MS C runtime `CommandLineToArgvW` rules so the
 * *target program's* argv parser recovers it verbatim: only backslashes that
 * precede a `"` (and a trailing run) are doubled; a token needing no quoting is
 * returned unchanged.
 */
function quoteArgvToken(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  out += '\\'.repeat(backslashes * 2) + '"';
  return out;
}

/**
 * Caret-escape every character cmd.exe treats as special so it is passed
 * through to the program verbatim instead of being interpreted. cmd processes
 * the line *before* the program's argv parser sees it, so this layers on top of
 * {@link quoteArgvToken}.
 */
function caretEscapeForCmd(token: string): string {
  return token.replace(/[()%!^"<>&|]/g, (ch) => `^${ch}`);
}

/**
 * Escape one argument so it survives BOTH cmd.exe's parsing and the target
 * program's `CommandLineToArgvW` parsing — the two-layer defense against the
 * CVE-2024-27980 `.cmd`/`.bat` argument-injection class. A metacharacter arg
 * (`a & b`, `"; rm -rf /"`) reaches the child literally; nothing is interpreted
 * by the shell.
 */
function escapeForCmd(arg: string): string {
  return caretEscapeForCmd(quoteArgvToken(arg));
}

/**
 * Default win32 shim resolver: probe each `PATH` directory with each `PATHEXT`
 * extension and return the first hit. Only reached on win32 for a bare command
 * name (path/extensioned commands are launched as given), so it is exercised by
 * the windows-latest lane, not the POSIX host.
 */
function defaultResolveWin32Command(command: string): string | null {
  const pathExt = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD;.PS1')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  const pathDirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const base = path.join(dir, command);
    if (existsSync(base)) return base;
    for (const ext of pathExt) {
      const candidate = base + ext;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Plan a cross-OS spawn — the pure core of {@link spawnHarnessChild}, split out
 * so the win32 shim-resolution logic is unit-testable on the POSIX CI host.
 *
 * - **POSIX** — launch `command` directly with `shell: false`; Node passes the
 *   args array to the child verbatim (no interpolation).
 * - **win32 `.cmd`/`.bat`** — Node's `spawn` cannot exec a batch shim directly
 *   (CVE-2024-27980 / Node ≥ 20.12.2 → `EINVAL`), and `shell: true` re-opens the
 *   injection hole. So resolve the shim to its real path and run it through
 *   `cmd.exe /d /c` with `windowsVerbatimArguments: true` and each token escaped
 *   for both cmd.exe and `CommandLineToArgvW` (see {@link escapeForCmd}) — never
 *   `shell: true`.
 * - **win32 `.ps1`** — invoke `powershell.exe -File <resolved> …args`; PowerShell
 *   is a real `.exe`, so Node's own arg quoting is safe (no cmd.exe layer).
 * - **win32 `.exe`/explicit path** — launch the resolved binary directly.
 *
 * An unresolvable bare command on win32 → `{ ok: false }` with a structured
 * {@link SpawnError} rather than a throw.
 */
export function resolveSpawnPlan(
  request: AsyncSpawnRequest,
  platform: NodeJS.Platform = process.platform,
  resolveWin32Command: Win32CommandResolver = defaultResolveWin32Command,
): SpawnPlanResult {
  const baseOptions: SpawnOptions = {
    cwd: request.cwd,
    env: request.env ? { ...process.env, ...request.env } : process.env,
    stdio: request.stdio ?? 'inherit',
    shell: false,
    windowsHide: true,
  };

  if (platform !== 'win32') {
    return {
      ok: true,
      plan: { file: request.command, args: [...request.args], options: baseOptions },
    };
  }

  const resolved = commandHasPathOrExt(request.command)
    ? request.command
    : resolveWin32Command(request.command);
  if (!resolved) {
    return {
      ok: false,
      error: new SpawnError(
        'COMMAND_NOT_FOUND',
        `cannot resolve command '${request.command}' on the win32 PATH`,
      ),
    };
  }

  const ext = path.extname(resolved).toLowerCase();

  if (ext === '.cmd' || ext === '.bat') {
    const comspec = process.env['ComSpec'] || 'cmd.exe';
    const body = [escapeForCmd(resolved), ...request.args.map(escapeForCmd)].join(' ');
    return {
      ok: true,
      plan: {
        file: comspec,
        args: ['/d', '/c', body],
        options: { ...baseOptions, windowsVerbatimArguments: true },
      },
    };
  }

  if (ext === '.ps1') {
    return {
      ok: true,
      plan: {
        file: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          resolved,
          ...request.args,
        ],
        options: baseOptions,
      },
    };
  }

  return {
    ok: true,
    plan: { file: resolved, args: [...request.args], options: baseOptions },
  };
}

function defaultSpawn(
  file: string,
  args: readonly string[],
  options: SpawnOptions,
): SpawnedChild {
  return spawn(file, args as string[], options);
}

/**
 * Launch a long-lived, supervised harness CLI child across win32 and POSIX
 * through ONE interface (DR-4 / DR-8), with no shell-injection hazard.
 *
 * Resolves once the child has spawned, to a {@link ChildHandle} exposing `pid`,
 * an `exit` promise, and `kill`. A command that cannot be resolved/launched
 * rejects with a structured {@link SpawnError} — never an uncaught throw. See
 * {@link resolveSpawnPlan} for the per-platform launch strategy.
 */
export function spawnHarnessChild(
  request: AsyncSpawnRequest,
  deps: SpawnDeps = {},
): Promise<ChildHandle> {
  const spawnFn = deps.spawn ?? defaultSpawn;
  const platform = deps.platform ?? process.platform;
  const resolveWin32Command = deps.resolveWin32Command ?? defaultResolveWin32Command;

  const planResult = resolveSpawnPlan(request, platform, resolveWin32Command);
  if (!planResult.ok) {
    return Promise.reject(planResult.error);
  }
  const { plan } = planResult;

  return new Promise<ChildHandle>((resolve, reject) => {
    let child: SpawnedChild;
    try {
      child = spawnFn(plan.file, plan.args, plan.options);
    } catch (err) {
      reject(new SpawnError('SPAWN_FAILED', `failed to spawn '${request.command}'`, err));
      return;
    }

    let settled = false;
    // Capture the `exit` resolver so a POST-settle `'error'` (see below) can
    // still complete the terminal — otherwise a child that emits `'error'` after
    // `'spawn'` without ever emitting `'exit'` leaves `exit` pending forever and
    // hangs any supervisor awaiting `child.exit`.
    let exitSettled = false;
    let resolveExit!: (value: SpawnExit) => void;
    const exit = new Promise<SpawnExit>((res) => {
      resolveExit = res;
    });
    child.on('exit', (code, signal) => {
      exitSettled = true;
      resolveExit({ code, signal });
    });

    child.on('error', (err) => {
      if (!settled) {
        // Pre-settle error: the spawn never started — reject with a coded error.
        settled = true;
        reject(new SpawnError('SPAWN_FAILED', `failed to spawn '${request.command}'`, err));
        return;
      }
      // Post-settle error: the child already spawned, so `spawn` resolved the
      // handle. A later `'error'` (e.g. an async I/O failure) may mean `'exit'`
      // never fires — resolve `exit` with a synthetic terminal so the supervisor
      // (runLifecycle's `await child.exit`) never blocks. First terminal wins.
      if (!exitSettled) {
        exitSettled = true;
        resolveExit({ code: null, signal: null });
      }
    });

    child.on('spawn', () => {
      if (settled) return;
      settled = true;
      resolve({
        pid: child.pid,
        exit,
        kill: (signal) => child.kill(signal),
      });
    });
  });
}
