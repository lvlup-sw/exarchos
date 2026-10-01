/**
 * Detect and remove a v1 Exarchos install.
 * A v1 install has symbolic links from `~/.claude/` into the Exarchos repo. This module removes them before the v2 install.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { removeSymlink } from './symlink.js';

/** Result of detecting a v1 installation. */
export interface V1Detection {
  /** Whether a v1 installation was detected. */
  readonly isV1: boolean;
  /** The Exarchos repo path from {@link getV1RepoPath}, or null. */
  readonly repoPath: string | null;
}

/** Result of running a v1 migration. */
export interface MigrationResult {
  /** Absolute paths of symlinks that were removed. */
  readonly removedSymlinks: string[];
  /** Absolute paths of non-Exarchos files/dirs that were preserved. */
  readonly preservedFiles: string[];
  /** The Exarchos repo path from {@link getV1RepoPath}, or null. */
  readonly repoPath: string | null;
}

/** Known Exarchos v1 symlink names within ~/.claude/. */
const V1_SYMLINK_NAMES = ['skills', 'commands', 'rules', 'scripts', 'settings.json'] as const;

/**
 * Detect a v1 install. The only signal is that `skills` in `claudeHome` is a symbolic link.
 *
 * @param claudeHome - Absolute path to the `~/.claude/` directory.
 */
export function detectV1Install(claudeHome: string): V1Detection {
  const skillsPath = path.join(claudeHome, 'skills');

  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(skillsPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { isV1: false, repoPath: null };
    }
    throw err;
  }

  if (!stat.isSymbolicLink()) {
    return { isV1: false, repoPath: null };
  }

  const repoPath = getV1RepoPath(claudeHome);
  return { isV1: true, repoPath };
}

/**
 * Return the parent directory of the `skills` symlink target as the repo root.
 * The result is relative when the link target is relative. It is null when `skills` is absent or is not a symbolic link.
 *
 * @param claudeHome - Absolute path to the `~/.claude/` directory.
 */
export function getV1RepoPath(claudeHome: string): string | null {
  const skillsPath = path.join(claudeHome, 'skills');

  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(skillsPath);
  } catch {
    return null;
  }

  if (!stat.isSymbolicLink()) {
    return null;
  }

  const symlinkTarget = fs.readlinkSync(skillsPath);
  return path.dirname(symlinkTarget);
}

/**
 * Remove each known v1 name in `claudeHome` that is a symbolic link, and list each other entry as preserved.
 * When `claudeHome` cannot be read, the preserved list is empty.
 *
 * @param claudeHome - Absolute path to the `~/.claude/` directory.
 */
export function migrateV1(claudeHome: string): MigrationResult {
  const repoPath = getV1RepoPath(claudeHome);
  const removedSymlinks: string[] = [];
  const preservedFiles: string[] = [];

  for (const name of V1_SYMLINK_NAMES) {
    const targetPath = path.join(claudeHome, name);
    const result = removeSymlink(targetPath);
    if (result === 'removed') {
      removedSymlinks.push(targetPath);
    }
  }

  try {
    const entries = fs.readdirSync(claudeHome, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(claudeHome, entry.name);
      if (removedSymlinks.includes(entryPath)) {
        continue;
      }
      preservedFiles.push(entryPath);
    }
  } catch {
  }

  return { removedSymlinks, preservedFiles, repoPath };
}
