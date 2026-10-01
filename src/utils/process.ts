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
 * True when a process with `pid` is alive. `process.kill(pid, 0)` checks existence
 * and permission without a signal. A throw (`ESRCH` or `EPERM`) counts as not
 * alive, because a PID that this user cannot signal belongs to another process.
 *
 * Caveats: `kill(pid, 0)` sees only the current PID namespace, so lock attribution
 * across containers that share a state directory is not reliable. The kernel also
 * reuses PIDs, so a stale lock can name an unrelated live process.
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
 * spawn fine without a shell. `resolveIntegrationCommand` can spawn a bare `bun`,
 * so the list includes `bun` and `bunx`.
 */
const WINDOWS_CMD_SHIMS = new Set([
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'corepack',
  'bun',
  'bunx',
]);

/**
 * True when `command` is a package-manager shim that needs a shell to launch: a
 * bare shim name on win32. A name with a path separator or a dot launches as given.
 * `platform` is injectable, so the win32 branch is testable on a Linux host.
 */
export function needsWindowsShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false;
  if (command.includes('/') || command.includes('\\') || command.includes('.')) {
    return false;
  }
  return WINDOWS_CMD_SHIMS.has(command);
}

/**
 * `execFileSync` that launches Windows package-manager shims.
 *
 * On win32 a bare shim name (see {@link needsWindowsShell}) runs through `cmd.exe`
 * with `shell: true`, which resolves the `.cmd` through `PATHEXT`. Arguments with
 * whitespace get double quotes. All other commands pass through to `execFileSync`,
 * which returns stdout and throws on a non-zero exit.
 *
 * Arguments must be trusted (fixed subcommands, resolved file paths). With
 * `shell: true`, an argument with shell metacharacters can inject commands.
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
 * `spawnSync` that launches Windows package-manager shims, the non-throwing
 * sibling of {@link runCommandSync}. It returns the full `SpawnSyncReturns`, for
 * callers that branch on the exit code. The win32 shim handling is the same as
 * in {@link runCommandSync}.
 *
 * Arguments must be trusted (fixed subcommands, resolved file paths). With
 * `shell: true`, an argument with shell metacharacters can inject commands.
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

/**
 * Pure-data spawn request: `command`, `args`, `cwd`, `env`, and an optional
 * `stdio` mode. It has no function fields, so no per-harness behavior can hide in
 * it. `stdio` defaults to `'inherit'`, so the operator sees the supervised harness.
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
 * Handle over a live supervised child. It exposes only what a supervisor needs:
 * `pid` for liveness ({@link isPidAlive}), an `exit` promise, and `kill`. It does
 * not expose the raw streams.
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
 * Resolves a bare win32 command name to its shim path on disk, for example
 * `myharness` to `C:\\…\\myharness.cmd`. Tests inject a fake on the POSIX host.
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
 * Quote one token per the MS C runtime `CommandLineToArgvW` rules, so the argv
 * parser of the target program recovers it verbatim. Only backslashes before a
 * `"` and a trailing run are doubled. A token that needs no quotes returns unchanged.
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
 * Escape one argument for both cmd.exe and the `CommandLineToArgvW` parser of the
 * target program. This blocks the CVE-2024-27980 `.cmd`/`.bat` argument injection.
 * A metacharacter argument such as `a & b` reaches the child literally.
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
 * Plan a cross-OS spawn. This is the pure core of {@link spawnHarnessChild}, so
 * the win32 logic is testable on a POSIX host.
 *
 * - POSIX: launch `command` directly with `shell: false`.
 * - win32 `.cmd`/`.bat`: `spawn` cannot run a batch shim (`EINVAL`), and `shell: true`
 *   opens injection. So run the resolved shim through `cmd.exe /d /c` with
 *   `windowsVerbatimArguments` and each token escaped by {@link escapeForCmd}.
 * - win32 `.ps1`: run `powershell.exe -File <resolved>`. Node quoting is safe there.
 * - win32 `.exe` or explicit path: launch the resolved binary directly.
 *
 * An unresolvable bare command on win32 returns `{ ok: false }` with a {@link SpawnError}.
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
 * Launch a long-lived, supervised harness CLI child on win32 or POSIX, with no
 * shell-injection hazard. Resolves once the child spawns, to a {@link ChildHandle}.
 * A command that cannot launch rejects with a {@link SpawnError} and never throws.
 * See {@link resolveSpawnPlan} for the launch strategy per platform.
 *
 * An `'error'` after `'spawn'` can arrive without an `'exit'`. Then `exit` resolves
 * with a null code and signal, so a supervisor that awaits `exit` does not hang.
 * The first terminal wins.
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
        settled = true;
        reject(new SpawnError('SPAWN_FAILED', `failed to spawn '${request.command}'`, err));
        return;
      }
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
