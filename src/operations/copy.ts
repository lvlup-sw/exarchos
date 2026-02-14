/**
 * Content hash utilities for the Exarchos installer.
 *
 * Provides SHA-256 hashing for individual files and entire directory
 * trees. Used for drift detection — comparing installed file hashes
 * against the manifest to identify manual modifications.
 *
 * This module will be extended in later tasks (B1–B3) with copy and
 * symlink operations.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Compute the SHA-256 hex digest of a file's contents.
 *
 * @param filePath - Absolute or relative path to the file.
 * @returns Lowercase hex string (64 characters).
 * @throws If the file does not exist or cannot be read.
 */
export function computeFileHash(filePath: string): string {
  let content: Buffer;
  try {
    content = fs.readFileSync(filePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw err;
  }

  return createHash('sha256').update(content).digest('hex');
}

/**
 * Compute SHA-256 hashes for every visible file in a directory tree.
 *
 * Recursively walks the directory. Hidden files and directories
 * (names starting with `.`) are skipped. Keys in the returned record
 * are relative paths from `dirPath` using the platform path separator.
 *
 * @param dirPath - Absolute or relative path to the root directory.
 * @returns A record mapping relative file paths to their SHA-256 hex digests.
 */
export function computeDirectoryHashes(
  dirPath: string,
): Record<string, string> {
  const hashes: Record<string, string> = {};
  walkDirectory(dirPath, dirPath, hashes);
  return hashes;
}

/**
 * Result of copying a single file.
 */
export interface CopyResult {
  /** SHA-256 hex digest of the copied file's contents. */
  readonly hash: string;
  /** Number of bytes written to the target. */
  readonly bytesWritten: number;
}

/**
 * Copy a single file from source to target, computing its content hash.
 *
 * Creates parent directories of the target if they do not exist.
 * Overwrites the target if it already exists.
 *
 * @param source - Absolute or relative path to the source file.
 * @param target - Absolute or relative path to the target file.
 * @returns The content hash and byte count of the copied file.
 * @throws If the source file does not exist or cannot be read.
 */
export function copyFile(source: string, target: string): CopyResult {
  let content: Buffer;
  try {
    content = fs.readFileSync(source);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`File not found: ${source}`);
    }
    throw err;
  }

  const targetDir = path.dirname(target);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(target, content);

  const hash = createHash('sha256').update(content).digest('hex');
  return { hash, bytesWritten: content.length };
}

/**
 * Result of copying an entire directory tree.
 */
export interface CopyDirectoryResult {
  /** Map of relative file paths to their SHA-256 hex digests. */
  readonly hashes: Record<string, string>;
  /** Total number of files copied. */
  readonly fileCount: number;
  /** Total number of bytes written across all files. */
  readonly totalBytes: number;
}

/**
 * Recursively copy a directory tree from source to target.
 *
 * Creates the target directory and all subdirectories. Copies every file
 * (optionally filtered) and returns content hashes for all copied files.
 *
 * @param source - Absolute or relative path to the source directory.
 * @param target - Absolute or relative path to the target directory.
 * @param filter - Optional predicate to filter files by name. Only files
 *   whose name passes the filter are copied.
 * @returns Hashes, file count, and total bytes for all copied files.
 */
export function copyDirectory(
  source: string,
  target: string,
  filter?: (name: string) => boolean,
): CopyDirectoryResult {
  fs.mkdirSync(target, { recursive: true });

  const hashes: Record<string, string> = {};
  let fileCount = 0;
  let totalBytes = 0;

  copyDirectoryWalk(source, source, target, filter, hashes, (bytes) => {
    fileCount++;
    totalBytes += bytes;
  });

  return { hashes, fileCount, totalBytes };
}

/**
 * Recursive helper for copyDirectory.
 *
 * @param rootDir - The original source root (for computing relative paths).
 * @param currentDir - The current source directory being scanned.
 * @param targetRoot - The target root directory.
 * @param filter - Optional file name filter.
 * @param hashes - Accumulator for relative-path to hash mappings.
 * @param onFile - Callback invoked for each copied file with its byte size.
 */
function copyDirectoryWalk(
  rootDir: string,
  currentDir: string,
  targetRoot: string,
  filter: ((name: string) => boolean) | undefined,
  hashes: Record<string, string>,
  onFile: (bytes: number) => void,
): void {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    const srcPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, srcPath);
    const tgtPath = path.join(targetRoot, relativePath);

    if (entry.isDirectory()) {
      fs.mkdirSync(tgtPath, { recursive: true });
      copyDirectoryWalk(rootDir, srcPath, targetRoot, filter, hashes, onFile);
    } else if (entry.isFile()) {
      if (filter && !filter(entry.name)) {
        continue;
      }
      const result = copyFile(srcPath, tgtPath);
      hashes[relativePath] = result.hash;
      onFile(result.bytesWritten);
    }
  }
}

/**
 * Result of a smart (idempotent) single-file copy.
 */
export interface SmartCopyResult {
  /** What action was taken. */
  readonly action: 'created' | 'updated' | 'skipped' | 'removed';
  /** SHA-256 hex digest of the file after the operation (empty string if removed). */
  readonly hash: string;
}

/**
 * Result of a smart (idempotent) directory copy.
 */
export interface SmartCopyDirectoryResult {
  /** Number of newly created files. */
  readonly created: number;
  /** Number of updated (changed) files. */
  readonly updated: number;
  /** Number of unchanged files that were skipped. */
  readonly skipped: number;
  /** Number of files that existed in the target but not in the source. */
  readonly removed: number;
  /** Map of relative file paths to their current SHA-256 hex digests. */
  readonly hashes: Record<string, string>;
}

/**
 * Idempotent single-file copy that skips unchanged files.
 *
 * Compares the source file's hash against the provided existing hash.
 * If they match, the file is skipped. If the source does not exist
 * but an existing hash is provided, the file is reported as removed.
 *
 * @param source - Path to the source file (may not exist for removals).
 * @param target - Path to the target file.
 * @param existingHash - SHA-256 hex digest of the previously installed file.
 * @returns The action taken and the resulting file hash.
 */
export function smartCopy(
  source: string,
  target: string,
  existingHash?: string,
): SmartCopyResult {
  const sourceExists = fs.existsSync(source);

  // Source deleted — report removal
  if (!sourceExists) {
    if (existingHash) {
      return { action: 'removed', hash: '' };
    }
    // No source, no existing hash — nothing to do
    return { action: 'skipped', hash: '' };
  }

  // Compute source hash
  const sourceHash = computeFileHash(source);

  // Source unchanged — skip
  if (existingHash && sourceHash === existingHash) {
    return { action: 'skipped', hash: existingHash };
  }

  // Copy the file
  copyFile(source, target);

  // Determine action
  const action = existingHash ? 'updated' : 'created';
  return { action, hash: sourceHash };
}

/**
 * Idempotent directory copy that skips unchanged files and detects removals.
 *
 * Compares source files against existing hashes. Files that haven't
 * changed are skipped. Files present in `existingHashes` but absent
 * from the source are reported as removed.
 *
 * @param source - Path to the source directory.
 * @param target - Path to the target directory.
 * @param existingHashes - Map of relative paths to SHA-256 hex digests
 *   from the previous installation.
 * @param filter - Optional predicate to filter files by name.
 * @returns Summary of actions taken and updated hashes.
 */
export function smartCopyDirectory(
  source: string,
  target: string,
  existingHashes: Record<string, string>,
  filter?: (name: string) => boolean,
): SmartCopyDirectoryResult {
  fs.mkdirSync(target, { recursive: true });

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let removed = 0;
  const hashes: Record<string, string> = {};

  // Track which existing files we've seen in the source
  const seenPaths = new Set<string>();

  // Walk source directory and smart-copy each file
  smartCopyDirectoryWalk(
    source,
    source,
    target,
    filter,
    existingHashes,
    seenPaths,
    hashes,
    (action) => {
      switch (action) {
        case 'created': created++; break;
        case 'updated': updated++; break;
        case 'skipped': skipped++; break;
      }
    },
  );

  // Detect removals: files in existingHashes not found in source
  for (const relativePath of Object.keys(existingHashes)) {
    if (!seenPaths.has(relativePath)) {
      removed++;
    }
  }

  return { created, updated, skipped, removed, hashes };
}

/**
 * Recursive helper for smartCopyDirectory.
 */
function smartCopyDirectoryWalk(
  rootDir: string,
  currentDir: string,
  targetRoot: string,
  filter: ((name: string) => boolean) | undefined,
  existingHashes: Record<string, string>,
  seenPaths: Set<string>,
  hashes: Record<string, string>,
  onAction: (action: 'created' | 'updated' | 'skipped') => void,
): void {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    const srcPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, srcPath);

    if (entry.isDirectory()) {
      const tgtPath = path.join(targetRoot, relativePath);
      fs.mkdirSync(tgtPath, { recursive: true });
      smartCopyDirectoryWalk(
        rootDir, srcPath, targetRoot, filter,
        existingHashes, seenPaths, hashes, onAction,
      );
    } else if (entry.isFile()) {
      if (filter && !filter(entry.name)) {
        continue;
      }
      seenPaths.add(relativePath);
      const tgtPath = path.join(targetRoot, relativePath);
      const result = smartCopy(srcPath, tgtPath, existingHashes[relativePath]);
      if (result.action !== 'removed') {
        hashes[relativePath] = result.hash;
        onAction(result.action as 'created' | 'updated' | 'skipped');
      }
    }
  }
}

/**
 * Recursively walk a directory, computing hashes for visible files.
 *
 * @param rootDir - The top-level directory (used to compute relative paths).
 * @param currentDir - The directory currently being scanned.
 * @param hashes - Accumulator for path-to-hash mappings.
 */
function walkDirectory(
  rootDir: string,
  currentDir: string,
  hashes: Record<string, string>,
): void {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden files and directories
    if (entry.name.startsWith('.')) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      walkDirectory(rootDir, fullPath, hashes);
    } else if (entry.isFile()) {
      const relativePath = path.relative(rootDir, fullPath);
      hashes[relativePath] = computeFileHash(fullPath);
    }
  }
}
