/**
 * Init Workflow — End-to-End Integration Test (T42)
 *
 * Exercises the full init flow using the testable seam
 * `handleInitWithWriters`. Uses:
 *   - Stub writers that return predetermined ConfigWriteResults
 *   - A mock VCS detector that returns a fixed VcsEnvironment
 *   - A real EventStore backed by a temp directory
 *
 * Verifies:
 *   1. Detection runs (VCS detector invoked)
 *   2. Writers called with correct options
 *   3. ConfigWriteResults aggregated
 *   4. init.executed event emitted
 *   5. Output validates against InitOutputSchema
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { DispatchContext } from '../../core/dispatch.js';
import { EventStore } from '../../event-store/store.js';
import {
  handleInitWithWriters,
  INIT_STREAM_ID,
} from '../../orchestrate/init/index.js';
import { InitOutputSchema, type ConfigWriteResult } from '../../orchestrate/init/schema.js';
import type { RuntimeConfigWriter, WriteOptions } from '../../orchestrate/init/writers/writer.js';
import type { WriterDeps } from '../../orchestrate/init/probes.js';
import { makeStubWriterDeps } from '../../orchestrate/init/probes.js';
import type { VcsEnvironment, VcsDetectorDeps } from '../../vcs/detector.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Create a stub RuntimeConfigWriter that returns a predetermined result. */
function makeStubWriter(
  runtime: string,
  result: ConfigWriteResult,
): RuntimeConfigWriter {
  return {
    runtime,
    write: vi.fn<(deps: WriterDeps, options: WriteOptions) => Promise<ConfigWriteResult>>(
      async () => result,
    ),
  };
}

/** Create a stub RuntimeConfigWriter that throws an error. */
function makeFailingWriter(
  runtime: string,
  errorMessage: string,
): RuntimeConfigWriter {
  return {
    runtime,
    write: vi.fn<(deps: WriterDeps, options: WriteOptions) => Promise<ConfigWriteResult>>(
      async () => { throw new Error(errorMessage); },
    ),
  };
}

// ─── Test Suite ────────────────────────────────────────────────────────────

describe('InitWorkflow_EndToEnd_DetectsWritesEmits', () => {
  let tmpDir: string;
  let eventStore: EventStore;
  let ctx: DispatchContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'init-e2e-'));
    eventStore = new EventStore(tmpDir);
    ctx = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
    };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('InitWorkflow_FullFlow_DetectsWritesEmitsValidates', async () => {
    // ─── Arrange ───────────────────────────────────────────────────────

    // Stub writer that simulates successful config write
    const claudeCodeResult: ConfigWriteResult = {
      runtime: 'claude-code',
      status: 'written',
      componentsWritten: ['mcp-config', 'commands', 'skills'],
    };
    const stubWriter = makeStubWriter('claude-code', claudeCodeResult);

    // Stub VCS detector
    const vcsEnv: VcsEnvironment = {
      provider: 'github',
      remoteUrl: 'https://github.com/test/repo.git',
      cliAvailable: true,
      cliVersion: '2.50.0',
    };
    const detectVcs = vi.fn(async (_deps?: VcsDetectorDeps) => vcsEnv);

    // Stub writer deps
    const stubDeps = makeStubWriterDeps({
      cwd: () => '/test/project',
    });
    const buildDeps = vi.fn(() => stubDeps);

    // ─── Act ───────────────────────────────────────────────────────────

    const result = await handleInitWithWriters(
      { nonInteractive: true },
      ctx,
      [stubWriter],
      detectVcs,
      buildDeps,
    );

    // ─── Assert: success ───────────────────────────────────────────────

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    // ─── Assert: VCS detection ran ─────────────────────────────────────

    expect(detectVcs).toHaveBeenCalledTimes(1);

    // ─── Assert: writer called with correct deps and options ───────────

    expect(stubWriter.write).toHaveBeenCalledTimes(1);
    const [writeDeps, writeOpts] = (stubWriter.write as ReturnType<typeof vi.fn>).mock.calls[0] as [WriterDeps, WriteOptions];
    expect(writeDeps).toBe(stubDeps);
    expect(writeOpts.projectRoot).toBe('/test/project');
    expect(writeOpts.nonInteractive).toBe(true);
    expect(writeOpts.forceOverwrite).toBe(false);

    // ─── Assert: ConfigWriteResults aggregated ─────────────────────────

    const data = result.data as { runtimes: ConfigWriteResult[]; vcs: VcsEnvironment | null; durationMs: number };
    expect(data.runtimes).toHaveLength(1);
    expect(data.runtimes[0].runtime).toBe('claude-code');
    expect(data.runtimes[0].status).toBe('written');
    expect(data.runtimes[0].componentsWritten).toEqual(['mcp-config', 'commands', 'skills']);

    // ─── Assert: VCS result present ────────────────────────────────────

    expect(data.vcs).toEqual(vcsEnv);

    // ─── Assert: durationMs is a nonnegative integer ───────────────────

    expect(data.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(data.durationMs)).toBe(true);

    // ─── Assert: output validates against InitOutputSchema ─────────────

    const parseResult = InitOutputSchema.safeParse(data);
    expect(parseResult.success).toBe(true);

    // ─── Assert: init.executed event emitted ───────────────────────────

    const events = await eventStore.query(INIT_STREAM_ID);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const initEvent = events.find((e) => e.type === 'init.executed');
    expect(initEvent).toBeDefined();
    expect(initEvent!.data).toBeDefined();
    const eventData = initEvent!.data as { runtimes: unknown[]; durationMs: number };
    expect(eventData.runtimes).toHaveLength(1);
    expect(eventData.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('InitWorkflow_MultipleWriters_AggregatesResults', async () => {
    // Two writers: one succeeds, one returns stub
    const claudeResult: ConfigWriteResult = {
      runtime: 'claude-code',
      status: 'written',
      componentsWritten: ['mcp-config'],
    };
    const cursorResult: ConfigWriteResult = {
      runtime: 'cursor',
      status: 'stub',
      componentsWritten: [],
    };

    const writer1 = makeStubWriter('claude-code', claudeResult);
    const writer2 = makeStubWriter('cursor', cursorResult);
    const detectVcs = vi.fn(async () => null);
    const buildDeps = () => makeStubWriterDeps({ cwd: () => '/proj' });

    const result = await handleInitWithWriters(
      {},
      ctx,
      [writer1, writer2],
      detectVcs,
      buildDeps,
    );

    expect(result.success).toBe(true);
    const data = result.data as { runtimes: ConfigWriteResult[]; vcs: null };
    expect(data.runtimes).toHaveLength(2);
    expect(data.runtimes[0].runtime).toBe('claude-code');
    expect(data.runtimes[0].status).toBe('written');
    expect(data.runtimes[1].runtime).toBe('cursor');
    expect(data.runtimes[1].status).toBe('stub');
    expect(data.vcs).toBeNull();
  });

  it('InitWorkflow_WriterThrows_CapturedAsFailed', async () => {
    const failingWriter = makeFailingWriter('claude-code', 'Permission denied');
    const detectVcs = vi.fn(async () => null);
    const buildDeps = () => makeStubWriterDeps({ cwd: () => '/proj' });

    const result = await handleInitWithWriters(
      {},
      ctx,
      [failingWriter],
      detectVcs,
      buildDeps,
    );

    expect(result.success).toBe(true);
    const data = result.data as { runtimes: ConfigWriteResult[] };
    expect(data.runtimes).toHaveLength(1);
    expect(data.runtimes[0].status).toBe('failed');
    expect(data.runtimes[0].error).toBe('Permission denied');
  });

  it('InitWorkflow_RuntimeFilter_OnlyRunsMatchingWriter', async () => {
    const claudeResult: ConfigWriteResult = {
      runtime: 'claude-code',
      status: 'written',
      componentsWritten: ['mcp-config'],
    };
    const cursorResult: ConfigWriteResult = {
      runtime: 'cursor',
      status: 'written',
      componentsWritten: ['mcp-config'],
    };

    const writer1 = makeStubWriter('claude-code', claudeResult);
    const writer2 = makeStubWriter('cursor', cursorResult);
    const detectVcs = vi.fn(async () => null);
    const buildDeps = () => makeStubWriterDeps({ cwd: () => '/proj' });

    // Filter to cursor only
    const result = await handleInitWithWriters(
      { runtime: 'cursor' },
      ctx,
      [writer1, writer2],
      detectVcs,
      buildDeps,
    );

    expect(result.success).toBe(true);
    const data = result.data as { runtimes: ConfigWriteResult[] };
    expect(data.runtimes).toHaveLength(1);
    expect(data.runtimes[0].runtime).toBe('cursor');

    // writer1 should not have been called
    expect(writer1.write).not.toHaveBeenCalled();
    expect(writer2.write).toHaveBeenCalledTimes(1);
  });

  it('InitWorkflow_VcsDetectionFails_StillSucceeds', async () => {
    const claudeResult: ConfigWriteResult = {
      runtime: 'claude-code',
      status: 'written',
      componentsWritten: ['mcp-config'],
    };
    const writer = makeStubWriter('claude-code', claudeResult);
    const detectVcs = vi.fn(async () => { throw new Error('no git'); });
    const buildDeps = () => makeStubWriterDeps({ cwd: () => '/proj' });

    const result = await handleInitWithWriters(
      {},
      ctx,
      [writer],
      detectVcs,
      buildDeps,
    );

    // Init should succeed even when VCS detection fails
    expect(result.success).toBe(true);
    const data = result.data as { runtimes: ConfigWriteResult[]; vcs: null };
    expect(data.vcs).toBeNull();
    expect(data.runtimes).toHaveLength(1);
    expect(data.runtimes[0].status).toBe('written');
  });
});
