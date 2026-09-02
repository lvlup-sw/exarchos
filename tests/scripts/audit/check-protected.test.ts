import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import {
  PRIMARY_ROOT,
  PROTECTED_ROOTS,
  isKeepClassRelPath,
  discoverProtectedFiles,
  buildInventory,
  loadInventory,
  findProtectedViolations,
  runCheckProtected,
  resolveChangedFiles,
  EXIT_OK,
  EXIT_PROTECTED,
} from '../../../tools/audit/check-protected.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const INVENTORY_PATH = path.join(HERE, '../../../tools/audit/protected-suites.json');
const CLI_PATH = path.join(HERE, '../../../tools/audit/check-protected.mjs');
const REAL_PRIMARY_ROOT_ABS = path.join(REPO_ROOT, PRIMARY_ROOT);

function captureDeps(changedFiles: string[], inventoryFiles: string[]): { out: string[]; err: string[]; exit: number } {
  const out: string[] = [];
  const err: string[] = [];
  const exit = runCheckProtected({
    changedFiles,
    inventoryFiles,
    log: (m: string) => out.push(m),
    errlog: (m: string) => err.push(m),
  });
  return { out, err, exit };
}

describe('isKeepClassRelPath — suffix/area/explicit classifier (DR-5)', () => {
  it.each([
    ['adapters/schema-to-flags.parity.test.ts', true],
    ['event-store/atomic-appender.race.test.ts', true],
    ['event-store/store.property.test.ts', true],
    ['architecture/resolve-effective-catalog.characterization.test.ts', true],
    ['capabilities/resolver.acceptance.test.ts', true],
    ['workflow/state-machine.property.test.ts', true],
    ['workflow/tools.update.race.test.ts', true],
    ['projections/views/materializer.property.test.ts', true],
    ['parity-harness.ts', true],
    ['projections/views/parity.test.ts', true],
    ['events/parity.test.ts', true],
  ])('%s -> keep-class %s', (relPath, expected) => {
    expect(isKeepClassRelPath(relPath)).toBe(expected);
  });

  it('is NOT fooled by a file merely importing fast-check (events/tools.test.ts)', () => {
    // The design invariant this whole task exists to enforce: keep-class
    // status is by dedicated-suite SUFFIX, never by import content.
    // event-store/tools.test.ts imports fast-check but has a plain `.test.ts`
    // suffix — it is a mixed CONSOLIDATION TARGET, not protected.
    expect(isKeepClassRelPath('event-store/tools.test.ts')).toBe(false);
  });

  it('rejects other plain .test.ts files with no dedicated-suite suffix', () => {
    expect(isKeepClassRelPath('workflow/tools.test.ts')).toBe(false);
    expect(isKeepClassRelPath('views/handlers.test.ts')).toBe(false);
  });

  it('does not match a suffix substring lacking the leading dot (no false positive)', () => {
    // "xparity.test.ts" contains "parity.test.ts" but not ".parity.test.ts".
    expect(isKeepClassRelPath('adapters/xparity.test.ts')).toBe(false);
  });

  it('normalizes backslash separators (Windows path input)', () => {
    expect(isKeepClassRelPath('workflow\\state-machine.property.test.ts')).toBe(true);
  });
});

describe('discoverProtectedFiles — generated from the LIVE tree, not hand-listed', () => {
  const files = discoverProtectedFiles(REAL_PRIMARY_ROOT_ABS);

  it('finds the shared parity-harness.ts (no test-suffix, explicit-only match)', () => {
    expect(files).toContain(`${PRIMARY_ROOT}/parity-harness.ts`);
  });

  it('finds the projections/views/parity and events/parity area files (literal name, not suffix-matched)', () => {
    expect(files).toContain(`${PRIMARY_ROOT}/projections/views/parity.test.ts`);
    expect(files).toContain(`${PRIMARY_ROOT}/events/parity.test.ts`);
  });

  it('finds the named adjacent property/race keep-class files', () => {
    expect(files).toContain(`${PRIMARY_ROOT}/workflow/state-machine.property.test.ts`);
    expect(files).toContain(`${PRIMARY_ROOT}/workflow/tools.update.race.test.ts`);
    expect(files).toContain(`${PRIMARY_ROOT}/projections/views/materializer.property.test.ts`);
  });

  it('does NOT include events/tools.test.ts (imports fast-check, but a consolidation target)', () => {
    expect(files).not.toContain(`${PRIMARY_ROOT}/events/tools.test.ts`);
  });

  it('every discovered file is classified keep-class by the shared predicate', () => {
    for (const f of files) {
      expect(isKeepClassRelPath(f.slice(PRIMARY_ROOT.length + 1))).toBe(true);
    }
  });
});

describe('buildInventory / loadInventory round trip', () => {
  it('round-trips a file list through build + load unchanged (sorted)', () => {
    const inventory = buildInventory(['b/y.race.test.ts', 'a/x.parity.test.ts']);
    expect(loadInventory(inventory)).toEqual(['a/x.parity.test.ts', 'b/y.race.test.ts']);
  });

  it('throws when `files` is missing', () => {
    expect(() => loadInventory({ version: 1 })).toThrow(/files\[\]/);
  });

  it('throws when `files` contains a non-string entry', () => {
    expect(() => loadInventory({ files: [1] })).toThrow(/non-empty strings/);
  });

  it('the SHIPPED protected-suites.json conforms and matches the live tree (no drift)', () => {
    const raw = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
    const shipped = loadInventory(raw);
    const live = PROTECTED_ROOTS.flatMap((root) =>
      discoverProtectedFiles(path.join(REPO_ROOT, root), root),
    ).sort();
    expect(shipped).toEqual(live);
  });

  it('PROTECTED_ROOTS_ALL_EXIST', () => {
    // A root that no longer exists walks nothing and drops every suite under it
    // from protection — silently, since the regenerated snapshot then matches
    // the walk that found nothing. Task 018a moved `parity/` out of `src` and
    // that is exactly what happened.
    expect(PROTECTED_ROOTS.length).toBeGreaterThan(0);
    for (const root of PROTECTED_ROOTS) {
      expect(existsSync(path.join(REPO_ROOT, root)), `protected root ${root} does not exist`).toBe(
        true,
      );
      expect(
        discoverProtectedFiles(path.join(REPO_ROOT, root), root).length,
        `protected root ${root} contains no keep-class suite`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('findProtectedViolations — the change-set intersection', () => {
  const inventoryFiles = [
    `${PRIMARY_ROOT}/events/parity.test.ts`,
    `${PRIMARY_ROOT}/workflow/state-machine.property.test.ts`,
  ];

  it('a clean change-set has no violations', () => {
    const changed = [`${PRIMARY_ROOT}/workflow/tools.test.ts`, 'README.md'];
    expect(findProtectedViolations(changed, inventoryFiles)).toEqual([]);
  });

  it('flags a change-set intersecting the committed snapshot', () => {
    const changed = [`${PRIMARY_ROOT}/workflow/tools.test.ts`, `${PRIMARY_ROOT}/events/parity.test.ts`];
    expect(findProtectedViolations(changed, inventoryFiles)).toEqual([`${PRIMARY_ROOT}/events/parity.test.ts`]);
  });

  it('flags a NEW keep-class-suffixed file even before the snapshot is regenerated (no-drift design)', () => {
    // Not present in inventoryFiles at all — only the live suffix rule catches it.
    const changed = [`${PRIMARY_ROOT}/workflow/brand-new-thing.race.test.ts`];
    expect(findProtectedViolations(changed, [])).toEqual([`${PRIMARY_ROOT}/workflow/brand-new-thing.race.test.ts`]);
  });

  it('does not flag event-store/tools.test.ts even though it imports fast-check', () => {
    const changed = [`${PRIMARY_ROOT}/events/tools.test.ts`];
    expect(findProtectedViolations(changed, [])).toEqual([]);
  });

  it('deduplicates repeated paths', () => {
    const changed = [`${PRIMARY_ROOT}/events/parity.test.ts`, `${PRIMARY_ROOT}/events/parity.test.ts`];
    expect(findProtectedViolations(changed, inventoryFiles)).toEqual([`${PRIMARY_ROOT}/events/parity.test.ts`]);
  });

  it('ignores files outside every protected root entirely (not a false positive on unrelated paths)', () => {
    expect(findProtectedViolations(['docs/parity.test.ts'], [])).toEqual([]);
  });
});

describe('runCheckProtected — PASS on a clean change-set, FAIL on an intersecting one', () => {
  const inventoryFiles = [`${PRIMARY_ROOT}/events/parity.test.ts`];

  it('PASSES (exit 0) on a clean change-set', () => {
    const { exit, out } = captureDeps([`${PRIMARY_ROOT}/workflow/tools.test.ts`], inventoryFiles);
    expect(exit).toBe(EXIT_OK);
    expect(out.join('\n')).toMatch(/OK/);
  });

  it('FAILS (exit 1) when the change-set touches a keep-class glob', () => {
    const { exit, err } = captureDeps([`${PRIMARY_ROOT}/events/parity.test.ts`], inventoryFiles);
    expect(exit).toBe(EXIT_PROTECTED);
    expect(err.join('\n')).toMatch(/FAIL/);
    expect(err.join('\n')).toMatch(new RegExp(`${PRIMARY_ROOT}/events/parity\\.test\\.ts`));
  });

  it('FAILS on an empty inventory but a live-suffix-matching change (drift safety net)', () => {
    const { exit } = captureDeps([`${PRIMARY_ROOT}/orchestrate/new-thing.acceptance.test.ts`], []);
    expect(exit).toBe(EXIT_PROTECTED);
  });
});

describe('resolveChangedFiles — arg > stdin > git fallback priority', () => {
  it('prefers explicit argv files over everything else', () => {
    const result = resolveChangedFiles({
      argvFiles: ['a.ts'],
      stdinText: 'b.ts\n',
      gitFallback: () => ['c.ts'],
    });
    expect(result).toEqual(['a.ts']);
  });

  it('falls back to stdin (one path per line, blanks dropped) when no argv files', () => {
    const result = resolveChangedFiles({
      argvFiles: [],
      stdinText: 'a.ts\n\nb.ts\n',
      gitFallback: () => ['c.ts'],
    });
    expect(result).toEqual(['a.ts', 'b.ts']);
  });

  it('falls back to the git-diff callback when argv and stdin are both empty', () => {
    const result = resolveChangedFiles({ argvFiles: [], stdinText: '', gitFallback: () => ['c.ts'] });
    expect(result).toEqual(['c.ts']);
  });
});

describe('CLI end-to-end — the guard as actually invoked', () => {
  it('exits 0 for a clean change-set passed as argv', () => {
    const res = spawnSync('node', [CLI_PATH, 'README.md', 'package.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(res.status).toBe(EXIT_OK);
    expect(res.stdout).toMatch(/OK/);
  });

  it('exits non-zero for a change-set touching a keep-class protected file', () => {
    const res = spawnSync('node', [CLI_PATH, `${PRIMARY_ROOT}/events/parity.test.ts`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(res.status).toBe(EXIT_PROTECTED);
    expect(res.stderr).toMatch(/FAIL/);
  });

  it('exits 0 for a change touching event-store/tools.test.ts (fast-check import, not protected)', () => {
    const res = spawnSync('node', [CLI_PATH, `${PRIMARY_ROOT}/events/tools.test.ts`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(res.status).toBe(EXIT_OK);
  });
});
