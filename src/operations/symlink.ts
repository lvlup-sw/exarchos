/**
 * Symlink operations for dev-mode installation.
 *
 * In dev mode the installer creates symbolic links from `~/.claude/`
 * back into the Exarchos repo so that edits to commands, skills, and
 * rules take effect immediately without re-running the installer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Outcome of a createSymlink operation. */
export type SymlinkResult = 'created' | 'skipped' | 'backed_up' | 'relinked';

/** Outcome of a removeSymlink operation. */
export type RemoveResult = 'removed' | 'skipped';

/**
 * Create a symbolic link from `target` pointing to `source`.
 *
 * Handles four scenarios:
 * - Target does not exist: creates the link.
 * - Target is a symlink pointing to the correct source: skips.
 * - Target is a symlink pointing elsewhere: removes and relinks.
 * - Target is a real directory: renames to `<name>.backup.<timestamp>` then links.
 *
 * @param source - Absolute path to the link destination (the actual content).
 * @param target - Absolute path where the symlink will be created.
 * @returns The action taken.
 */
export function createSymlink(source: string, target: string): SymlinkResult {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(target);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw err;
    }
    // Target does not exist — fall through to create
  }

  if (stat) {
    if (stat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(target);
      if (currentTarget === source) {
        return 'skipped';
      }
      // Wrong target — remove and relink
      fs.unlinkSync(target);
      fs.symlinkSync(source, target);
      return 'relinked';
    }

    if (stat.isDirectory()) {
      // Back up existing directory
      const timestamp = Date.now();
      const baseName = path.basename(target);
      const parentDir = path.dirname(target);
      const backupName = `${baseName}.backup.${timestamp}`;
      const backupPath = path.join(parentDir, backupName);
      fs.renameSync(target, backupPath);
      fs.symlinkSync(source, target);
      return 'backed_up';
    }

    // Target is a regular file or other — remove and link
    fs.unlinkSync(target);
    fs.symlinkSync(source, target);
    return 'relinked';
  }

  // Target does not exist — create parent dirs if needed
  const parentDir = path.dirname(target);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.symlinkSync(source, target);
  return 'created';
}

/**
 * Remove a symbolic link at the given target path.
 *
 * Only removes the entry if it is actually a symlink. Regular files
 * and directories are left untouched. Missing targets are silently
 * skipped.
 *
 * @param target - Absolute path to the symlink to remove.
 * @returns The action taken.
 */
export function removeSymlink(target: string): RemoveResult {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(target);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return 'skipped';
    }
    throw err;
  }

  if (stat.isSymbolicLink()) {
    fs.unlinkSync(target);
    return 'removed';
  }

  return 'skipped';
}

/**
 * Health report for a set of expected symlinks.
 */
export interface SymlinkHealthReport {
  /** Target paths whose symlinks exist and point to the expected source. */
  readonly healthy: string[];
  /** Target paths whose symlinks exist but are broken (source missing or wrong target). */
  readonly broken: string[];
  /** Target paths where no symlink exists at all. */
  readonly missing: string[];
}

/**
 * Validate a set of expected symbolic links.
 *
 * Checks each expected symlink target to determine whether it exists,
 * is a symlink, and points to the expected source. Classifies each
 * entry as healthy, broken, or missing.
 *
 * A link is "broken" if:
 * - It is a symlink but its target (the source) no longer exists.
 * - It is a symlink pointing to the wrong source.
 *
 * A link is "missing" if:
 * - The target path does not exist at all.
 * - The target path exists but is not a symlink.
 *
 * @param expectedLinks - Map of target path to expected source path.
 * @returns A health report classifying each link.
 */
export function validateSymlinks(
  expectedLinks: Record<string, string>,
): SymlinkHealthReport {
  const healthy: string[] = [];
  const broken: string[] = [];
  const missing: string[] = [];

  for (const [target, expectedSource] of Object.entries(expectedLinks)) {
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(target);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        missing.push(target);
        continue;
      }
      throw err;
    }

    if (!stat.isSymbolicLink()) {
      missing.push(target);
      continue;
    }

    // It is a symlink — check if it points to the right place and source exists
    const actualTarget = fs.readlinkSync(target);
    if (actualTarget !== expectedSource) {
      broken.push(target);
      continue;
    }

    // Check that the source actually exists
    if (!fs.existsSync(expectedSource)) {
      broken.push(target);
      continue;
    }

    healthy.push(target);
  }

  return { healthy, broken, missing };
}
