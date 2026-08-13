import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every path the package declares to the outside world has to resolve, and
 * every directory it means to publish has to actually be published.
 *
 * The failure being guarded is quiet: repointing some declared paths and
 * leaving others behind produces a manifest that looks maintained and a
 * package that is missing directories nobody notices until an install fails.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');

const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')) as Record<string, unknown>;

/** Paths npm would publish, from a dry-run pack. */
function packedPaths(): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(out) as ReadonlyArray<{ files: ReadonlyArray<{ path: string }> }>;
  return parsed[0]!.files.map((f) => f.path.replace(/\\/g, '/'));
}

describe('PluginManifest', () => {
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

    // Generated artifacts are declared under `rendered/`; the plugin-root
    // hooks directory is the deliberate exception, because a harness
    // auto-loads it from a fixed location.
    const nonRendered = declared
      .map((r) => r.replace(/^\.\//, ''))
      .filter((r) => !r.startsWith('rendered/') && !r.startsWith('hooks'));
    expect(nonRendered, 'declared generated paths outside rendered/').toEqual([]);
  });
});

describe('Manifest', () => {
  it('EveryComponentSource_ExistsOnDisk', () => {
    const manifest = readJson('manifest.json') as {
      components: Record<string, Array<{ id?: string; source?: string; target?: string }>>;
    };
    // Only some component groups install from a directory; the rest (MCP
    // servers, plugins, rule sets) are selections, not payload paths.
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
      expect(existsSync(join(REPO_ROOT, entry)), `files[] entry '${entry}' does not exist`).toBe(
        true,
      );
    }
  });

  it('EveryGeneratedTree_IsActuallyPublished', () => {
    // The entry existing on disk is not the same as its contents reaching the
    // tarball. Four directories were once left as dead declarations, which
    // dropped them from the package silently.
    const packed = packedPaths();
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
  it('RootProbes_ResolveUnderTheNewLayout', () => {
    // The standalone installer finds its payload by probing fixed roots. If
    // those still name the pre-move layout, a published binary installs
    // nothing while every test that reads the repo tree still passes.
    const source = readFileSync(join(REPO_ROOT, 'src/install/install-skills.ts'), 'utf8');

    const probeLines = source
      .split('\n')
      .filter((l) => /candidates\.push|path\.resolve\(path\.dirname\(process\.execPath\)/.test(l));
    expect(probeLines.length, 'no root probes found to check').toBeGreaterThan(0);

    // A probe naming one of the moved trees must reach it through `rendered`.
    // Matching on the tree name alone would flag the corrected form too, which
    // is how a test like this ends up asserting nothing useful.
    const stale = probeLines
      .filter((l) => /['"`](skills|command-aliases)['"`]|\/(skills|command-aliases)['"`]/.test(l))
      .filter((l) => !l.includes('rendered'));
    expect(stale, 'probe still names a pre-move root').toEqual([]);
  });
});
