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
 * Recursively copy `src` to `dest` and set the mtime of each file to the mtime
 * of its source. A repeated copy thus gives the same contents and mtimes.
 * Dotfiles are copied, because references can hold markers such as `.gitkeep`.
 * When `writtenPaths` is given, it receives the resolved path of each written file.
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
    const contents = readFileSync(src);
    writeFileSync(dest, contents);
    utimesSync(dest, srcStat.atime, srcStat.mtime);
    if (writtenPaths) writtenPaths.add(resolve(dest));
  }
}
