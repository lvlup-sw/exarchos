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
 * `child_process.execFile`/`execFileSync` (no shell) cannot launch a `.cmd` —
 * it looks for `<name>.exe`, which doesn't exist — so a bare `npm`/`npx`/… name
 * must be resolved to its `.cmd` form on win32. Native binaries (`git`,
 * `cargo`, …) are real `.exe`s and need no remapping.
 */
const WINDOWS_CMD_SHIMS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'corepack']);

/**
 * Resolve a command name to the platform-appropriate executable for
 * `execFile`/`execFileSync` (which spawn without a shell). On Windows, a bare
 * package-manager / task-runner name in {@link WINDOWS_CMD_SHIMS} is mapped to
 * its `.cmd` shim; everything else — native binaries, explicit paths, names
 * that already carry an extension — is returned unchanged. No-op off Windows.
 *
 * `platform` is injectable so the win32 branch is exercisable on the Linux CI
 * host. (#1623 — follow-up to the #1620 Windows-portability work.)
 */
export function resolveExecutable(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return command;
  // A path or an already-extensioned/explicit binary is taken as-is.
  if (command.includes('/') || command.includes('\\') || command.includes('.')) {
    return command;
  }
  return WINDOWS_CMD_SHIMS.has(command) ? `${command}.cmd` : command;
}
