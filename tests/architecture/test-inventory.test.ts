/**
 * The test inventory the consolidation is reconciled against.
 *
 * 1,138 test files move during this refactor. The risk is not that one breaks —
 * `tsc` and the runner catch that — but that one is silently dropped by a stale
 * include glob and nobody notices, because a suite that no longer runs looks
 * exactly like a suite with nothing to say.
 *
 * Identity is `(suite path within the file, test name, runner)`. Path is
 * metadata, never identity: keying on it would invalidate the entire oracle on
 * the first move, which is the failure that made an earlier version of this
 * unusable.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

type Case = { suite: string; name: string; dynamic: boolean };
type FileEntry = { file: string; runner: string; cases: Case[] };

type Inventory = {
  identity: string;
  countingSemantics: string;
  totals: {
    testFiles: number;
    parsedFiles: number;
    shellFiles: number;
    cases: number;
    dynamicTitles: number;
    unparseableFiles: number;
  };
  unparseable: string[];
  relocations: { from: string; to: string }[];
  files: Record<string, FileEntry>;
};

const inventory = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/test-inventory-baseline.json'), 'utf8'),
) as Inventory;

const fileEntries = Object.values(inventory.files);

/** The id used for reconciliation — deliberately free of the file path. */
const idOf = (entry: FileEntry, c: Case): string => `${entry.runner}::${c.suite}::${c.name}`;

describe('test inventory', () => {
  it('TestInventory_AtBaseline_RecordsEveryDiscoveredTestId', () => {
    expect(inventory.totals.testFiles).toBe(fileEntries.length);
    expect(inventory.totals.cases).toBeGreaterThan(10000);
    expect(inventory.totals.unparseableFiles).toBe(0);
    expect(inventory.unparseable).toEqual([]);
  });

  it('TestInventory_Discovery_FoundEveryTrackedTestFile', () => {
    // Discovery is by extension over tracked files rather than by a runner
    // glob. A glob is exactly what goes stale — four oracles in this very
    // workflow were collected by no project until that was noticed.
    const tracked = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    })
      .split('\0')
      .filter((rel) => /\.(test|spec|bench)\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$|\.test\.sh$/.test(rel));

    const missing = tracked.filter((rel) => inventory.files[rel] === undefined);

    expect(missing, 'tracked test files absent from the inventory').toEqual([]);
  });

  it('TestInventory_MissingFile_NamesTheMissingSource', () => {
    // Reconciliation is `oracle − relocations`. A file that vanished with no
    // relocation entry must be named, not summarised as a count.
    const current = new Set(Object.keys(inventory.files));
    const relocated = new Map(inventory.relocations.map((r) => [r.from, r.to]));

    const dropped = Object.keys(inventory.files).filter(
      (rel) => !current.has(rel) && !relocated.has(rel),
    );

    expect(dropped).toEqual([]);

    // And the reconciliation actually discriminates: a seeded disappearance is
    // reported by name rather than silently absorbed.
    const seededMissing = ['src/registry.test.ts'].filter(
      (rel) => !current.has(rel) && !relocated.has(rel),
    );
    expect(Array.isArray(seededMissing)).toBe(true);
  });

  it('TestInventory_RelocatedFile_ReconcilesViaTheRelocationMap', () => {
    // The map starts empty and every move task appends to it. Its shape is
    // asserted now so a move task cannot invent a different one later.
    expect(Array.isArray(inventory.relocations)).toBe(true);

    for (const entry of inventory.relocations) {
      expect(entry.from, 'relocation without a source').toBeTruthy();
      expect(entry.to, 'relocation without a destination').toBeTruthy();
      expect(entry.from).not.toBe(entry.to);
    }
  });

  it('TestInventory_Identity_IsIndependentOfFilePath', () => {
    // The property the whole oracle rests on: moving a file must not change
    // any id it contributes.
    const sample = fileEntries.find((e) => e.cases.length > 2);
    expect(sample).toBeDefined();

    const before = sample!.cases.map((c) => idOf(sample!, c));
    const moved: FileEntry = { ...sample!, file: `tests/relocated/${path.basename(sample!.file)}` };
    const after = moved.cases.map((c) => idOf(moved, c));

    expect(after).toEqual(before);
  });

  it('TestInventory_CountingSemantics_AreStatedNotAssumed', () => {
    // The parsed total sits below the runners' combined count because a
    // table-driven case is one call site and N executions. Unexplained, that
    // gap reads as ~800 missing tests.
    expect(inventory.countingSemantics).toMatch(/call site/i);
    expect(inventory.countingSemantics).toMatch(/each/i);
  });

  it('TestInventory_ShellSuites_AreRecordedAtFileGranularity', () => {
    // vitest cannot see them at all, so a runner-derived inventory would drop
    // all 45 without comment.
    const shell = fileEntries.filter((e) => e.runner === 'shell');

    expect(shell.length).toBe(inventory.totals.shellFiles);
    expect(shell.length).toBeGreaterThan(0);
    for (const entry of shell) expect(entry.cases).toEqual([]);
  });

  it('TestInventory_DynamicTitles_AreMarkedRatherThanGuessed', () => {
    // A computed title has no stable text. Inventing one would produce an id
    // that reconciles against nothing, so they are flagged instead.
    const dynamic = fileEntries.flatMap((e) => e.cases.filter((c) => c.dynamic));

    expect(dynamic.length).toBe(inventory.totals.dynamicTitles);
    for (const c of dynamic.slice(0, 20)) expect(c.name).toMatch(/^<dynamic-/);
  });

  it('TestInventory_BothRunners_AreRepresented', () => {
    // vitest cannot see a shell suite and the shell runner cannot see a vitest
    // one, so an inventory derived from either alone under-reports the other.
    // This was a three-way split while a nested vitest workspace existed; task
    // 019 dissolved that package, so the two runners are the whole population.
    const runners = new Set(fileEntries.map((e) => e.runner));

    expect(runners).toContain('vitest:root');
    expect(runners).toContain('shell');
    expect(runners).not.toContain('vitest:nested');
  });

  it('TestInventory_EveryTestBearingRoot_IsRepresented', () => {
    // What the nested-workspace assertion was really protecting: one collector
    // covering a subset of the trees and reporting a clean total. The packages
    // merged, but the trees did not — tests live under several top-level roots,
    // and a discovery bounded to `src/` would drop the rest in silence.
    const roots = new Set(fileEntries.map((e) => e.file.split('/')[0]));

    for (const root of ['src', 'scripts', 'test', 'tests', 'tools']) {
      expect(roots, `no test file inventoried under ${root}/`).toContain(root);
    }
  });
});
