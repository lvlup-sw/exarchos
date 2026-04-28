/**
 * Atomic file writer — temp + fsync + rename.
 *
 * Stages `content` to `<target>.<pid>.<random>.tmp`, fsyncs the tmp file,
 * then `fs.renameSync`s it over `target`. Rename is atomic on POSIX
 * filesystems and on Windows when source and target are on the same volume,
 * so concurrent readers either see the prior contents or the new contents
 * — never a partial write.
 *
 * On rename failure the tmp file is best-effort unlinked; the original
 * error is rethrown unwrapped so callers can inspect `code` (e.g.,
 * `EXDEV`, `EACCES`).
 *
 * Originally inlined in `projections/store.ts`. Extracted here in T15
 * (#1192 Items 3+5+17) so `agents/plugin-manifest.ts` and the projection
 * store share one implementation.
 *
 * Concurrency caveat: intended for single-writer processes. Cross-process
 * concurrency is out of scope — multiple processes racing the same
 * `target` may each succeed in renaming, and the last winner clobbers the
 * earlier one (which is fine for the projection sidecar and plugin.json
 * use cases since both have a single owning writer).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

export function atomicWriteFile(target: string, content: string | Buffer): void {
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    if (typeof content === 'string') {
      fs.writeSync(fd, content);
    } else {
      fs.writeSync(fd, content);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.renameSync(tmp, target);
  } catch (err: unknown) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup — don't mask the original error */
    }
    throw err;
  }
}
