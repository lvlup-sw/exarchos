/**
 * Packaging consistency checks that run with no network access.
 *
 *  1. Version fan-out. The root `package.json` is the single source of the version.
 *     `tools/release/sync-versions.sh` writes it to `.claude-plugin/plugin.json`
 *     (`.version` and `.metadata.compat.minBinaryVersion`), to `manifest.json`, and
 *     to both `SERVER_VERSION` literals. This test compares each of those sinks with
 *     the root version, so the `vitest` run finds drift without the `version:check` gate.
 *  2. Plugin manifest coherence. Each path that `plugin.json` declares exists on disk.
 *     Each rendered `SKILL.md` has YAML frontmatter with a `name` and a `description`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The version of the release tag for this tree. `sync-versions.sh` does not write this constant.
 * On each version bump, update it together with `package.json` and create the `v<version>` git tag.
 */
const PREVIEW_VERSION = '2.12.1';

const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(repoRoot, rel), 'utf-8')) as Record<string, unknown>;

const rootVersion = readJson('package.json').version as string;

/** Extract the single-quoted RHS of a `SERVER_VERSION = '…'` literal. */
function serverVersionLiteral(relFile: string): string {
  const src = readFileSync(join(repoRoot, relFile), 'utf-8');
  const match = src.match(/SERVER_VERSION\s*=\s*'([^']+)'/);
  expect(match, `no SERVER_VERSION literal found in ${relFile}`).not.toBeNull();
  return match![1];
}

describe('versioned packaging (Task 022, DR-4)', () => {
  it('versionCheck_AllSinksMatchRootPackageJson', () => {
    const plugin = readJson('.claude-plugin/plugin.json');
    const manifest = readJson('manifest.json');
    const mcpPkg = readJson('package.json');

    const metadata = plugin.metadata as { compat?: { minBinaryVersion?: string } } | undefined;

    expect(plugin.version, 'plugin.json .version').toBe(rootVersion);
    expect(
      metadata?.compat?.minBinaryVersion,
      'plugin.json .metadata.compat.minBinaryVersion',
    ).toBe(rootVersion);
    expect(manifest.version, 'manifest.json .version').toBe(rootVersion);
    expect(mcpPkg.version, 'package.json .version').toBe(rootVersion);
    expect(serverVersionLiteral('src/index.ts'), 'index.ts SERVER_VERSION').toBe(
      rootVersion,
    );
    expect(
      serverVersionLiteral('src/adapters/mcp/mcp.ts'),
      'adapters/mcp/mcp.ts SERVER_VERSION',
    ).toBe(rootVersion);
  });

  it('versionCheck_RootMatchesPreviewReleaseTag', () => {
    expect(rootVersion).toBe(PREVIEW_VERSION);
  });

  /** The test does not assert build artifacts, because they do not exist before a build. */
  it('pluginManifest_PathsExistInTree', () => {
    const plugin = readJson('.claude-plugin/plugin.json');

    const agents = plugin.agents as string[];
    expect(Array.isArray(agents) && agents.length > 0).toBe(true);
    for (const rel of agents) {
      const p = join(repoRoot, rel);
      expect(existsSync(p), `plugin.json agent path missing: ${rel}`).toBe(true);
    }

    for (const key of ['commands', 'skills'] as const) {
      const rel = plugin[key] as string;
      const p = join(repoRoot, rel);
      expect(existsSync(p), `plugin.json ${key} path missing: ${rel}`).toBe(true);
      expect(statSync(p).isDirectory(), `plugin.json ${key} must be a directory: ${rel}`).toBe(true);
    }
  });

  /**
   * The scan reads each rendered `SKILL.md` from disk. It skips each directory whose
   * name starts with `__`, because that name marks a transient probe directory and
   * not a skill. The count check stops an empty scan from passing with no assertions.
   */
  it('pluginManifest_SkillDeclarationsParse_Locally', () => {
    const skillsDir = join(repoRoot, 'rendered', 'skills');
    const excludedTopDirs = new Set(['test-fixtures', 'trigger-tests']);

    const skillFiles: string[] = [];
    for (const top of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!top.isDirectory() || excludedTopDirs.has(top.name)) continue;
      const runtimeDir = join(skillsDir, top.name);
      for (const skill of readdirSync(runtimeDir, { withFileTypes: true })) {
        if (!skill.isDirectory() || skill.name.startsWith('__')) continue;
        const skillMd = join(runtimeDir, skill.name, 'SKILL.md');
        if (existsSync(skillMd)) skillFiles.push(skillMd);
      }
    }

    expect(skillFiles.length).toBeGreaterThan(10);

    for (const file of skillFiles) {
      const raw = readFileSync(file, 'utf-8');
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      expect(fm, `SKILL.md missing YAML frontmatter: ${file}`).not.toBeNull();

      const parsed = yamlLoad(fm![1]);
      expect(
        parsed !== null && typeof parsed === 'object',
        `SKILL.md frontmatter did not parse to an object: ${file}`,
      ).toBe(true);

      const decl = parsed as Record<string, unknown>;
      expect(typeof decl.name, `SKILL.md frontmatter missing string 'name': ${file}`).toBe('string');
      expect(
        typeof decl.description,
        `SKILL.md frontmatter missing string 'description': ${file}`,
      ).toBe('string');
    }
  });
});
