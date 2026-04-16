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
  const dir = probes.stateDir;
  const base = { category: 'storage' as const, name: 'state-dir', durationMs: 0 };

  try {
    const s = await probes.fs.stat(dir);
    if (!s.isDirectory()) {
      return { ...base, status: 'Fail', message: `State dir ${dir} is not a directory. Exarchos requires a writable .exarchos directory.`, fix: 'Create .exarchos directory: mkdir -p .exarchos' };
    }
  } catch {
    return { ...base, status: 'Fail', message: `State dir ${dir} missing. Exarchos requires a writable .exarchos directory.`, fix: 'Create .exarchos directory: mkdir -p .exarchos' };
  }

  try {
    await probes.fs.access?.(dir, fsConstants.W_OK);
    return { ...base, status: 'Pass', message: `State dir ${dir} present and writable` };
  } catch {
    return { ...base, status: 'Warning', message: `State dir ${dir} not writable by current user`, fix: 'Ensure .exarchos is writable: chmod u+w .exarchos' };
  }
}
