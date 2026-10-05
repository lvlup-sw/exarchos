import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const execFileAsync = promisify(execFile);

/** The directories of one invocation, under `exarchos-hermetic-<testId>` in `os.tmpdir()`. */
export interface HermeticEnv {
  /** The `home` directory. `HOME` points at it during the callback. */
  homeDir: string;
  /** The `state` directory. The state variables point at it during the callback. */
  stateDir: string;
  /** The `cwd` directory, which is the working directory during the callback. */
  cwdDir: string;
  /** The `git` directory, an initialized git repository. */
  gitDir: string;
  /** The UUID of this invocation. */
  testId: string;
}

/**
 * FIFO mutex for `withHermeticEnv`. The function changes process-global state: `HOME`,
 * the state variables and the working directory. Concurrent calls must not interleave
 * their save and restore steps. The lock is local to one test worker process.
 */
let hermeticEnvLock: Promise<void> = Promise.resolve();

/**
 * Runs `callback` inside an isolated process environment.
 *
 * The function makes the `home`, `state`, `cwd` and `git` directories and runs `git init`
 * in `git`. During the callback, `HOME` is `home` and the working directory is `cwd`.
 * `WORKFLOW_STATE_DIR` and `EXARCHOS_STATE_DIR` are `state`. `resolveStateDir()` reads
 * `WORKFLOW_STATE_DIR`, and no source file reads `EXARCHOS_STATE_DIR`.
 *
 * A mutex makes concurrent callers run one at a time, and a throw still releases it.
 * Cleanup runs when the callback returns or throws. It restores the environment first,
 * then removes the directories. A removal failure logs a warning and does not throw, so
 * a locked file fails no test.
 */
export async function withHermeticEnv<T>(
  callback: (env: HermeticEnv) => Promise<T>,
): Promise<T> {
  let releaseLock!: () => void;
  const waitTurn = hermeticEnvLock;
  hermeticEnvLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  await waitTurn;

  try {
    const testId = randomUUID();
    const tmpRoot = path.join(os.tmpdir(), `exarchos-hermetic-${testId}`);
    const homeDir = path.join(tmpRoot, 'home');
    const stateDir = path.join(tmpRoot, 'state');
    const cwdDir = path.join(tmpRoot, 'cwd');
    const gitDir = path.join(tmpRoot, 'git');

    const originalHome = process.env.HOME;
    const originalStateDir = process.env.EXARCHOS_STATE_DIR;
    const originalWorkflowStateDir = process.env.WORKFLOW_STATE_DIR;
    const originalCwd = process.cwd();

    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.mkdir(gitDir, { recursive: true });

    await execFileAsync('git', ['init', '-q', gitDir]);

    process.env.HOME = homeDir;
    process.env.WORKFLOW_STATE_DIR = stateDir;
    process.env.EXARCHOS_STATE_DIR = stateDir;
    process.chdir(cwdDir);

    const env: HermeticEnv = { homeDir, stateDir, cwdDir, gitDir, testId };

    try {
      return await callback(env);
    } finally {
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
      if (originalWorkflowStateDir === undefined) {
        delete process.env.WORKFLOW_STATE_DIR;
      } else {
        process.env.WORKFLOW_STATE_DIR = originalWorkflowStateDir;
      }

      try {
        await rmrfAsync(tmpRoot);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[withHermeticEnv] cleanup failed for ${tmpRoot}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } finally {
    releaseLock();
  }
}
