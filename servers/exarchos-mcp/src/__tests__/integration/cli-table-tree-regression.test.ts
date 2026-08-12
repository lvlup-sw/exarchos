// ─── F.7: CLI table / tree pretty-print regression (Wave 0, design §7) ─────
//
// Snapshots the human-readable stdout (`prettyPrint` table/tree paths) for
// representative read-only CLI commands so any reshape of the table or
// tree renderer fails CI rather than being discovered by an operator
// staring at a different-shaped terminal.
//
// Rationale on flag selection
// ---------------------------
// The plan's literal example was `--format table` / `--format tree`. In
// the current CLI surface (adapters/cli.ts) only a handful of actions
// declare `format: z.enum(['table','json'])` in their input schema, and
// none of them admit `tree`. The `prettyPrint` renderer in
// `cli-format.ts` instead INFERS format from the shape of `result.data`
// (`isTabular` → table, `isTreeLike` → tree, else JSON). So the realistic
// way to exercise both rendering paths is to invoke actions whose data
// shape lands on each branch:
//   • `vw ls` (no flags)              → ToolResult.data = { workflows: [],
//                                       total: 0 } → tree path.
//   • `wf describe`                    → describe handler returns a tabular
//                                       array of action descriptors →
//                                       table path.
// We snapshot both and accept the inferred path. The point of the
// regression is "the table/tree formatter output for these inputs is
// stable post-carrier-swap"; the inference rule is part of the contract.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildCli } from '../../adapters/cli/cli.js';
import { EventStore } from '../../events/store.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

interface CapturedStreams {
  stdout: string;
  stderr: string;
}

async function captureCli(
  ctx: DispatchContext,
  argv: readonly string[],
): Promise<CapturedStreams> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((data: unknown): boolean => {
      stdoutChunks.push(typeof data === 'string' ? data : String(data));
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((data: unknown): boolean => {
      stderrChunks.push(typeof data === 'string' ? data : String(data));
      return true;
    });
  try {
    const program = buildCli(ctx);
    program.exitOverride();
    await program.parseAsync(['node', 'exarchos', ...argv]);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

/**
 * Strip the `_perf` footer that `prettyPrint` writes to stderr
 * (`{ms}ms | {bytes}B | ~{tokens} tokens`). Wall-clock + byte counts vary
 * per run and would defeat snapshot stability. We keep the rest of stderr
 * (warnings, checkpoint advisories, eventHints) intact since those are
 * deterministic for a fixed input shape.
 */
function stripPerfFooter(stderr: string): string {
  return stderr.replace(/^\s*\d+ms \| \d+B \| ~\d+ tokens\s*$/gm, '<<perf>>');
}

describe('F.7 — CLI table/tree pretty-print regression (Wave 0 §7)', () => {
  let tmpDir: string;
  let ctx: DispatchContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-table-tree-test-'));
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false };
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  it('CliRender_VwLs_TreeOrJsonPath_StableSnapshot', async () => {
    // `vw ls` with an empty state directory returns the scoped pipeline
    // shape `{ workflows: [], total: 0, unscopedTotal: 0, page: { total,
    // offset, limit, hasMore }, scope: 'repo' }`. `isTreeLike` is TRUE for
    // that shape — the `page` object (and the `workflows` array) are
    // non-null object values — so prettyPrint takes the TREE path:
    // `page:` renders as an indented child block, NOT flattened to JSON
    // or a table. The nested `page` object is what pins the branch to
    // tree; the inference outcome is part of the contract pin, not a
    // separate axiom.
    const { stdout, stderr } = await captureCli(ctx, ['vw', 'ls']);
    expect({ stdout, stderr: stripPerfFooter(stderr) }).toMatchSnapshot();
  });

  it('CliRender_WfDescribeActionInit_TreeOrInferredPath_StableSnapshot', async () => {
    // `wf describe --actions init` returns a single action descriptor —
    // an object with nested children (`schema`, `phases`, `roles`,
    // `cli.examples`...). `isTreeLike` returns true → prettyPrint emits
    // the indented-tree rendering. Snapshotting both stdout (tree
    // body) and stderr (perf footer stripped) catches any regression in
    // either path post-carrier-swap.
    const { stdout, stderr } = await captureCli(ctx, [
      'wf',
      'describe',
      '--actions',
      'init',
    ]);
    expect({ stdout, stderr: stripPerfFooter(stderr) }).toMatchSnapshot();
  });
});
