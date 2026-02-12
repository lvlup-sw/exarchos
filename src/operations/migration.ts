/**
 * V1 migration detection and execution for the Exarchos installer.
 *
 * The v1 installer created symlinks from `~/.claude/` directly into the
 * Exarchos repo (skills, commands, rules, scripts, settings.json). The
 * v2 installer uses either copy (standard) or symlink (dev) mode with
 * a config file. This module detects v1 installs and cleanly removes
 * old symlinks before v2 installation proceeds.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { removeSymlink } from './symlink.js';

/** Result of detecting a v1 installation. */
export interface V1Detection {
  /** Whether a v1 installation was detected. */
  readonly isV1: boolean;
  /** Absolute path to the Exarchos repo (resolved from symlink), or null. */
  readonly repoPath: string | null;
}

/** Result of running a v1 migration. */
export interface MigrationResult {
  /** Absolute paths of symlinks that were removed. */
  readonly removedSymlinks: string[];
  /** Absolute paths of non-Exarchos files/dirs that were preserved. */
  readonly preservedFiles: string[];
  /** Absolute path to the Exarchos repo (resolved from symlink), or null. */
  readonly repoPath: string | null;
}

/** Known Exarchos v1 symlink names within ~/.claude/. */
const V1_SYMLINK_NAMES = ['skills', 'commands', 'rules', 'scripts', 'settings.json'] as const;

/**
 * Detect whether a v1 Exarchos installation exists.
 *
 * Checks if `~/.claude/skills` is a symbolic link, which is the
 * primary indicator of a v1 install (v2 standard mode copies files,
 * v2 dev mode also creates symlinks but writes an exarchos.json config).
 *
 * @param claudeHome - Absolute path to the `~/.claude/` directory.
 * @returns Detection result with v1 flag and resolved repo path.
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

  // It's a symlink — resolve the repo root
  const repoPath = getV1RepoPath(claudeHome);
  return { isV1: true, repoPath };
}

/**
 * Resolve the Exarchos repo root from a v1 symlink.
 *
 * Reads the `skills` symlink target and resolves its parent directory
 * as the repo root.
 *
 * @param claudeHome - Absolute path to the `~/.claude/` directory.
 * @returns The absolute repo root path, or null if no symlink exists.
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
  // The symlink target is e.g. /path/to/exarchos/skills
  // The repo root is the parent of that
  return path.dirname(symlinkTarget);
}

/**
 * Migrate a v1 installation by removing Exarchos symlinks.
 *
 * Removes all known v1 symlinks (skills, commands, rules, scripts,
 * settings.json) while preserving any non-Exarchos files and directories
 * in `~/.claude/`.
 *
 * @param claudeHome - Absolute path to the `~/.claude/` directory.
 * @returns Migration result with removed and preserved paths.
 */
export function migrateV1(claudeHome: string): MigrationResult {
  const repoPath = getV1RepoPath(claudeHome);
  const removedSymlinks: string[] = [];
  const preservedFiles: string[] = [];

  // Remove known Exarchos v1 symlinks
  for (const name of V1_SYMLINK_NAMES) {
    const targetPath = path.join(claudeHome, name);
    const result = removeSymlink(targetPath);
    if (result === 'removed') {
      removedSymlinks.push(targetPath);
    }
  }

  // Enumerate remaining items to report preserved files
  try {
    const entries = fs.readdirSync(claudeHome, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(claudeHome, entry.name);
      // Skip anything we just removed
      if (removedSymlinks.includes(entryPath)) {
        continue;
      }
      preservedFiles.push(entryPath);
    }
  } catch {
    // If claudeHome doesn't exist or can't be read, nothing to preserve
  }

  return { removedSymlinks, preservedFiles, repoPath };
}
