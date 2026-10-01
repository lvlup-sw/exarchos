import { describe, it, expect } from 'vitest';
import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * POC acceptance for the SQLite-backed event-store substrate (#1259).
 *
 * AtomicAppender consumers are unchanged: the files under `src/` that name
 * `AtomicAppender` must be exactly the consumers the design pins, so swapping
 * the appender body needs no change outside it. The append throughput SLA
 * (1000 ops/sec per stream) is measured by the
 * `AppendUnkeyed_5000Sequential_SqliteBackend` arm in `store.bench.ts` (#2029).
 */

// v2.11 (DR-6, Phase 5b): `src/agents/spec.ts` was previously listed here
// because its `validateAgentSpec` JSDoc referenced `AtomicAppender` while
// surfacing the `spec.legacy_capabilities_array` deprecation event for the
// caller to flow through the appender. The legacy-capabilities path was
// hard-cut, so spec.ts no longer mentions the appender — the consumer set
// drops back to the four substrate-internal files.
//
// v2.10.0-preview.2 Wave 3 (#1314): the new `events/index.ts` barrel
// re-exports `AtomicAppender` (plus the Wave 3 typed errors) for Wave 4
// consumers. The barrel is a re-export site, NOT a behavioral change to
// the consumer set — it's still the substrate-internal cluster plus the
// public surface module.
//
// v2.10.0-preview.2 Wave 4 (#1340, audit §F1.2): the reference-migration
// commits add `verbs/merge/merge-orchestrate.ts` (Phase A — `decide`
// commits `merge.requested` purely before the executor's git-merge side
// effect fires) as the first consumer outside the substrate-internal
// cluster. This is the canonical "consumer outside the storage cluster"
// the AC3 gate has been waiting for since Wave 3.
const EXPECTED_CONSUMERS = [
  'src/events/atomic-appender.ts',
  'src/events/index.ts',
  'src/events/store.ts',
  'src/events/tools.ts',
  // Sorted order: the regroup moved these from `orchestrate/` to `verbs/`, which
  // now sorts AFTER `storage/` rather than before it.
  'src/storage/sqlite-backend.ts',
  // The five below are not new consumers. They are the declarations that were
  // in `sqlite-backend.ts` and now sit beside it — the wire types the appender
  // exchanges, the DDL, the prepared-statement shape, the error family and the
  // retry constants. The backend is still ONE consumer; the census counts files
  // and the file count went up, which is the whole difference.
  'src/storage/sqlite/constants.ts',
  'src/storage/sqlite/errors.ts',
  'src/storage/sqlite/schema.ts',
  'src/storage/sqlite/statements.ts',
  'src/storage/sqlite/wire-types.ts',
  'src/verbs/merge/execute-merge.ts',
  'src/verbs/merge/merge-orchestrate.ts',
  'src/verbs/worktree/manager.ts',
  'src/verbs/worktree/merge-serializer.ts',
  // P06-05 (structural-closure remediation): the admission chokepoint appends
  // the admission decision and the phase-lifecycle sibling in ONE `decideOnce`
  // transaction — the atomicity the work package's exit proof ("partial
  // decision/transition siblings are impossible") rests on. It consumes the
  // substrate rather than hand-rolling a transaction, which is exactly the
  // posture this gate exists to encourage.
  'src/workflow/admission/transition-command.ts',
] as const;

/**
 * Resolve `src` from this file's URL. The test
 * sits at `src/events/poc.acceptance.test.ts`, so two `..` jumps
 * land at `src/`.
 */
function resolveSrcRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../src');
}

/**
 * Recursively walk `dir` and return every `.ts` file path (relative to
 * `dir`'s parent — i.e. starting with `src/...`) that does NOT live
 * under `__tests__/` or `__shims__/` and does NOT end with `.test.ts`.
 *
 * The walk filters at the directory level (skip whole `__tests__/` and
 * `__shims__/` subtrees) and at the file level (`.test.ts` suffix).
 */
async function listProductionTsFiles(srcRoot: string): Promise<string[]> {
  const results: string[] = [];
  const repoRoot = path.dirname(srcRoot); // .../servers/exarchos-mcp

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir);
    for (const name of entries) {
      const full = path.join(dir, name);
      const st = await stat(full);
      if (st.isDirectory()) {
        if (name === '__tests__' || name === '__shims__') continue;
        await walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (!name.endsWith('.ts')) continue;
      if (name.endsWith('.test.ts')) continue;
      if (name.endsWith('.bench.ts')) continue;
      // Normalize to `src/...` form for stable assertions across
      // platforms (path.relative returns OS-flavored separators).
      const rel = path.relative(repoRoot, full).split(path.sep).join('/');
      results.push(rel);
    }
  }

  await walk(srcRoot);
  return results;
}

describe('Poc_SqliteBackend_AllConsumersUnchanged', () => {
  it('AC3 — exactly the expected src consumers reference AtomicAppender', async () => {
    const srcRoot = resolveSrcRoot();
    const candidates = await listProductionTsFiles(srcRoot);

    const consumers: string[] = [];
    for (const rel of candidates) {
      const repoRoot = path.dirname(srcRoot);
      const abs = path.join(repoRoot, rel);
      const text = await readFile(abs, 'utf-8');
      if (text.includes('AtomicAppender')) {
        consumers.push(rel);
      }
    }
    consumers.sort();

    expect(consumers).toEqual([...EXPECTED_CONSUMERS]);
  });

});
