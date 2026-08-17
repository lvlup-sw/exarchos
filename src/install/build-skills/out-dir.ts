import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function countRuntimesFromOutDir(outDir: string): number {
  if (!existsSync(outDir)) return 0;
  try {
    return readdirSync(outDir).filter((entry) => {
      try {
        return statSync(join(outDir, entry)).isDirectory();
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}


/**
 * Recursively walk `root` and remove any file that is not present in
 * `keep`. After file removal, empty directories are pruned bottom-up so
 * the tree stays tidy.
 *
 * Safety: callers must scope `root` to a per-runtime subtree under
 * `outDir` so we never touch unrelated files.
 */
export function cleanStaleFiles(root: string, keep: Set<string>): void {
  if (!existsSync(root)) return;

  const walk = (dir: string): boolean => {
    // Returns `true` if the directory still contains any surviving entries
    // after the recursive cleanup pass — caller uses that to decide
    // whether to rmdir this directory too.
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }

    let survivorCount = 0;
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        const hadSurvivors = walk(full);
        if (hadSurvivors) {
          survivorCount++;
        } else {
          try {
            rmSync(full, { recursive: true, force: true });
          } catch {
            /* best-effort */
          }
        }
      } else if (st.isFile()) {
        if (keep.has(resolve(full))) {
          survivorCount++;
        } else {
          try {
            rmSync(full, { force: true });
          } catch {
            /* best-effort */
          }
        }
      }
    }
    return survivorCount > 0;
  };

  walk(root);
}
