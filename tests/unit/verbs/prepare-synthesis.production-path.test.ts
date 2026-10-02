/**
 * Tests that `prepare_synthesis` gets `repoRoot` through the production path.
 *
 * `prepare-synthesis.test.ts` calls `handlePrepareSynthesis` directly, so it cannot see what `dispatch()` does to the args.
 * `dispatch()` strips a key that the action schema does not declare but a sibling action does, and reports no error.
 * Thus the action schema must declare `repoRoot`, or each production call arrives without it.
 * Each case here runs through `dispatch()`. The mock stubs `execSync` and `execFileSync` and keeps the rest of `node:child_process` real.
 * Thus nothing spawns, and the tests check only the `cwd` of each leg.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(() => Buffer.from('Tests: 3 passed, 0 failed')),
    execFileSync: vi.fn(() => Buffer.from('src/touched.ts\n')),
  };
});

import { execSync, execFileSync } from 'node:child_process';

import { EventStore } from '../../../src/events/store.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { dispatch } from '../../../src/dispatch/core/dispatch.js';
import { seedActivePhaseAttempt, withTrustedCaller } from '../../../tools/test-helpers/trusted-context.js';
import { TOOL_REGISTRY } from '../../../src/registry.js';

/** Every `cwd` handed to a shelled-out leg during the call under test. */
function observedLegCwds(): string[] {
  const fromExecSync = vi.mocked(execSync).mock.calls
    .map((call) => (call[1] as { cwd?: string } | undefined)?.cwd)
    .filter((cwd): cwd is string => typeof cwd === 'string');
  const fromExecFileSync = vi.mocked(execFileSync).mock.calls
    .map((call) => (call[2] as { cwd?: string } | undefined)?.cwd)
    .filter((cwd): cwd is string => typeof cwd === 'string');
  return [...fromExecSync, ...fromExecFileSync];
}

/** The shell-form commands the `execSync` legs asked for. */
function observedExecSyncCommands(): string[] {
  return vi.mocked(execSync).mock.calls.map((call) => String(call[0]));
}

describe('prepare_synthesis production path (DR-8 / #1756)', () => {
  const cleanups: Array<() => void> = [];
  let ctx: DispatchContext;
  let repoRoot: string;
  let openStore: EventStore | undefined;

  const FEATURE_ID = 'feat-prepare-synthesis-prodpath';

  /**
   * The repo root is a temporary directory and not `process.cwd()`.
   * No tasks are seeded, so the task-completion check passes and the handler runs the four shell legs.
   */
  beforeEach(async () => {
    vi.clearAllMocks();
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ps-prodpath-state-'));
    cleanups.push(() => rmrf(stateDir));
    repoRoot = mkdtempSync(path.join(os.tmpdir(), 'ps-prodpath-repo-'));
    cleanups.push(() => rmrf(repoRoot));
    writeFileSync(path.join(repoRoot, '.exarchos.yml'), "test: 'vitest run'\ntypecheck: 'tsc --noEmit'\n");

    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    openStore = eventStore;
    await seedActivePhaseAttempt(eventStore, FEATURE_ID, { phase: 'synthesize' });
    ctx = withTrustedCaller({
      stateDir,
      eventStore,
      enableTelemetry: false,
    } as DispatchContext);
  });

  /**
   * Closes the SQLite handle before the cleanups run, because `cleanups` removes `stateDir` first.
   * On Windows, an open handle makes the removal fail with EBUSY. On Linux, the unlink succeeds with an open handle.
   */
  afterEach(async () => {
    try {
      await openStore?.close();
    } catch {
    }
    openStore = undefined;
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
      }
    }
  });

  /**
   * Without the schema field, `dispatch()` strips `repoRoot`, the handler guard refuses, and no leg runs.
   * The test checks each named leg by its command, so a missing leg cannot pass on the count alone.
   */
  it('ProductionPath_DispatchWithRepoRoot_EveryLegRunsAgainstThatRoot', async () => {
    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'prepare_synthesis', featureId: FEATURE_ID, repoRoot },
      ctx,
    );

    expect(result.error?.code, JSON.stringify(result.error)).toBeUndefined();
    expect(result.success).toBe(true);

    const cwds = observedLegCwds();
    expect(cwds.length).toBeGreaterThanOrEqual(4);
    for (const cwd of cwds) {
      expect(cwd).toBe(repoRoot);
    }
    expect(cwds).not.toContain(process.cwd());

    const commands = observedExecSyncCommands();
    expect(commands.some((c) => c.startsWith('git log '))).toBe(true);
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      'vitest',
      ['run'],
      expect.objectContaining({ cwd: repoRoot }),
    );
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      'tsc',
      ['--noEmit'],
      expect.objectContaining({ cwd: repoRoot }),
    );
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['diff', '--name-only']),
      expect.objectContaining({ cwd: repoRoot }),
    );
  });

  /**
   * The action schema requires `repoRoot`, so `dispatch()` rejects a call without it before the gate runner starts.
   * Thus no subprocess runs, and no evidence row exists for a gate that did not run.
   */
  it('ProductionPath_DispatchWithoutRepoRoot_RefusedBeforeAnyLegSpawns', async () => {
    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'prepare_synthesis', featureId: FEATURE_ID },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(/repoRoot/i);
    expect(observedLegCwds()).toEqual([]);

    const evidence = await ctx.eventStore.query(FEATURE_ID, {
      type: 'admission.evidence-recorded',
    });
    expect(evidence).toEqual([]);
  });

  /** The kill-probe target. When `repoRoot` leaves the action schema, this test and the dispatch test above both fail. */
  it('ActionSchema_DeclaresRepoRoot_AsRequiredString', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    const action = orchestrate?.actions.find((a) => a.name === 'prepare_synthesis');
    expect(action, 'prepare_synthesis must exist in the registry').toBeDefined();

    const field = (action!.schema as { shape: Record<string, { isOptional(): boolean }> })
      .shape.repoRoot;
    expect(field, 'prepare_synthesis must declare repoRoot').toBeDefined();
    expect(field.isOptional(), 'repoRoot must be REQUIRED, not optional').toBe(false);
  });
});
