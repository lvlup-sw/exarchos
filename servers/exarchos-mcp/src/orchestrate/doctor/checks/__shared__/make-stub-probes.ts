/**
 * makeStubProbes — test helper producing a DoctorProbes bundle where
 * every field throws by default (DIM-4/T-4.2). Check tests override only
 * the probes they actually exercise, so accidental dependencies on
 * unstubbed probes surface as loud failures rather than silent
 * pass-through. No module-global state (DIM-1).
 */

import type { DoctorProbes } from '../../probes.js';
import type { CheckResult } from '../../schema.js';

export type CheckFn = (probes: DoctorProbes, signal: AbortSignal) => Promise<CheckResult>;

const throwing = (field: string) => () => {
  throw new Error(`probe not overridden: ${field}`);
};

export function makeStubProbes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  const base: DoctorProbes = {
    fs: { readFile: throwing('fs'), stat: throwing('fs') },
    env: {},
    git: { which: throwing('git'), isRepo: throwing('git') },
    sqlite: { runIntegrityCheck: throwing('sqlite') },
    detector: throwing('detector') as DoctorProbes['detector'],
    eventStore: { append: throwing('eventStore') } as unknown as DoctorProbes['eventStore'],
  };
  return { ...base, ...overrides };
}
