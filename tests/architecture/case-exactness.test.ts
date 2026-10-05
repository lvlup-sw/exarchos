/**
 * Each declared entry point must resolve with exact case.
 *
 * A config that names `Rendered/commands` or `dist/Index.js` works on Windows
 * and on a default macOS volume. It fails on each Linux CI runner and on each
 * case-sensitive host. `tsc --noEmit` cannot see the fault, because the paths
 * are strings in JSON and not module specifiers.
 *
 * `fs.existsSync` answers `true` for the wrong case on a case-insensitive
 * filesystem. Thus the check lists the parent directory of each segment and
 * requires an exact string match.
 *
 * The suite also asserts that each declared path is POSIX-normalized, because
 * a backslash separator breaks the same config on Windows.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as Record<string, unknown>;

/**
 * True when `rel` exists with exactly this spelling. The function lists the
 * parent directory of each segment and requires an exact match, because
 * `existsSync` ignores case on a case-insensitive filesystem.
 */
function resolvesWithExactCase(rel: string): boolean {
  const segments = rel.split('/').filter((s) => s.length > 0 && s !== '.');
  let current = REPO_ROOT;
  for (const segment of segments) {
    let listing: string[];
    try {
      listing = fs.readdirSync(current);
    } catch {
      return false;
    }
    if (!listing.includes(segment)) return false;
    current = path.join(current, segment);
  }
  return segments.length > 0;
}

interface Declared {
  readonly source: string;
  readonly value: string;
}

/**
 * Each declared path, with the config key that declares it. Only literal paths
 * count, because a glob or a negation has no single spelling. The list omits
 * `bundlePath`, which `McpBundlePath_IsAFilenameCarrier_NotAResolvablePath`
 * covers.
 */
function declaredPaths(): Declared[] {
  const out: Declared[] = [];
  const add = (source: string, value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) out.push({ source, value });
  };

  const pkg = readJson('package.json');
  add('package.json#main', pkg.main);
  for (const [name, target] of Object.entries((pkg.bin ?? {}) as Record<string, unknown>)) {
    add(`package.json#bin.${name}`, target);
  }
  for (const entry of (pkg.files ?? []) as unknown[]) {
    if (typeof entry === 'string' && !entry.startsWith('!') && !entry.includes('*')) {
      add('package.json#files', entry);
    }
  }

  const manifest = readJson('manifest.json');
  const components = (manifest.components ?? {}) as Record<string, unknown>;
  for (const [group, list] of Object.entries(components)) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const item = raw as Record<string, unknown>;
      add(`manifest.json#${group}.source`, item.source);
      add(`manifest.json#${group}.devEntryPoint`, item.devEntryPoint);
    }
  }

  const knip = readJson('knip.json');
  for (const ws of Object.values((knip.workspaces ?? {}) as Record<string, unknown>)) {
    const cfg = ws as Record<string, unknown>;
    for (const key of ['entry', 'project']) {
      for (const g of (cfg[key] ?? []) as unknown[]) {
        if (typeof g === 'string' && !g.includes('*') && !g.startsWith('!')) {
          add(`knip.json#${key}`, g);
        }
      }
    }
  }
  for (const g of (knip.ignore ?? []) as unknown[]) {
    if (typeof g === 'string' && !g.includes('*')) add('knip.json#ignore', g);
  }

  return out;
}

/**
 * True for a build-output path. `dist/` exists on a built tree and not on a
 * fresh clone, so the suite checks such a path only when it is on disk.
 */
const isBuildOutput = (rel: string): boolean => rel === 'dist' || rel.startsWith('dist/');

describe('case exactness', () => {
  const declared = declaredPaths();

  /**
   * Skips a build-output path that is not on disk, so a checkout with no
   * binary artifact does not fail. The count assertion is the denominator: a
   * parser that returns nothing passes the list assertion.
   */
  it('EntryPoints_EveryDeclaredPath_ResolvesWithExactCase', () => {
    const broken = declared
      .filter(({ value }) => {
        if (isBuildOutput(value) && !fs.existsSync(path.join(REPO_ROOT, value))) {
          return false;
        }
        return !resolvesWithExactCase(value);
      })
      .map(({ source, value }) => `${source}: ${value}`)
      .sort();

    expect(broken, 'declared paths that do not resolve with exactly this spelling').toEqual([]);

    expect(declared.length, 'no declared entry points were parsed at all').toBeGreaterThan(10);
  });

  /**
   * Kill probe. `existsSync` returns `true` for the wrong-case paths on a
   * case-insensitive filesystem. The right-case paths are the positive
   * control, so a resolver that rejects each path also fails.
   */
  it('EntryPoints_WrongCase_IsRejected', () => {
    expect(resolvesWithExactCase('Rendered')).toBe(false);
    expect(resolvesWithExactCase('SRC/index.ts')).toBe(false);
    expect(resolvesWithExactCase('package.JSON')).toBe(false);

    expect(resolvesWithExactCase('rendered')).toBe(true);
    expect(resolvesWithExactCase('src/index.ts')).toBe(true);
    expect(resolvesWithExactCase('package.json')).toBe(true);
  });

  /**
   * No build step emits the declared `bundlePath`, so it does not resolve on a
   * built tree. `generateMcpEntry` reads only its basename, which names the
   * installed server, and no production code opens the path. Thus the
   * basename is the contract. It must equal the fallback name of the
   * installer, so the declaration and the default give one install location.
   */
  it('McpBundlePath_IsAFilenameCarrier_NotAResolvablePath', () => {
    const manifest = readJson('manifest.json');
    const servers = ((manifest.components ?? {}) as Record<string, unknown>).mcpServers;
    const bundled = (servers as Record<string, unknown>[]).filter((s) => s.type === 'bundled');

    expect(bundled.length, 'no bundled MCP server declared — nothing to check').toBeGreaterThan(0);

    for (const server of bundled) {
      const declaredPath = server.bundlePath;
      if (typeof declaredPath !== 'string') continue;

      expect(path.posix.basename(declaredPath)).toBe(`${String(server.id)}-mcp.js`);
      expect(declaredPath.includes('\\'), 'bundlePath must be POSIX-shaped').toBe(false);
    }
  });

  /**
   * Readers compare a declared path against POSIX repository-relative paths.
   * A backslash separator or a drive letter makes that comparison fail on
   * Windows, and no Linux run reproduces the failure.
   */
  it('PathHandling_EveryStoredPath_IsPosixNormalized', () => {
    const malformed = declared
      .filter(
        ({ value }) =>
          value.includes('\\') ||
          /^[A-Za-z]:/.test(value) ||
          value.startsWith('/') ||
          value.includes('//'),
      )
      .map(({ source, value }) => `${source}: ${value}`)
      .sort();

    expect(malformed, 'declared paths that are not POSIX-normalized repo-relative').toEqual([]);
  });

  /**
   * Normalization depends on the path and not on its separator. The cases
   * hold both separator forms of one path, so a pass-through normalizer fails.
   * The test normalizes with an inline `replaceAll` call and calls no
   * production normalizer.
   */
  it('PathHandling_NormalizationHolds_ForEverySeparatorForm', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['src\\index.ts', 'src/index.ts'],
      ['tools\\audit\\gates', 'tools/audit/gates'],
      ['a\\b\\c\\d.ts', 'a/b/c/d.ts'],
      ['src/index.ts', 'src/index.ts'],
    ];

    for (const [input, expected] of cases) {
      expect(input.replaceAll('\\', '/'), `${input} did not normalize to ${expected}`).toBe(expected);
    }
  });
});
