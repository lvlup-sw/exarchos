/**
 * Snapshot regression for the human-readable CLI output. A change to the rendering of `prettyPrint` fails CI.
 *
 * `prettyPrint` in `cli-format.ts` infers the format from the shape of `result.data`.
 * `isTabular` gives a table, `isTreeLike` gives a tree, and any other shape gives JSON.
 * Each test calls an action with no format flag, and its snapshot pins the inferred branch.
 * The inference rule is part of the contract. Both actions return tree-like data, so no test here renders a table.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildCli } from '../../src/adapters/cli/cli.js';
import { EventStore } from '../../src/events/store.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

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
 * Replaces the perf footer that `prettyPrint` writes to stderr (`{ms}ms | {bytes}B | ~{tokens} tokens`) with `<<perf>>`.
 * The time and the byte count change on each run. The rest of stderr stays, because it is deterministic for a fixed input.
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

  /**
   * With an empty state directory, `vw ls` returns `workflows`, `total`, `unscopedTotal`, `page` and `scope`.
   * `isTreeLike` is true for that shape, because `page` and `workflows` are object values.
   * So `prettyPrint` renders a tree, and `page:` is an indented child block.
   */
  it('CliRender_VwLs_TreeOrJsonPath_StableSnapshot', async () => {
    const { stdout, stderr } = await captureCli(ctx, ['vw', 'ls']);
    expect({ stdout, stderr: stripPerfFooter(stderr) }).toMatchSnapshot();
  });

  /**
   * `wf describe --actions init` returns an object that holds the descriptor of `init`, with nested children such as `schema`.
   * `isTreeLike` is true, so `prettyPrint` renders a tree.
   * The snapshot holds stdout and the stderr with the perf footer replaced.
   */
  it('CliRender_WfDescribeActionInit_TreeOrInferredPath_StableSnapshot', async () => {
    const { stdout, stderr } = await captureCli(ctx, [
      'wf',
      'describe',
      '--actions',
      'init',
    ]);
    expect({ stdout, stderr: stripPerfFooter(stderr) }).toMatchSnapshot();
  });
});
