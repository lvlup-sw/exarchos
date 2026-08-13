/**
 * Task 068 / DR-24 — the catalog's write path must be at least as strong as its
 * own read path.
 *
 * The defect this file pins: `invariants_add` honored an explicit `args.id` with
 * no membership test, so authoring `id: "INV-17"` into a catalog that already
 * contained INV-17 returned `success: true` with an append diff — producing a
 * file the loader then REFUSES to read (`parseInvariantEntries` throws
 * `Duplicate invariant ID: INV-17`). A writer that can author a document its own
 * reader rejects is the defect class this program exists to remove.
 *
 * Three properties are proven here:
 *
 *  1. **Kill fixture** — the exact probe that exposed the defect: `handleAdd`
 *     with explicit `id: 'INV-17'` against the REAL committed dev catalog (which
 *     contains INV-17) must FAIL, on both the dry-run and the commit path.
 *  2. **Shared rule, not a restatement** — the writer's verdict is produced by
 *     the LOADER's exported rule (`findDuplicateInvariantId`), so reader and
 *     writer cannot drift. Proven behaviorally: a data-driven table is submitted
 *     to BOTH the reader (`parseInvariantEntries`) and the writer (`handleAdd`)
 *     and their verdicts must agree case-for-case.
 *  3. **Non-empty denominator** — a uniqueness check whose denominator does not
 *     RESOLVE (a moved/renamed `invariants:` key, an entry with no readable id)
 *     must fail rather than read as "no collisions".
 */
import { describe, it, expect } from 'vitest';

import * as nodePath from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { handleAdd } from './add.js';
import { readCatalogIds } from './catalog-file.js';
import type { ScaffoldDeps } from './scaffold.js';
import { EXARCHOS_PACKAGE_NAME } from './reserved-tier-guard.js';
import { toPosix } from '../../utils/paths.js';
import {
  findDuplicateInvariantId,
  duplicateInvariantIdMessage,
  parseInvariantEntries,
} from '../../architecture/invariants-loader.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

function makeFakeFs(seed: Record<string, string>): {
  deps: ScaffoldDeps;
  writes: Array<{ path: string; contents: string }>;
} {
  // Key every path through `toPosix`, because that is what production does:
  // `reserved-tier-guard` looks up `toPosix(path.join(repoRoot, 'package.json'))`.
  // On Windows `REPO_ROOT` carries backslashes, so a template-built seed key like
  // `${REPO_ROOT}/package.json` is mixed-separator and can never match the guard's
  // all-forward-slash lookup. A real filesystem does not care which separator the
  // caller used; a Map keyed on the raw string does, and that difference made the
  // guard read "not an exarchos repo" on Windows only.
  const files = new Map<string, string>(
    Object.entries(seed).map(([p, contents]) => [toPosix(p), contents]),
  );
  // These fixtures author at `tier: 'dev'` (the INV-N namespace INV-17 lives
  // in), so the reserved-tier guard (#1489) must see an exarchos repo or it
  // short-circuits with RESERVED_TIER before the id check is ever reached.
  files.set(
    toPosix(`${REPO_ROOT}/package.json`),
    JSON.stringify({ name: EXARCHOS_PACKAGE_NAME }),
  );
  const writes: Array<{ path: string; contents: string }> = [];
  return {
    writes,
    deps: {
      exists: (p) => files.has(toPosix(p)),
      read: (p) => {
        const c = files.get(toPosix(p));
        if (c === undefined) throw new Error(`ENOENT: ${p}`);
        return c;
      },
      write: (p, contents) => {
        files.set(toPosix(p), contents);
        writes.push({ path: p, contents });
      },
    },
  };
}

function makeCtx(): DispatchContext {
  return {
    stateDir: '/tmp/state',
    enableTelemetry: false,
    eventStore: { append: async () => undefined as never },
  } as unknown as DispatchContext;
}

/** Repo root of the exarchos checkout this test runs from. */
const REPO_ROOT = nodePath.resolve(
  nodePath.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);

/** The REAL committed dev catalog — the subject of the original probe. */
function realDevCatalog(): string {
  return fs.readFileSync(
    nodePath.join(REPO_ROOT, '.exarchos/invariants.md'),
    'utf8',
  );
}

/** A minimal valid `mode: audit` entry body (id supplied separately). */
const VALID_ENTRY = {
  dimension: 'example-dimension',
  axis: 'substrate' as const,
  'cost-of-load': 'reference-only' as const,
  'applies-to': ['src/**/*.ts'],
  summary: 'A rule that already has an id in the catalog.',
  references: ['docs/architecture/some-design.md'],
  severity: { default: 'advisory' as const },
  'integrity-class': 'substrate' as const,
  enforcement: {
    mode: 'audit' as const,
    'audit-prompt': 'Does the diff violate the rule? Cite the file + line.',
  },
};

function errorOf(result: ToolResult): { code?: string; message?: string } {
  const err = (result as { error?: unknown }).error;
  if (err === null || typeof err !== 'object') return {};
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  return {
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof message === 'string' ? { message } : {}),
  };
}

// ─── 1. Kill fixture ─────────────────────────────────────────────────────────

describe('DR-24 kill fixture — colliding explicit id must fail at WRITE time', () => {
  const CATALOG = '.exarchos/invariants.md';
  const ABS = `${REPO_ROOT}/${CATALOG}`;

  it('handleAdd_ExplicitIdCollidesWithRealDevCatalog_Fails', async () => {
    // The exact probe from task 019: the real catalog already contains INV-17.
    const contents = realDevCatalog();
    expect(contents).toContain('id: INV-17');

    const fake = makeFakeFs({ [ABS]: contents });

    const result = await handleAdd(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'dev',
        id: 'INV-17',
        entry: { ...VALID_ENTRY },
        dryRun: false,
      },
      makeCtx(),
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(errorOf(result).code).toBe('DUPLICATE_INVARIANT_ID');
    // Nothing was written — a rejected write must not touch the catalog.
    expect(fake.writes).toHaveLength(0);
  });

  it('handleAdd_ExplicitIdCollides_FailsOnDryRunToo', async () => {
    // dryRun is the DEFAULT and the previewed diff is what an agent commits
    // from. A preview that renders clean and then fails on commit would just
    // move the defect one call later.
    const fake = makeFakeFs({ [ABS]: realDevCatalog() });

    const result = await handleAdd(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'dev',
        id: 'INV-17',
        entry: { ...VALID_ENTRY },
        dryRun: true,
      },
      makeCtx(),
      fake.deps,
    );

    expect(result.success).toBe(false);
    expect(errorOf(result).code).toBe('DUPLICATE_INVARIANT_ID');
  });

  it('handleAdd_ExplicitIdIsFree_StillSucceeds', async () => {
    // The guard must reject collisions, not explicit ids. Without this the
    // kill fixture above would pass against a handler that rejects everything.
    const fake = makeFakeFs({ [ABS]: realDevCatalog() });

    const result = await handleAdd(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'dev',
        id: 'INV-9999',
        entry: { ...VALID_ENTRY },
        dryRun: true,
      },
      makeCtx(),
      fake.deps,
    );

    expect(result.success).toBe(true);
    expect((result.data as { id: string }).id).toBe('INV-9999');
  });

  it('handleAdd_CollisionRejected_CatalogStillLoads', async () => {
    // The property that was actually broken: whatever the writer leaves on
    // disk must still parse through the READER. After a rejected collision the
    // catalog is byte-identical, so the reader still accepts it.
    const before = realDevCatalog();
    const fake = makeFakeFs({ [ABS]: before });

    await handleAdd(
      {
        repoRoot: REPO_ROOT,
        catalog: CATALOG,
        tier: 'dev',
        id: 'INV-17',
        entry: { ...VALID_ENTRY },
        dryRun: false,
      },
      makeCtx(),
      fake.deps,
    );

    expect(fake.writes).toHaveLength(0);
    // Reader accepts the untouched catalog.
    const scan = readCatalogIds(before);
    expect(scan.resolved).toBe(true);
  });
});

// ─── 2. One rule, two callers (shared with the loader, not restated) ─────────

/**
 * Policy as DATA (PDD §3a): each case is a prospective id list. The SAME table
 * is submitted to the reader and to the writer; their verdicts must agree.
 * `expectDuplicate` is the id the shared rule is expected to name, or `null`.
 */
interface UniquenessCase {
  readonly name: string;
  readonly existingIds: readonly string[];
  readonly newId: string;
  readonly expectDuplicate: string | null;
}

const UNIQUENESS_CASES: readonly UniquenessCase[] = [
  {
    name: 'collision with the first entry',
    existingIds: ['INV-1', 'INV-2', 'INV-17'],
    newId: 'INV-1',
    expectDuplicate: 'INV-1',
  },
  {
    name: 'collision with the last entry',
    existingIds: ['INV-1', 'INV-2', 'INV-17'],
    newId: 'INV-17',
    expectDuplicate: 'INV-17',
  },
  {
    name: 'free id in a populated catalog',
    existingIds: ['INV-1', 'INV-2', 'INV-17'],
    newId: 'INV-18',
    expectDuplicate: null,
  },
  {
    name: 'free id in a resolvable-but-empty catalog',
    existingIds: [],
    newId: 'INV-1',
    expectDuplicate: null,
  },
  {
    name: 'ids are case-sensitive — inv-17 does not collide with INV-17',
    existingIds: ['INV-17'],
    newId: 'inv-17',
    expectDuplicate: null,
  },
];

/** Render a raw catalog entry list the LOADER's parser accepts. */
function rawEntries(ids: readonly string[]): unknown[] {
  return ids.map((id) => ({
    id,
    dimension: 'd',
    axis: 'substrate',
    'cost-of-load': 'reference-only',
    'applies-to': ['src/**'],
    summary: 's',
    references: [],
  }));
}

describe('DR-6 — the writer derives its verdict from the LOADER rule', () => {
  it.each(UNIQUENESS_CASES)(
    'ReaderAndWriterAgree: $name',
    async ({ existingIds, newId, expectDuplicate }) => {
      // ── Reader verdict: does `parseInvariantEntries` reject the document
      //    that WOULD result from this write?
      const prospective = [...existingIds, newId];
      let readerRejected: string | null = null;
      try {
        parseInvariantEntries(rawEntries(prospective));
      } catch (err) {
        readerRejected = err instanceof Error ? err.message : String(err);
      }

      // ── Writer verdict: does `handleAdd` refuse the same write?
      const CATALOG = '.exarchos/invariants.md';
      const ABS = `${REPO_ROOT}/${CATALOG}`;
      const yaml =
        existingIds.length === 0
          ? 'invariants: []\n'
          : `invariants:\n${existingIds
              .map((id) => `  - id: ${id}\n    dimension: d\n`)
              .join('')}`;
      const fake = makeFakeFs({ [ABS]: yaml });
      const result = await handleAdd(
        {
          repoRoot: REPO_ROOT,
          catalog: CATALOG,
          tier: 'dev',
          id: newId,
          entry: { ...VALID_ENTRY },
          dryRun: true,
        },
        makeCtx(),
        fake.deps,
      );
      const writerRejected = result.success ? null : errorOf(result).message ?? '';

      // ── The two must agree, case for case.
      if (expectDuplicate === null) {
        expect(readerRejected).toBeNull();
        expect(writerRejected).toBeNull();
      } else {
        // Reader rejects, writer rejects, and both name the SAME id via the
        // SAME message builder — proof the rule is shared, not restated.
        expect(readerRejected).toBe(duplicateInvariantIdMessage(expectDuplicate));
        expect(writerRejected).toContain(
          duplicateInvariantIdMessage(expectDuplicate),
        );
      }
    },
  );

  it('LoaderRule_IsTheSingleAuthority_WriterHasNoSecondCopy', () => {
    // Structural fact, measured directly: the exported rule is the thing that
    // decides, and it is the thing the loader's own message builder describes.
    // If a future edit gave the writer its own Set-based loop, this table would
    // still pass — so the load-bearing proof is the behavioral agreement above
    // PLUS this: the loader's rule is exported and total over the id list.
    expect(findDuplicateInvariantId(['A', 'B', 'A'])).toBe('A');
    expect(findDuplicateInvariantId(['A', 'B'])).toBeUndefined();
    expect(findDuplicateInvariantId([])).toBeUndefined();
    expect(duplicateInvariantIdMessage('INV-17')).toBe(
      'Duplicate invariant ID: INV-17',
    );
  });

  it('LoaderRule_RejectionMessage_IsUnchangedFromBeforeExtraction', () => {
    // The loader's wire-visible error text is a contract other callers match
    // on. Extracting the rule must not have changed it.
    expect(() => parseInvariantEntries(rawEntries(['INV-17', 'INV-17']))).toThrow(
      'Duplicate invariant ID: INV-17',
    );
  });
});

// ─── 3. Non-empty denominator ────────────────────────────────────────────────

/**
 * Policy as DATA: catalog shapes whose id list does NOT resolve. Each must be
 * refused, never silently treated as "zero existing ids, so no collisions".
 */
const UNRESOLVABLE_CATALOGS: ReadonlyArray<{
  readonly name: string;
  readonly contents: string;
}> = [
  { name: 'invariants: key absent entirely', contents: 'schema-version: 3\n' },
  {
    name: 'invariants: key renamed (a moved/renamed catalog shape)',
    contents: 'schema-version: 3\ninvariant_list:\n  - id: INV-17\n',
  },
  { name: 'invariants: is null', contents: 'invariants:\n' },
  { name: 'invariants: is a map, not a sequence', contents: 'invariants: {}\n' },
  { name: 'invariants: is a scalar', contents: 'invariants: nope\n' },
  {
    name: 'an entry carries no readable id',
    contents: 'invariants:\n  - dimension: d\n',
  },
  {
    name: 'an entry has a non-string id',
    contents: 'invariants:\n  - id: 17\n',
  },
  { name: 'file is empty', contents: '' },
];

describe('DR-24 non-empty denominator — an unresolved id list must not read as "no collisions"', () => {
  it.each(UNRESOLVABLE_CATALOGS)(
    'readCatalogIds_Unresolvable_Fails: $name',
    ({ contents }) => {
      const scan = readCatalogIds(contents);
      expect(scan.resolved).toBe(false);
    },
  );

  it('readCatalogIds_ResolvableButEmpty_Resolves', () => {
    // A freshly scaffolded catalog is `invariants: []` — genuinely zero
    // entries. That is a RESOLVED empty denominator and must stay usable, or
    // `invariants_add` could never author the first entry. The tooth is
    // resolvability, not cardinality.
    const scan = readCatalogIds('invariants: []\n');
    expect(scan.resolved).toBe(true);
    if (scan.resolved) expect(scan.ids).toEqual([]);
  });

  it.each(UNRESOLVABLE_CATALOGS)(
    'handleAdd_UnresolvableDenominator_Refuses: $name',
    async ({ contents }) => {
      const CATALOG = '.exarchos/invariants.md';
      const ABS = `${REPO_ROOT}/${CATALOG}`;
      const fake = makeFakeFs({ [ABS]: contents });

      const result = await handleAdd(
        {
          repoRoot: REPO_ROOT,
          catalog: CATALOG,
          tier: 'dev',
          id: 'INV-17',
          entry: { ...VALID_ENTRY },
          dryRun: false,
        },
        makeCtx(),
        fake.deps,
      );

      expect(result.success).toBe(false);
      expect(errorOf(result).code).toBe('CATALOG_UNREADABLE');
      expect(fake.writes).toHaveLength(0);
    },
  );
});
