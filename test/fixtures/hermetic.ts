import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface HermeticEnv {
  homeDir: string; // tmp/<id>/home
  stateDir: string; // tmp/<id>/state
  cwdDir: string; // tmp/<id>/cwd (process.cwd during callback)
  gitDir: string; // tmp/<id>/git (git init'd)
  testId: string; // stable ID for this invocation
}

/**
 * Runs `callback` inside a hermetic process environment.
 *
 * Guarantees (design §4.3, §5.1):
 *  - Fresh `tmp/<testId>/{home,state,cwd,git}/` tree under `os.tmpdir()`.
 *  - `process.env.HOME`, `process.env.EXARCHOS_STATE_DIR`, and `process.cwd()`
 *    are set to the tmp dirs for the duration of the callback.
 *  - `tmp/<testId>/git` is initialized as a git repository.
 *  - Cleanup (env restore, cwd restore, tmp tree removal) runs unconditionally
 *    in `finally`, even if the callback throws.
 *  - Cleanup failures (e.g., locked files on Windows) log a warning via
 *    `console.warn` and do NOT throw — test outcome is preserved.
 *  - Concurrent callers receive non-overlapping tmp dirs (ids are UUIDs).
 */
export async function withHermeticEnv<T>(
  callback: (env: HermeticEnv) => Promise<T>,
): Promise<T> {
  const testId = randomUUID();
  const tmpRoot = path.join(os.tmpdir(), `exarchos-hermetic-${testId}`);
  const homeDir = path.join(tmpRoot, 'home');
  const stateDir = path.join(tmpRoot, 'state');
  const cwdDir = path.join(tmpRoot, 'cwd');
  const gitDir = path.join(tmpRoot, 'git');

  // Save ambient state before mutation so we can restore in `finally`.
  const originalHome = process.env.HOME;
  const originalStateDir = process.env.EXARCHOS_STATE_DIR;
  const originalCwd = process.cwd();

  // Create tmp tree.
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(cwdDir, { recursive: true });
  await fs.mkdir(gitDir, { recursive: true });

  // git init — quiet; no output on success.
  await execFileAsync('git', ['init', '-q', gitDir]);

  // Mutate ambient state.
  process.env.HOME = homeDir;
  process.env.EXARCHOS_STATE_DIR = stateDir;
  process.chdir(cwdDir);

  const env: HermeticEnv = { homeDir, stateDir, cwdDir, gitDir, testId };

  try {
    return await callback(env);
  } finally {
    // Restore ambient state first so even a cleanup failure leaves the
    // process in a sane state.
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalStateDir === undefined) {
      delete process.env.EXARCHOS_STATE_DIR;
    } else {
      process.env.EXARCHOS_STATE_DIR = originalStateDir;
    }

    // Unconditional tmp-tree removal. Cleanup failures log a warning but
    // never throw — axiom DIM-7 (resource-release symmetry): the acquirer
    // must always release, but tests must not be made flaky by best-effort
    // cleanup racing with OS-level file locks.
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[withHermeticEnv] cleanup failed for ${tmpRoot}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
