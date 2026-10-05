// Snapshot and restore of the process state that test files share in one
// worker: `process.env` and the working directory. The setup file
// `reset-process-state.ts` takes a snapshot when a test file starts and
// restores it after the file. Thus the state that one file leaves cannot
// reach the next file in the same fork (#2030).

/** The process state at one moment. */
export interface ProcessStateSnapshot {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/** Copies `process.env` and the working directory as they are now. */
export function snapshotProcessState(): ProcessStateSnapshot {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { env, cwd: process.cwd() };
}

/**
 * Makes `target` hold exactly the entries of `snapshot`. It deletes the extra
 * keys first, then sets each snapshot key. On Windows, `process.env` ignores
 * the case of a key, so this order brings back a key that a test re-cased.
 */
export function restoreEnv(target: NodeJS.ProcessEnv, snapshot: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) delete target[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (target[key] !== value) target[key] = value;
  }
}

/** The working directory now, or `undefined` when it was deleted under the process. */
function currentDirectory(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

/** Restores `process.env` and the working directory from `snapshot`. */
export function restoreProcessState(snapshot: ProcessStateSnapshot): void {
  restoreEnv(process.env, snapshot.env);
  if (currentDirectory() !== snapshot.cwd) process.chdir(snapshot.cwd);
}
