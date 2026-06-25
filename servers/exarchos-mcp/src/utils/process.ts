import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';

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
