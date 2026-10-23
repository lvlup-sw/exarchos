/**
 * Tells a build or guard script whether `node` runs it directly or a test imports it.
 *
 * A raw `file://` string of `argv[1]` fails on Windows, on a path with a space and through a
 * symlink. Then the script exits 0 with no output. This check compares real paths instead.
 * The binary entry `src/index.ts` keeps its own check, because inside the compiled binary every
 * bundled module shares the URL of the entry.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Returns true when `argv1` names the file of `importMetaUrl`.
 * Both paths go through `realpathSync`, so a symlink, a space or a Windows separator does not change
 * the result. Returns false when `argv1` is missing or when a path does not resolve.
 */
export function isMainModule(importMetaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
