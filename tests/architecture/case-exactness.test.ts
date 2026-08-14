/**
 * Declared entry points resolve with EXACT case (task 045, DR-11 / INV-16).
 *
 * The failure this exists for is invisible where it is introduced and fatal
 * where it ships. A config that names `Rendered/commands` or `dist/Index.js`
 * works on Windows and on a default macOS volume, and fails on every Linux CI
 * runner and every case-sensitive host. `tsc --noEmit` structurally cannot see
 * it — these are strings in JSON, not module specifiers — and a developer with
 * `core.ignorecase=true` cannot reproduce it locally.
 *
 * The check has to be a case-SENSITIVE comparison against a real directory
 * listing. `fs.existsSync` is not that: on a case-insensitive filesystem it
 * answers `true` for the wrong case, which is precisely the environment where
 * the defect is introduced. So every segment is resolved by listing its parent
 * and looking for an exact string match.
 *
 * INV-16's other half is asserted alongside it: a stored or compared path is
 * POSIX-normalized, never separator-concatenated, or the same config breaks on
 * Windows for the mirror-image reason.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as Record<string, unknown>;

/**
 * Does `rel` exist with EXACTLY this spelling?
 *
 * Walks segment by segment, listing each parent directory and requiring an
 * exact match. `existsSync` would answer the question the case-insensitive
 * filesystem wants to answer, not the one CI will ask.
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

/** Every declared path, tagged with the config that declares it. */
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
    // `files[]` may carry negations and globs; only literal paths are checkable
    // here, and the negations were retired by task 036 anyway.
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
      // `bundlePath` is deliberately NOT checked for existence — see
      // McpBundlePath_IsAFilenameCarrier_NotAResolvablePath below.
    }
  }

  const knip = readJson('knip.json');
  for (const ws of Object.values((knip.workspaces ?? {}) as Record<string, unknown>)) {
    const cfg = ws as Record<string, unknown>;
    for (const key of ['entry', 'project']) {
      for (const g of (cfg[key] ?? []) as unknown[]) {
        // Literal file entries only — a glob has no single spelling to check.
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
 * Build-output paths. `dist/` exists on a built tree and not on a fresh clone,
 * so these are checked only when it is present — asserting them unconditionally
 * would make the gate fail for the wrong reason on a clean checkout.
 */
const isBuildOutput = (rel: string): boolean => rel === 'dist' || rel.startsWith('dist/');

describe('case exactness', () => {
  const declared = declaredPaths();

  it('EntryPoints_EveryDeclaredPath_ResolvesWithExactCase', () => {
    const distBuilt = fs.existsSync(path.join(REPO_ROOT, 'dist'));

    const broken = declared
      .filter(({ value }) => !(isBuildOutput(value) && !distBuilt))
      .filter(({ value }) => !resolvesWithExactCase(value))
      .map(({ source, value }) => `${source}: ${value}`)
      .sort();

    expect(broken, 'declared paths that do not resolve with exactly this spelling').toEqual([]);

    // Denominator. A parser that quietly returned nothing would satisfy the
    // assertion above by having nothing to check — the exact vacuity this
    // workflow keeps finding in path-shaped guards.
    expect(declared.length, 'no declared entry points were parsed at all').toBeGreaterThan(10);
  });

  it('EntryPoints_WrongCase_IsRejected', () => {
    // The kill probe. `existsSync` returns TRUE for these on a case-insensitive
    // filesystem, which is why the resolver above lists directories instead.
    expect(resolvesWithExactCase('Rendered')).toBe(false);
    expect(resolvesWithExactCase('SRC/index.ts')).toBe(false);
    expect(resolvesWithExactCase('package.JSON')).toBe(false);

    // …and the positive control, so the three above are not passing because the
    // resolver rejects everything.
    expect(resolvesWithExactCase('rendered')).toBe(true);
    expect(resolvesWithExactCase('src/index.ts')).toBe(true);
    expect(resolvesWithExactCase('package.json')).toBe(true);
  });

  it('McpBundlePath_IsAFilenameCarrier_NotAResolvablePath', () => {
    // Found by the exactness check above, which flagged `dist/exarchos-mcp.js`
    // as a declared path that does not resolve on a BUILT tree. It does not
    // resolve because no build step emits it: `build-binary.ts` records that
    // the `dist/exarchos.js` emission path was retired and the compiled binary
    // is the sole distribution.
    //
    // The value is not dead, though — `generateMcpEntry` uses `path.basename`
    // of it to name the installed server, and nothing ever OPENS it
    // (`installBundle` exists but has no production caller, only its own test).
    // So the `dist/` prefix carries no meaning and the basename carries all of
    // it. Excluding it from the existence check is therefore correct rather
    // than a concession; what IS load-bearing gets asserted here instead.
    const manifest = readJson('manifest.json');
    const servers = ((manifest.components ?? {}) as Record<string, unknown>).mcpServers;
    const bundled = (servers as Record<string, unknown>[]).filter((s) => s.type === 'bundled');

    expect(bundled.length, 'no bundled MCP server declared — nothing to check').toBeGreaterThan(0);

    for (const server of bundled) {
      const declaredPath = server.bundlePath;
      if (typeof declaredPath !== 'string') continue;

      // The basename is the contract. It must equal what the installer's own
      // fallback would produce, so the declaration and the default cannot
      // disagree about where the server lands in ~/.claude/mcp-servers/.
      expect(path.posix.basename(declaredPath)).toBe(`${String(server.id)}-mcp.js`);
      expect(declaredPath.includes('\\'), 'bundlePath must be POSIX-shaped').toBe(false);
    }
  });

  it('PathHandling_EveryStoredPath_IsPosixNormalized', () => {
    // INV-16. A declared path is data that gets compared against POSIX-shaped
    // repo-relative paths, so a backslash separator or a drive letter makes the
    // comparison fail on Windows in a way no Linux run can reproduce.
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

  it('PathHandling_NormalizationHolds_ForEverySeparatorForm', () => {
    // The property the spec names: normalization is a function of the path, not
    // of the separator it arrived in. Checked over both forms of the same path
    // so a normalizer that simply passes input through fails here.
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
