/**
 * runtime-node-version — verify the running Node.js is at version 20 or
 * higher. Reads `probes.runtime.nodeVersion` rather than `process.version`
 * so tests can pin a version without monkeypatching globals (DIM-4).
 */

import type { CheckResult } from '../schema.js';
import type { DoctorProbes } from '../probes.js';

const MIN_MAJOR = 20;

export async function runtimeNodeVersion(
  probes: DoctorProbes,
  _signal: AbortSignal,
): Promise<CheckResult> {
  const version = probes.runtime.nodeVersion;
  const major = parseMajor(version);
  const base = { category: 'runtime' as const, name: 'node-version', durationMs: 0 };

  if (major !== null && major >= MIN_MAJOR) {
    return { ...base, status: 'Pass', message: `Node.js ${version} detected` };
  }
  return {
    ...base,
    status: 'Fail',
    message: `Node.js ${version} detected. Exarchos requires Node.js >= ${MIN_MAJOR}.`,
    fix: 'Upgrade Node via nvm install 20 or your package manager',
  };
}

function parseMajor(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version);
  return m ? Number(m[1]) : null;
}
