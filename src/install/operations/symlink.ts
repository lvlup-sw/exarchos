/**
 * Symlink operations for dev-mode installation.
 *
 * In dev mode, the installer links `~/.claude/` back into the Exarchos repo. Edits to commands, skills,
 * and rules then take effect with no new install.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Outcome of a createSymlink operation. */
export type SymlinkResult = 'created' | 'skipped' | 'backed_up' | 'relinked';

/** Outcome of a removeSymlink operation. */
export type RemoveResult = 'removed' | 'skipped';

/**
 * Creates a symbolic link at `target` that points to `source`.
 *
 * - Target missing: creates the parent directories and the link.
 * - Target is a link to `source`: skips.
 * - Target is a directory: renames it to `<name>.backup.<timestamp>`, then links.
 * - Any other target (a link to a different path, or a file): removes it, then links.
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
  }

  if (stat) {
    if (stat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(target);
      if (currentTarget === source) {
        return 'skipped';
      }
      fs.unlinkSync(target);
      fs.symlinkSync(source, target);
      return 'relinked';
    }

    if (stat.isDirectory()) {
      const timestamp = Date.now();
      const baseName = path.basename(target);
      const parentDir = path.dirname(target);
      const backupName = `${baseName}.backup.${timestamp}`;
      const backupPath = path.join(parentDir, backupName);
      fs.renameSync(target, backupPath);
      fs.symlinkSync(source, target);
      return 'backed_up';
    }

    fs.unlinkSync(target);
    fs.symlinkSync(source, target);
    return 'relinked';
  }

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
 * Classifies each expected link as healthy, broken, or missing.
 *
 * A link is broken when it points to the wrong source, or when its source does not exist. A link is
 * missing when the target path does not exist or is not a symlink.
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

    const actualTarget = fs.readlinkSync(target);
    if (actualTarget !== expectedSource) {
      broken.push(target);
      continue;
    }

    if (!fs.existsSync(expectedSource)) {
      broken.push(target);
      continue;
    }

    healthy.push(target);
  }

  return { healthy, broken, missing };
}
