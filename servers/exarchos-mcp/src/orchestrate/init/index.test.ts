/**
 * Init compositor tests — handleInit and handleInitWithWriters.
 *
 * Follows the doctor compositor pattern: a testable seam
 * (`handleInitWithWriters`) accepts injected writers and detector,
 * while `handleInit` binds production defaults.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';
import type { RuntimeConfigWriter, WriteOptions } from './writers/writer.js';
import type { WriterDeps } from './probes.js';
import { makeStubWriterDeps } from './probes.js';
import type { ConfigWriteResult } from './schema.js';
import type { VcsEnvironment } from '../../vcs/detector.js';
import {
  handleInitWithWriters,
  INIT_STREAM_ID,
} from './index.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeWriter(
  runtime: string,
  result: ConfigWriteResult,
): RuntimeConfigWriter {
  return {
    runtime: runtime as RuntimeConfigWriter['runtime'],
    write: vi.fn<(deps: WriterDeps, options: WriteOptions) => Promise<ConfigWriteResult>>()
      .mockResolvedValue(result),
  };
}

function makeFailingWriter(
  runtime: string,
  error: string,
): RuntimeConfigWriter {
  return {
    runtime: runtime as RuntimeConfigWriter['runtime'],
    write: vi.fn<(deps: WriterDeps, options: WriteOptions) => Promise<ConfigWriteResult>>()
      .mockResolvedValue({
        runtime,
        path: `/stub/${runtime}`,
        status: 'failed',
        componentsWritten: [],
        error,
      }),
  };
}

async function createTestContext(): Promise<{ ctx: DispatchContext; stateDir: string }> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'init-test-'));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  return {
    ctx: { stateDir, eventStore, enableTelemetry: false },
    stateDir,
  };
}

const stubDetectVcs = vi.fn<() => Promise<VcsEnvironment | null>>();

// ─── T35: detect + write flow ──────────────────────────────────────────────

describe('Init Compositor', () => {
  let ctx: DispatchContext;
  let stateDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const result = await createTestContext();
    ctx = result.ctx;
    stateDir = result.stateDir;
    stubDetectVcs.mockResolvedValue(null);
  });

  it('HandleInit_DetectsRuntimes_WritesConfigs', async () => {
    // Arrange: two mock writers both succeed
    const writer1 = makeWriter('claude-code', {
      runtime: 'claude-code',
      path: '/home/.claude.json',
      status: 'written',
      componentsWritten: ['mcp-config'],
    });
    const writer2 = makeWriter('copilot', {
      runtime: 'copilot',
      path: '/project/.vscode/mcp.json',
      status: 'written',
      componentsWritten: ['mcp-config'],
    });

    // Act
    const result = await handleInitWithWriters(
      {},
      ctx,
      [writer1, writer2],
      stubDetectVcs,
      makeStubWriterDeps,
    );

    // Assert: both writers called, result is successful
    expect(result.success).toBe(true);
    expect(writer1.write).toHaveBeenCalledTimes(1);
    expect(writer2.write).toHaveBeenCalledTimes(1);
    const data = result.data as { runtimes: ConfigWriteResult[] };
    expect(data.runtimes).toHaveLength(2);
    expect(data.runtimes[0].runtime).toBe('claude-code');
    expect(data.runtimes[1].runtime).toBe('copilot');
  });

  it('HandleInit_PartialFailure_ReportsPerWriter', async () => {
    // Arrange: one writer succeeds, one fails
    const successWriter = makeWriter('claude-code', {
      runtime: 'claude-code',
      path: '/home/.claude.json',
      status: 'written',
      componentsWritten: ['mcp-config'],
    });
    const failWriter = makeFailingWriter('copilot', 'permission denied');

    // Act
    const result = await handleInitWithWriters(
      {},
      ctx,
      [successWriter, failWriter],
      stubDetectVcs,
      makeStubWriterDeps,
    );

    // Assert: result still succeeds but contains per-writer status
    expect(result.success).toBe(true);
    const data = result.data as { runtimes: ConfigWriteResult[] };
    expect(data.runtimes).toHaveLength(2);
    const written = data.runtimes.find(r => r.status === 'written');
    const failed = data.runtimes.find(r => r.status === 'failed');
    expect(written).toBeDefined();
    expect(written!.runtime).toBe('claude-code');
    expect(failed).toBeDefined();
    expect(failed!.runtime).toBe('copilot');
    expect(failed!.error).toBe('permission denied');
  });

  it('HandleInit_RuntimeFilter_OnlyRunsMatchingWriter', async () => {
    // Arrange: two writers but filter to copilot only
    const claudeWriter = makeWriter('claude-code', {
      runtime: 'claude-code',
      path: '/home/.claude.json',
      status: 'written',
      componentsWritten: ['mcp-config'],
    });
    const copilotWriter = makeWriter('copilot', {
      runtime: 'copilot',
      path: '/project/.vscode/mcp.json',
      status: 'written',
      componentsWritten: ['mcp-config'],
    });

    // Act
    const result = await handleInitWithWriters(
      { runtime: 'copilot' },
      ctx,
      [claudeWriter, copilotWriter],
      stubDetectVcs,
      makeStubWriterDeps,
    );

    // Assert: only copilot writer called
    expect(result.success).toBe(true);
    expect(claudeWriter.write).not.toHaveBeenCalled();
    expect(copilotWriter.write).toHaveBeenCalledTimes(1);
    const data = result.data as { runtimes: ConfigWriteResult[] };
    expect(data.runtimes).toHaveLength(1);
    expect(data.runtimes[0].runtime).toBe('copilot');
  });

  // ─── T36: VCS detection integration ────────────────────────────────────

  it('HandleInit_DetectsVcsProvider_IncludesInOutput', async () => {
    // Arrange: detector returns github
    const vcsEnv: VcsEnvironment = {
      provider: 'github',
      remoteUrl: 'https://github.com/org/repo.git',
      cliAvailable: true,
      cliVersion: '2.45.0',
    };
    stubDetectVcs.mockResolvedValue(vcsEnv);

    const writer = makeWriter('claude-code', {
      runtime: 'claude-code',
      path: '/home/.claude.json',
      status: 'written',
      componentsWritten: ['mcp-config'],
    });

    // Act
    const result = await handleInitWithWriters(
      {},
      ctx,
      [writer],
      stubDetectVcs,
      makeStubWriterDeps,
    );

    // Assert: vcs is populated in output
    expect(result.success).toBe(true);
    const data = result.data as { vcs: VcsEnvironment | null };
    expect(data.vcs).not.toBeNull();
    expect(data.vcs!.provider).toBe('github');
    expect(data.vcs!.remoteUrl).toBe('https://github.com/org/repo.git');
    expect(data.vcs!.cliAvailable).toBe(true);
    expect(data.vcs!.cliVersion).toBe('2.45.0');
  });

  it('HandleInit_VcsDetectionFails_OutputVcsIsNull', async () => {
    // Arrange: detector returns null
    stubDetectVcs.mockResolvedValue(null);

    const writer = makeWriter('claude-code', {
      runtime: 'claude-code',
      path: '/home/.claude.json',
      status: 'written',
      componentsWritten: ['mcp-config'],
    });

    // Act
    const result = await handleInitWithWriters(
      {},
      ctx,
      [writer],
      stubDetectVcs,
      makeStubWriterDeps,
    );

    // Assert: vcs is null
    expect(result.success).toBe(true);
    const data = result.data as { vcs: VcsEnvironment | null };
    expect(data.vcs).toBeNull();
  });

  // ─── T37: Event emission ───────────────────────────────────────────────

  it('HandleInit_Success_EmitsInitExecutedEvent', async () => {
    // Arrange
    const writer = makeWriter('claude-code', {
      runtime: 'claude-code',
      path: '/home/.claude.json',
      status: 'written',
      componentsWritten: ['mcp-config'],
    });
    stubDetectVcs.mockResolvedValue({
      provider: 'github',
      remoteUrl: 'https://github.com/org/repo.git',
      cliAvailable: true,
    });

    // Act
    const result = await handleInitWithWriters(
      {},
      ctx,
      [writer],
      stubDetectVcs,
      makeStubWriterDeps,
    );

    // Assert: event was emitted
    expect(result.success).toBe(true);
    const events = await ctx.eventStore.query(INIT_STREAM_ID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('init.executed');
    expect(events[0].data).toHaveProperty('runtimes');
    expect(events[0].data).toHaveProperty('durationMs');
    // vcs should be in the event data
    const eventData = events[0].data as { vcs: { provider: string } | null };
    expect(eventData.vcs).not.toBeNull();
    expect(eventData.vcs!.provider).toBe('github');
  });

  // Cleanup
  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });
});
