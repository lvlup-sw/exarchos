/**
 * Test helper that builds a `DoctorProbes` bundle in which each probe function throws.
 * A check test overrides only the probes it uses. A call to a probe that the test does not override throws an error.
 */

import { DEFAULT_CHECK_BUDGET_MS, type DoctorProbes } from '../../probes.js';
import type { CheckResult } from '../../schema.js';

export type CheckFn = (probes: DoctorProbes, signal: AbortSignal) => Promise<CheckResult>;

const throwing = (field: string) => () => {
  throw new Error(`probe not overridden: ${field}`);
};

export function makeStubProbes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  const base: DoctorProbes = {
    checkBudgetMs: DEFAULT_CHECK_BUDGET_MS,
    fs: { readFile: throwing('fs'), stat: throwing('fs'), access: throwing('fs') },
    env: {},
    git: {
      which: throwing('git'),
      isRepo: throwing('git'),
      version: throwing('git'),
    },
    sqlite: { runIntegrityCheck: throwing('sqlite') },
    bundles: { runIntegrityCheck: throwing('bundles') },
    detector: throwing('detector') as DoctorProbes['detector'],
    eventStore: { append: throwing('eventStore') } as unknown as DoctorProbes['eventStore'],
    runtime: { nodeVersion: '' },
    stateDir: '',
    skills: { guardStatus: throwing('skills') },
    plugin: {
      installedVersion: throwing('plugin'),
      runningVersion: throwing('plugin'),
    },
    invariants: { resolve: throwing('invariants') },
    verificationToolchain: { resolve: throwing('verificationToolchain') },
  };
  return { ...base, ...overrides };
}
