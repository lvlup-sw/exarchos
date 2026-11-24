/**
 * Bound for catalog patterns that the invariant conformance gate compiles and matches.
 *
 * A review checkout can carry a user catalog, and the review runbook passes that checkout's diff
 * to `check_invariant_conformance`. These tests drive that dispatch. They fail while a nested
 * quantifier keeps the match from returning. They pass when the gate returns a verdict inside
 * the deadline for every leaf kind.
 */
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const repoRootOfWorkspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const entryPath = path.join(
  repoRootOfWorkspace,
  'tests/unit/architecture/invariant-check-redos-entry.mjs',
);
const workerPath = path.join(
  repoRootOfWorkspace,
  'tests/unit/architecture/invariant-check-redos-worker.ts',
);

/** A match that has not returned by now has left the review gate. */
const MATCH_DEADLINE_MS = 8_000;
/** Importing the server and evaluating a literal pattern stays well under this. */
const SAFE_DEADLINE_MS = 30_000;

interface ChildWatch {
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly code: number | null;
}

/**
 * Spawns the worker and kills it if the exploding match does not return.
 * The deadline starts when the worker reports that the safe match finished.
 * The exploding match starts next, so module load is not counted as matcher time.
 */
async function watchKind(kind: string): Promise<ChildWatch> {
  const checkout = await mkdtemp(path.join(tmpdir(), 'inv-redos-repo-'));
  const stateDir = await mkdtemp(path.join(tmpdir(), 'inv-redos-state-'));
  const child = spawn(
    process.execPath,
    ['--import', entryPath, '--import', 'tsx', workerPath, checkout, stateDir, kind],
    { cwd: repoRootOfWorkspace, env: process.env },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  let timedOut = false;
  let evilSeenAt: number | undefined;
  const started = Date.now();
  const killer = setInterval(() => {
    if (stdout.includes('EVIL_START')) {
      evilSeenAt ??= Date.now();
      if (Date.now() - evilSeenAt >= MATCH_DEADLINE_MS && !stdout.includes('RETURNED')) {
        timedOut = true;
        child.kill('SIGKILL');
      }
    } else if (Date.now() - started >= SAFE_DEADLINE_MS) {
      timedOut = true;
      child.kill('SIGKILL');
    }
  }, 50);

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode));
  });
  clearInterval(killer);
  await rmrfAsync(checkout);
  await rmrfAsync(stateDir);
  return { stdout, stderr, timedOut, code };
}

/**
 * The worker prints `RETURNED` also after a failed dispatch. A verdict needs the marker with
 * `success: true` and a clean exit of the worker.
 */
function expectVerdict(watched: ChildWatch): void {
  const line = watched.stdout.split('\n').find((text) => text.startsWith('RETURNED '));
  expect(line, `${watched.stdout}\n${watched.stderr}`).toBeDefined();
  const returned: unknown = JSON.parse((line ?? '').slice('RETURNED '.length));
  expect(returned, watched.stderr).toMatchObject({ success: true });
  expect(watched.code, watched.stderr).toBe(0);
}

describe('invariant conformance bounds catalog patterns', () => {
  /**
   * A grep leaf under a user catalog, including a file glob, must return a verdict. The pattern is
   * a repeated group of one or more characters anchored at the end, and the diff does not satisfy it.
   */
  it('CheckInvariantConformance_GrepNestedQuantifier_ReturnsWithinDeadline', async () => {
    const watched = await watchKind('grep');
    expect(watched.stdout, watched.stderr).toContain('SAFE_OK');
    expect(watched.timedOut, `${watched.stdout}\n${watched.stderr}`).toBe(false);
    expectVerdict(watched);
  });

  /**
   * A structural leaf under `all-of` and `scope` uses the same matcher as grep. A nested quantifier
   * on that arm must return a verdict in the same bound.
   */
  it('CheckInvariantConformance_StructuralNestedQuantifier_ReturnsWithinDeadline', async () => {
    const watched = await watchKind('structural');
    expect(watched.stdout, watched.stderr).toContain('SAFE_OK');
    expect(watched.timedOut, `${watched.stdout}\n${watched.stderr}`).toBe(false);
    expectVerdict(watched);
  });

  /**
   * A heuristic leaf under `any-of` uses the same matcher as grep. A nested quantifier on that arm
   * must return a verdict in the same bound.
   */
  it('CheckInvariantConformance_HeuristicNestedQuantifier_ReturnsWithinDeadline', async () => {
    const watched = await watchKind('heuristic');
    expect(watched.stdout, watched.stderr).toContain('SAFE_OK');
    expect(watched.timedOut, `${watched.stdout}\n${watched.stderr}`).toBe(false);
    expectVerdict(watched);
  });

  /**
   * A `not` node runs its child matcher before inverting the result. A nested quantifier under
   * `not` must return a verdict in the same bound.
   */
  it('CheckInvariantConformance_NegatedNestedQuantifier_ReturnsWithinDeadline', async () => {
    const watched = await watchKind('negated');
    expect(watched.stdout, watched.stderr).toContain('SAFE_OK');
    expect(watched.timedOut, `${watched.stdout}\n${watched.stderr}`).toBe(false);
    expectVerdict(watched);
  });
});
