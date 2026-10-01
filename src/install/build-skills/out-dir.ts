import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Count the direct subdirectories of `outDir`, one per rendered runtime. Return 0 when `outDir` is absent or unreadable. */
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
 * Remove each file under `root` that is not in `keep`, then remove the directories that become empty.
 * Removal errors are ignored.
 * The caller must scope `root` to one per-runtime subtree, so that no unrelated file is removed.
 */
export function cleanStaleFiles(root: string, keep: Set<string>): void {
  if (!existsSync(root)) return;

  const walk = (dir: string): boolean => {
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
          }
        }
      } else if (st.isFile()) {
        if (keep.has(resolve(full))) {
          survivorCount++;
        } else {
          try {
            rmSync(full, { force: true });
          } catch {
          }
        }
      }
    }
    return survivorCount > 0;
  };

  walk(root);
}
