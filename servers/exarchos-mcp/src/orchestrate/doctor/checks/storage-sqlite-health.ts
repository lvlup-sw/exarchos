/**
 * storage-sqlite-health — thin mapper over the narrow EventStore
 * integrity accessor (see `EventStore.runIntegrityCheck`). The probe
 * enforces the 2s timeout + abort contract internally (DIM-7), so this
 * check only pattern-matches on the discriminated `IntegrityResult`
 * (DIM-3) and projects into a `CheckResult`.
 */

import type { DoctorProbes } from '../probes.js';
import type { CheckResult } from '../schema.js';

const INTEGRITY_TIMEOUT_MS = 2000;
const CORRUPTION_FIX =
  'Run exarchos export to bundle events, then investigate .exarchos/events.db';

export async function storageSqliteHealth(
  probes: DoctorProbes,
  signal: AbortSignal,
): Promise<CheckResult> {
  const started = Date.now();
  const result = await probes.sqlite.runIntegrityCheck({
    signal,
    timeoutMs: INTEGRITY_TIMEOUT_MS,
  });
  const durationMs = Date.now() - started;

  const base = { category: 'storage' as const, name: 'storage-sqlite-health', durationMs };

  if (result.ok === true) {
    return { ...base, status: 'Pass', message: 'sqlite integrity_check reports ok' };
  }
  if (result.ok === 'skipped') {
    return {
      ...base,
      status: 'Skipped',
      message: 'sqlite integrity check skipped',
      reason: result.reason,
    };
  }
  return {
    ...base,
    status: 'Warning',
    message: `sqlite integrity_check reported: ${result.details}`,
    fix: CORRUPTION_FIX,
  };
}
