import { describe, it, expect } from 'vitest';
import { handleRunMutation, type RunMutationDeps } from './run-mutation.js';
import type { ResolvedVerificationRuntime } from '../config/test-runtime-resolver.js';

// ─── Test utilities ──────────────────────────────────────────────────────────

interface Recorder {
  runs: Array<{ cmd: string; args: readonly string[]; cwd: string }>;
  out: string[];
  err: string[];
}

function makeDeps(
  resolved: ResolvedVerificationRuntime | Error,
  overrides: Partial<RunMutationDeps> = {},
): { deps: RunMutationDeps; rec: Recorder } {
  const rec: Recorder = { runs: [], out: [], err: [] };
  const deps: RunMutationDeps = {
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
  mutation: string | null,
  extra: Partial<ResolvedVerificationRuntime> = {},
): ResolvedVerificationRuntime => ({
  test: null,
  typecheck: null,
  install: null,
  mutation,
  lint: null,
  contract: null,
  source: mutation === null ? 'unresolved' : 'detection',
  ...extra,
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('handleRunMutation', () => {
  it('RunMutation_DryRun_PrintsResolvedCommand', () => {
    const { deps, rec } = makeDeps(RESOLVED('npx stryker run'));

    const code = handleRunMutation(['--dry-run'], deps);

    expect(code).toBe(0);
    expect(rec.runs).toHaveLength(0);
    expect(rec.out.join('\n')).toContain('npx stryker run');
  });

  it('RunMutation_Unresolved_ExitsNonZeroWithRemediation', () => {
    const { deps, rec } = makeDeps(
      RESOLVED(null, {
        remediation: 'No mutation runner resolved. Add a .exarchos.yml mutation: command.',
      }),
    );

    const code = handleRunMutation([], deps);

    // Unlike run-tests (exit 0 on unresolved), an explicitly-invoked mutation
    // run with no resolvable runner is a non-zero failure with remediation.
    expect(code).not.toBe(0);
    expect(rec.runs).toHaveLength(0);
    expect(rec.err.join('\n')).toContain('mutation');
    expect(rec.err.join('\n')).toMatch(/\.exarchos\.yml|No mutation runner|remediation/i);
  });

  it('RunMutation_ChildExit_PropagatesExitCode', () => {
    const { deps } = makeDeps(RESOLVED('cargo mutants --in-diff'), {
      run: () => 3,
    });

    const code = handleRunMutation([], deps);

    expect(code).toBe(3);
  });

  it('RunMutation_Execution_EmitsExecutingStartedAndPairedTerminal', () => {
    const events: Array<{ stream: string; type: string; data: unknown }> = [];
    const eventStore = {
      append: (stream: string, event: { type: string; data: unknown }) => {
        events.push({ stream, type: event.type, data: event.data });
      },
    };

    // ── Success path: child exits 0 → paired terminal is mutation.executed (passed) ──
    const { deps: okDeps } = makeDeps(RESOLVED('npx stryker run'), {
      run: () => 0,
      eventStore,
      stream: 'feat-mut',
    });
    const okCode = handleRunMutation([], okDeps);
    expect(okCode).toBe(0);

    const started = events.find((e) => e.type === 'mutation.executing_started');
    const terminal = events.find((e) => e.type === 'mutation.executed');
    expect(started).toBeDefined();
    expect(terminal).toBeDefined();
    // Liveness pair lands on the supplied stream, started BEFORE terminal.
    expect(started!.stream).toBe('feat-mut');
    expect(terminal!.stream).toBe('feat-mut');
    expect(events.indexOf(started!)).toBeLessThan(events.indexOf(terminal!));
    expect((terminal!.data as { passed: boolean }).passed).toBe(true);

    // ── Failure path: child exits non-zero → paired terminal carries passed:false ──
    events.length = 0;
    const { deps: failDeps } = makeDeps(RESOLVED('npx stryker run'), {
      run: () => 7,
      eventStore,
      stream: 'feat-mut',
    });
    const failCode = handleRunMutation([], failDeps);
    expect(failCode).toBe(7);
    expect(events.find((e) => e.type === 'mutation.executing_started')).toBeDefined();
    const failTerminal = events.find((e) => e.type === 'mutation.executed');
    expect(failTerminal).toBeDefined();
    expect((failTerminal!.data as { passed: boolean }).passed).toBe(false);
  });

  it('RunMutation_DryRun_DoesNotEmitLivenessEvents', () => {
    const events: Array<{ type: string }> = [];
    const eventStore = {
      append: (_stream: string, event: { type: string; data: unknown }) => {
        events.push({ type: event.type });
      },
    };
    const { deps } = makeDeps(RESOLVED('npx stryker run'), {
      eventStore,
      stream: 'feat-mut',
    });

    handleRunMutation(['--dry-run'], deps);

    // Dry-run is a query, not an execution — no liveness pair.
    expect(events).toHaveLength(0);
  });

  it('RunMutation_NoEventStore_ExecutesWithoutCrashing', () => {
    // Invoked outside a workspace (no event store) → skip emission, never crash.
    const { deps, rec } = makeDeps(RESOLVED('npx stryker run'), { run: () => 0 });
    const code = handleRunMutation([], deps);
    expect(code).toBe(0);
    expect(rec.runs).toHaveLength(1);
  });
});
