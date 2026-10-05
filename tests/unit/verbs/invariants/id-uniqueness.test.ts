/**
 * The write path of the catalog must be at least as strong as its read path. The loader rejects a
 * duplicate id, so `invariants_add` must refuse an explicit `args.id` that the catalog already holds.
 *
 * - Kill fixture: `handleAdd` with an id from the real committed dev catalog must fail, on the dry run
 *   and on the commit path.
 * - Shared rule: the writer gets its verdict from the exported loader rule `findDuplicateInvariantId`.
 *   One data table goes to the reader and to the writer, and their verdicts must agree.
 * - Resolved denominator: a uniqueness check whose id list does not resolve must fail, and not read
 *   as "no collisions".
 */
import { describe, it, expect } from 'vitest';

import * as nodePath from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import { handleAdd } from '../../../../src/verbs/invariants/add.js';
import { readCatalogIds } from '../../../../src/verbs/invariants/catalog-file.js';
import type { ScaffoldDeps } from '../../../../src/verbs/invariants/scaffold.js';
import { EXARCHOS_PACKAGE_NAME } from '../../../../src/verbs/invariants/reserved-tier-guard.js';
import { toPosix } from '../../../../src/utils/paths.js';
import {
  findDuplicateInvariantId,
  duplicateInvariantIdMessage,
  parseInvariantEntries,
} from '../../../../src/architecture/invariants-loader.js';

/**
 * Keys every path through `toPosix`, like production. On Windows a seed key built from `REPO_ROOT`
 * mixes separators and does not match the forward-slash lookup of the reserved-tier guard.
 * The fixtures author at `tier: 'dev'`, so the fake seeds an exarchos `package.json`. Otherwise the
 * guard refuses with RESERVED_TIER before the id check.
 */
function makeFakeFs(seed: Record<string, string>): {
  deps: ScaffoldDeps;
  writes: Array<{ path: string; contents: string }>;
} {
  const files = new Map<string, string>(
    Object.entries(seed).map(([p, contents]) => [toPosix(p), contents]),
  );
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
  '../../../..',
);

/** The real committed dev catalog. */
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

describe('DR-24 kill fixture — colliding explicit id must fail at WRITE time', () => {
  const CATALOG = '.exarchos/invariants.md';
  const ABS = `${REPO_ROOT}/${CATALOG}`;

  /** The real dev catalog already holds the id, so the write must fail and write nothing. */
  it('handleAdd_ExplicitIdCollidesWithRealDevCatalog_Fails', async () => {
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
    expect(fake.writes).toHaveLength(0);
  });

  /**
   * The dry run is the default, and an agent commits from the previewed diff. A clean preview that then
   * fails on commit moves the defect one call later.
   */
  it('handleAdd_ExplicitIdCollides_FailsOnDryRunToo', async () => {
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

  /**
   * The guard must reject collisions, not explicit ids. Without this test, the kill fixture also passes
   * against a handler that rejects every id.
   */
  it('handleAdd_ExplicitIdIsFree_StillSucceeds', async () => {
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

  /**
   * The catalog that the writer leaves must still parse through the reader. After a rejected collision
   * the writer writes nothing, so the catalog is unchanged.
   */
  it('handleAdd_CollisionRejected_CatalogStillLoads', async () => {
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
    const scan = readCatalogIds(before);
    expect(scan.resolved).toBe(true);
  });
});

/**
 * One case of the data table: a prospective id list. The reader and the writer get the same table,
 * and their verdicts must agree. `expectDuplicate` is the id that the shared rule names, or `null`.
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

/** Renders a raw catalog entry list that the loader parser accepts. */
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
  /**
   * The reader parses the id list that the write produces. The writer gets the same write as a dry run.
   * Both must reject the same cases with the same `duplicateInvariantIdMessage` text.
   */
  it.each(UNIQUENESS_CASES)(
    'ReaderAndWriterAgree: $name',
    async ({ existingIds, newId, expectDuplicate }) => {
      const prospective = [...existingIds, newId];
      let readerRejected: string | null = null;
      try {
        parseInvariantEntries(rawEntries(prospective));
      } catch (err) {
        readerRejected = err instanceof Error ? err.message : String(err);
      }

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

      if (expectDuplicate === null) {
        expect(readerRejected).toBeNull();
        expect(writerRejected).toBeNull();
      } else {
        expect(readerRejected).toBe(duplicateInvariantIdMessage(expectDuplicate));
        expect(writerRejected).toContain(
          duplicateInvariantIdMessage(expectDuplicate),
        );
      }
    },
  );

  /**
   * The loader rule is exported and total over the id list. This test does not detect a second copy of
   * the rule in the writer. The agreement table above shows only that the two give the same verdicts.
   */
  it('LoaderRule_IsTheSingleAuthority_WriterHasNoSecondCopy', () => {
    expect(findDuplicateInvariantId(['A', 'B', 'A'])).toBe('A');
    expect(findDuplicateInvariantId(['A', 'B'])).toBeUndefined();
    expect(findDuplicateInvariantId([])).toBeUndefined();
    expect(duplicateInvariantIdMessage('INV-17')).toBe(
      'Duplicate invariant ID: INV-17',
    );
  });

  /** The loader error text is a contract that other callers match, so the text must stay the same. */
  it('LoaderRule_RejectionMessage_IsUnchangedFromBeforeExtraction', () => {
    expect(() => parseInvariantEntries(rawEntries(['INV-17', 'INV-17']))).toThrow(
      'Duplicate invariant ID: INV-17',
    );
  });
});

/** Catalog shapes whose id list does not resolve. Each must be refused, and not read as zero ids. */
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

  /**
   * A new scaffolded catalog is `invariants: []` with zero entries. That empty list resolves, so
   * `invariants_add` can author the first entry. The check is resolvability, not count.
   */
  it('readCatalogIds_ResolvableButEmpty_Resolves', () => {
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
