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
