/**
 * Vitest global setup: one temp root for each run, removed when the run ends.
 *
 * The setup creates the root under the canonical (long-name) temp directory
 * and points TMPDIR, TEMP and TMP at it. Vitest starts its workers after this
 * setup, so every `os.tmpdir()` in a test lands inside the root. Because the
 * root is canonical, a Windows 8.3 short name cannot appear in a temp path.
 * The teardown removes the root. If that fails, it tries again at process
 * exit, after vitest has stopped every worker. The sweep never throws. It
 * reports what it could not remove in one line (#2027).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The environment variable that gives the run root to the workers. */
export const TEST_TMP_ROOT_ENV = 'EXARCHOS_TEST_TMP_ROOT';

/** The name prefix of every run root. */
export const RUN_ROOT_PREFIX = 'exarchos-run-';

/** The variables that `os.tmpdir()` reads on POSIX and on Windows. */
export const TEMP_VARIABLES: readonly string[] = ['TMPDIR', 'TEMP', 'TMP'];

/** Generous retries for the sweep: it runs once, at the end of the run. */
const SWEEP_REMOVE: fs.RmOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

/** The most leftover names that the one-line report lists. */
const REPORTED_LEFTOVERS = 10;

/**
 * Creates a run root under the canonical temp directory and points the temp
 * variables and {@link TEST_TMP_ROOT_ENV} at it. Returns the root.
 */
export function createRunRoot(env: NodeJS.ProcessEnv): string {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, RUN_ROOT_PREFIX)));
  for (const name of TEMP_VARIABLES) env[name] = root;
  env[TEST_TMP_ROOT_ENV] = root;
  return root;
}

/**
 * Removes a run root. Returns undefined when the root is gone, or a one-line
 * report of what is left. It never throws.
 */
export function sweepRunRoot(
  root: string,
  remove: (dir: string, options: fs.RmOptions) => void = fs.rmSync,
): string | undefined {
  try {
    remove(root, SWEEP_REMOVE);
    return undefined;
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String(err.code) : String(err);
    const left = leftoverNames(root);
    const shown = left.slice(0, REPORTED_LEFTOVERS).join(', ');
    return `[exarchos] temp run root ${root} not removed (${code}); ${left.length} entries left: ${shown}`;
  }
}

/** The vitest global setup. It returns the teardown. */
export default function setupTempRunRoot(): () => void {
  const saved = new Map([...TEMP_VARIABLES, TEST_TMP_ROOT_ENV].map((name) => [name, process.env[name]]));
  const root = createRunRoot(process.env);
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (sweepRunRoot(root) === undefined) return;
    process.once('exit', () => {
      const report = sweepRunRoot(root);
      if (report !== undefined) console.warn(report);
    });
  };
}

/** The names of the entries left in a directory, or none if it cannot be read. */
function leftoverNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
