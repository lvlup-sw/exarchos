/**
 * Each path that the package declares to the outside must resolve, and each
 * directory that it means to publish must be in the published package.
 *
 * A manifest with some stale paths looks maintained. The package then lacks
 * directories, and nobody sees that until an install fails.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');

/**
 * The `files[]` entries that `npm run build` writes and `prepare` (tsc) does
 * not. A checkout that ran only `prepare` lacks them. `dist/bin` comes from
 * `build:binary`, and `dist/release-verify.js` from `build:release-verifier`.
 * `tests/scripts/installer-verify.test.ts` runs that script in a sandbox, so
 * it leaves no file in the checkout.
 */
const BUILD_ONLY_ENTRIES: readonly string[] = ['dist/bin', 'dist/release-verify.js'];

const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')) as Record<string, unknown>;

/** The paths that npm publishes, from a dry-run pack. */
async function packedPaths(): Promise<string[]> {
  const out = await execFileAsync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: REPO_ROOT,
    timeout: 300_000,
  });
  const parsed = JSON.parse(String(out)) as ReadonlyArray<{
    files: ReadonlyArray<{ path: string }>;
  }>;
  return parsed[0]!.files.map((f) => f.path.replace(/\\/g, '/'));
}

describe('PluginManifest', () => {
  /**
   * The manifest declares generated artifacts under `rendered/`. The hooks
   * directory at the plugin root is the exception, because a harness loads it
   * from a fixed location.
   */
  it('DeclaredPaths_ResolveAndHaveAProducer', () => {
    const manifest = readJson('.claude-plugin/plugin.json');
    const declared: string[] = [];
    for (const key of ['commands', 'skills', 'agents', 'rules', 'hooks']) {
      const value = manifest[key];
      if (typeof value === 'string') declared.push(value);
      else if (Array.isArray(value)) {
        declared.push(...value.filter((v): v is string => typeof v === 'string'));
      }
    }
    expect(declared.length, 'plugin.json declares nothing').toBeGreaterThan(0);

    for (const raw of declared) {
      const rel = raw.replace(/^\.\//, '').replace(/\/$/, '');
      expect(existsSync(join(REPO_ROOT, rel)), `plugin.json declares ${raw}, which is absent`).toBe(
        true,
      );
    }

    const nonRendered = declared
      .map((r) => r.replace(/^\.\//, ''))
      .filter((r) => !r.startsWith('rendered/') && !r.startsWith('hooks'));
    expect(nonRendered, 'declared generated paths outside rendered/').toEqual([]);
  });
});

describe('Manifest', () => {
  /**
   * Only some component groups install from a directory. The others (MCP
   * servers, plugins, rule sets) are selections and have no payload path.
   */
  it('EveryComponentSource_ExistsOnDisk', () => {
    const manifest = readJson('manifest.json') as {
      components: Record<string, Array<{ id?: string; source?: string; target?: string }>>;
    };
    const withSource = Object.values(manifest.components)
      .flat()
      .filter((c): c is { id?: string; source: string; target: string } =>
        typeof c.source === 'string',
      );
    expect(withSource.length, 'no manifest component declares a source').toBeGreaterThan(0);

    for (const c of withSource) {
      expect(
        existsSync(join(REPO_ROOT, c.source)),
        `manifest component '${c.id ?? '?'}' source '${c.source}' does not exist`,
      ).toBe(true);
    }
  });

  it('EveryRuleSetFile_ExistsInTheRenderedRules', () => {
    const manifest = readJson('manifest.json') as {
      components: { ruleSets?: Array<{ id: string; files?: string[] }> };
    };
    const ruleSets = manifest.components.ruleSets ?? [];
    expect(ruleSets.length).toBeGreaterThan(0);

    for (const set of ruleSets) {
      for (const file of set.files ?? []) {
        expect(
          existsSync(join(REPO_ROOT, 'rendered/rules', file)),
          `rule set '${set.id}' names ${file}, absent from rendered/rules/`,
        ).toBe(true);
      }
    }
  });
});

describe('FilesArray', () => {
  it('EveryShippedDirectory_ResolvesAfterTheMove', () => {
    const pkg = readJson('package.json') as { files?: string[] };
    const entries = (pkg.files ?? []).filter((f) => !f.startsWith('!'));
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      const buildOnly = BUILD_ONLY_ENTRIES.some((built) => entry === built || entry.startsWith(`${built}/`));
      if (buildOnly && !existsSync(join(REPO_ROOT, entry))) continue;
      expect(existsSync(join(REPO_ROOT, entry)), `files[] entry '${entry}' does not exist`).toBe(
        true,
      );
    }
  });

  /**
   * An entry that exists on disk does not prove that its contents reach the
   * tarball. A dead declaration drops a directory from the package silently.
   */
  it('EveryGeneratedTree_IsActuallyPublished', async () => {
    const packed = await packedPaths();
    for (const kind of ['skills', 'commands', 'rules', 'agents', 'command-aliases']) {
      const prefix = `rendered/${kind}/`;
      expect(
        packed.some((p) => p.startsWith(prefix)),
        `nothing under ${prefix} is published`,
      ).toBe(true);
    }
  }, 300_000);
});

describe('InstallSkills', () => {
  /**
   * The standalone installer probes fixed roots to find its payload. When a
   * probe names a root that does not exist, a published binary installs nothing
   * and each test that reads the repository tree still passes. A probe that
   * names `skills` or `command-aliases` must reach it through `rendered`. A
   * match on the tree name alone also flags the correct form.
   */
  it('RootProbes_ResolveUnderTheNewLayout', () => {
    const source = readFileSync(join(REPO_ROOT, 'src/install/install-skills.ts'), 'utf8');

    const probeLines = source
      .split('\n')
      .filter((l) => /candidates\.push|path\.resolve\(path\.dirname\(process\.execPath\)/.test(l));
    expect(probeLines.length, 'no root probes found to check').toBeGreaterThan(0);

    const stale = probeLines
      .filter((l) => /['"`](skills|command-aliases)['"`]|\/(skills|command-aliases)['"`]/.test(l))
      .filter((l) => !l.includes('rendered'));
    expect(stale, 'probe still names a pre-move root').toEqual([]);
  });
});
