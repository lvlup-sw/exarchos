/**
 * handleInit — composes runtime writers and VCS detection into a single
 * init action.
 *
 * Design notes:
 *   - Parallel fan-out with `Promise.allSettled` so one writer failure
 *     does not block others.
 *   - Testable seam: `handleInitWithWriters` takes explicit writers,
 *     VCS detector, and deps factory. Production callers use `handleInit`
 *     which binds these to real implementations.
 *   - VCS detection runs in parallel with writers for wall-time
 *     efficiency.
 *   - Output validated via `InitOutputSchema.parse()` before return
 *     (mirrors doctor's DIM-3 self-check).
 */

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import type { RuntimeConfigWriter, WriteOptions } from './writers/writer.js';
import type { WriterDeps } from './probes.js';
import {
  buildWriterDeps as defaultBuildWriterDeps,
  makeStubWriterDeps,
} from './probes.js';
import { InitOutputSchema, type ConfigWriteResult, type InitOutput } from './schema.js';
import {
  detectVcsProvider as defaultDetectVcsProvider,
  type VcsEnvironment,
  type VcsDetectorDeps,
} from '../../vcs/detector.js';

// ─── Canonical writer list (lazy — populated by handleInit) ──────────────

import { ClaudeCodeWriter } from './writers/claude-code.js';

// ─── Constants ────────────────────────────────────────────────────────────

export const INIT_STREAM_ID = 'exarchos-init';

// ─── Types ────────────────────────────────────────────────────────────────

export interface HandleInitArgs {
  readonly runtime?: string;
  readonly vcs?: string;
  readonly nonInteractive?: boolean;
  readonly forceOverwrite?: boolean;
  readonly format?: 'table' | 'json';
}

// ─── Testable seam ────────────────────────────────────────────────────────

/**
 * Testable seam — accepts explicit writers and detector.
 * Tests inject mocks here; production callers use `handleInit`.
 */
export async function handleInitWithWriters(
  args: HandleInitArgs,
  ctx: DispatchContext,
  writers: ReadonlyArray<RuntimeConfigWriter>,
  detectVcs: (deps?: VcsDetectorDeps) => Promise<VcsEnvironment | null>,
  buildDeps: () => WriterDeps,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const deps = buildDeps();

  // Filter writers by runtime arg if specified
  const activeWriters = args.runtime
    ? writers.filter((w) => w.runtime === args.runtime)
    : [...writers];

  // Build write options
  const options: WriteOptions = {
    projectRoot: deps.cwd(),
    nonInteractive: args.nonInteractive ?? false,
    forceOverwrite: args.forceOverwrite ?? false,
  };

  // Run writers in parallel (Promise.allSettled — partial failure is OK)
  const writerPromises = activeWriters.map(async (writer): Promise<ConfigWriteResult> => {
    try {
      return await writer.write(deps, options);
    } catch (err) {
      return {
        runtime: writer.runtime,
        path: '',
        status: 'failed' as const,
        componentsWritten: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Run VCS detection in parallel with writers
  const [writerResults, vcsResult] = await Promise.all([
    Promise.allSettled(writerPromises).then((settled) =>
      settled.map((s): ConfigWriteResult => {
        if (s.status === 'fulfilled') return s.value;
        return {
          runtime: 'unknown',
          path: '',
          status: 'failed' as const,
          componentsWritten: [],
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        };
      }),
    ),
    detectVcs().catch((): null => null),
  ]);

  const durationMs = Date.now() - startedAt;

  // Build output
  const output: InitOutput = {
    runtimes: writerResults,
    vcs: vcsResult,
    durationMs,
  };

  // Validate output shape (DIM-3 self-check)
  const validated = InitOutputSchema.parse(output);

  // Emit init.executed event (best-effort — do not fail init output)
  try {
    await emitInitEvent(ctx, validated);
  } catch {
    // best-effort telemetry; do not fail init output
  }

  return {
    success: true,
    data: validated,
  };
}

// ─── Event emission ───────────────────────────────────────────────────────

async function emitInitEvent(
  ctx: DispatchContext,
  output: InitOutput,
): Promise<void> {
  await ctx.eventStore.append(INIT_STREAM_ID, {
    type: 'init.executed' as const,
    data: {
      runtimes: output.runtimes,
      vcs: output.vcs,
      durationMs: output.durationMs,
    },
  });
}

// ─── Production entry point ───────────────────────────────────────────────

/** All production writers. Order is preserved in output. */
function getAllWriters(): ReadonlyArray<RuntimeConfigWriter> {
  return [
    new ClaudeCodeWriter(),
    // Additional writers (copilot, cursor, codex, opencode) will be added
    // once they implement the RuntimeConfigWriter interface.
  ];
}

/**
 * Production entry point — binds real writers, VCS detector, and deps
 * factory.
 */
export async function handleInit(
  args: HandleInitArgs,
  ctx: DispatchContext,
): Promise<ToolResult> {
  return handleInitWithWriters(
    args,
    ctx,
    getAllWriters(),
    defaultDetectVcsProvider,
    defaultBuildWriterDeps,
  );
}
