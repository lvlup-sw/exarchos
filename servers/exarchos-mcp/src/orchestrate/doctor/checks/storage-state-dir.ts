/**
 * storage-state-dir — verify the exarchos state directory exists and is
 * writable by the current process. Uses `probes.fs.stat` for presence and
 * `probes.fs.access(dir, W_OK)` for writability so tests can inject
 * per-scenario behavior without touching the real filesystem (DIM-4).
 */

import { constants as fsConstants } from 'node:fs';
import type { CheckResult } from '../schema.js';
import type { DoctorProbes } from '../probes.js';

export async function storageStateDir(
  probes: DoctorProbes,
  _signal: AbortSignal,
): Promise<CheckResult> {
  const start = Date.now();
  const dir = probes.stateDir;
  const base = { category: 'storage' as const, name: 'state-dir' };

  try {
    const s = await probes.fs.stat(dir);
    if (!s.isDirectory()) {
      return { ...base, status: 'Fail', message: `State dir ${dir} is not a directory. Exarchos requires a writable state directory.`, fix: `Create state directory: mkdir -p "${dir}"`, durationMs: Date.now() - start };
    }
  } catch {
    return { ...base, status: 'Fail', message: `State dir ${dir} missing. Exarchos requires a writable state directory.`, fix: `Create state directory: mkdir -p "${dir}"`, durationMs: Date.now() - start };
  }

  try {
    await probes.fs.access?.(dir, fsConstants.W_OK);
    return { ...base, status: 'Pass', message: `State dir ${dir} present and writable`, durationMs: Date.now() - start };
  } catch {
    return { ...base, status: 'Warning', message: `State dir ${dir} not writable by current user`, fix: `Ensure state directory is writable: chmod u+w "${dir}"`, durationMs: Date.now() - start };
  }
}
