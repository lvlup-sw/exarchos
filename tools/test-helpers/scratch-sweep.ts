/**
 * Removes the scratch directories that earlier vitest runs left behind.
 *
 * The test tree may not delete a directory tree itself (#2027). A setup file
 * also may not import the temp-dir helper, because that helper loads storage
 * modules before a test file can mock them. This module imports only
 * `node:fs` and `node:path`, so a setup file can use it.
 */
import fs from 'node:fs';
import path from 'node:path';

/** A run's scratch name after its prefix: `<host pid>` or `<host pid>-<run id>`. */
const RUN_SUFFIX = /^([1-9]\d*)(?:-[A-Za-z0-9]+)?$/;

/**
 * Removes each directory under `tmp` that is named `prefix` plus a run suffix
 * and whose host process is gone, or that carries `hostPid` under another run
 * id. It keeps `keep`, every live run, and every other name. It returns the
 * names that it removed. A directory that it cannot remove now is left for
 * the next run.
 */
export function sweepOrphanScratchDirs(
  tmp: string,
  prefix: string,
  keep: string,
  hostPid: number,
  isAlive: (pid: number) => boolean,
): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || entry === keep) continue;
    const match = RUN_SUFFIX.exec(entry.slice(prefix.length));
    if (match?.[1] === undefined) continue;
    const pid = Number.parseInt(match[1], 10);
    if (pid !== hostPid && isAlive(pid)) continue;
    try {
      fs.rmSync(path.join(tmp, entry), { recursive: true, force: true });
      removed.push(entry);
    } catch {
      continue;
    }
  }
  return removed;
}
