import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function copyReferences(srcDir: string, destDir: string): void {
  const srcRefs = join(srcDir, 'references');
  if (!existsSync(srcRefs)) return;
  const srcStat = statSync(srcRefs);
  if (!srcStat.isDirectory()) return;

  const destRefs = join(destDir, 'references');
  copyTreePreservingMtime(srcRefs, destRefs);
}

/**
 * Recursively copy `src` to `dest`, creating directories as needed and
 * pinning each file's mtime to the source's mtime so idempotence holds
 * at the filesystem level.
 *
 * Does not follow symlinks (via `statSync` + file/dir branching). Hidden
 * dotfiles are included — unlike `operations/copy.ts::smartCopyDirectory`
 * which skips them — because references can legitimately include
 * `.gitkeep` or similar markers. `writtenPaths` is an optional out-param
 * that `buildAllSkills` uses to track every file it produced so the
 * stale-cleanup pass can avoid deleting fresh output.
 */
function copyTreePreservingMtime(
  src: string,
  dest: string,
  writtenPaths?: Set<string>,
): void {
  const srcStat = statSync(src);
  if (srcStat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    const entries = readdirSync(src);
    for (const entry of entries) {
      copyTreePreservingMtime(join(src, entry), join(dest, entry), writtenPaths);
    }
    return;
  }
  if (srcStat.isFile()) {
    // Ensure parent exists (handles top-level files when `dest` is new).
    // Read + write so binary bytes round-trip exactly.
    const contents = readFileSync(src);
    writeFileSync(dest, contents);
    utimesSync(dest, srcStat.atime, srcStat.mtime);
    if (writtenPaths) writtenPaths.add(resolve(dest));
  }
}

// -----------------------------------------------------------------------------
// Task 007: buildAllSkills orchestrator
// -----------------------------------------------------------------------------

/**
 * Summary returned by `buildAllSkills` so callers (the CLI, tests) can
 * report on what happened without re-scanning the output tree.
 */
