import { describe, it, expect } from 'vitest';
import { handleRunContract, type RunContractDeps } from './run-contract.js';
import type { ResolvedVerificationRuntime } from '../config/test-runtime-resolver.js';
import type { ContractCommands } from '../config/toolchains.js';

// ─── Test utilities ──────────────────────────────────────────────────────────

interface Recorder {
  runs: Array<{ cmd: string; args: readonly string[]; cwd: string }>;
  out: string[];
  err: string[];
}

function makeDeps(
  resolved: ResolvedVerificationRuntime | Error,
  overrides: Partial<RunContractDeps> = {},
): { deps: RunContractDeps; rec: Recorder } {
  const rec: Recorder = { runs: [], out: [], err: [] };
  const deps: RunContractDeps = {
    cwd: '/repo',
    resolve: () => {
      if (resolved instanceof Error) throw resolved;
      return resolved;
    },
    run: (cmd, args, cwd) => {
      rec.runs.push({ cmd, args, cwd });
      return 0;
    },
    stdout: (s) => rec.out.push(s),
    stderr: (s) => rec.err.push(s),
    ...overrides,
  };
  return { deps, rec };
}

const RESOLVED = (
  contract: ContractCommands | null,
  extra: Partial<ResolvedVerificationRuntime> = {},
): ResolvedVerificationRuntime => ({
  test: null,
  typecheck: null,
  install: null,
  mutation: null,
  lint: null,
  contract,
  source: contract === null ? 'unresolved' : 'config',
  ...extra,
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('handleRunContract', () => {
  it('RunContract_DryRun_PrintsResolvedCodegenAndDiff', () => {
    const { deps, rec } = makeDeps(
      RESOLVED({ codegen: 'buf generate', diff: 'buf breaking' }),
    );

    const code = handleRunContract(['--dry-run'], deps);

    expect(code).toBe(0);
    expect(rec.runs).toHaveLength(0);
    const printed = rec.out.join('\n');
    expect(printed).toContain('buf generate');
    expect(printed).toContain('buf breaking');
  });

  it('RunContract_Unresolved_ExitsNonZeroWithRemediation', () => {
    const { deps, rec } = makeDeps(
      RESOLVED(null, {
        remediation: 'No contract tool resolved. Add a .exarchos.yml contract: { codegen, diff }.',
      }),
    );

    const code = handleRunContract([], deps);

    expect(code).not.toBe(0);
    expect(rec.runs).toHaveLength(0);
    expect(rec.err.join('\n')).toContain('contract');
  });
});
