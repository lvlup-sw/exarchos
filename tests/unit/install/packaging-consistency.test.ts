/**
 * Versioned-packaging consistency (Task 022, DR-4).
 *
 * Two guarantees, asserted LOCALLY (no network `npx` — CI must stay offline):
 *
 *  1. Version fan-out. Root `package.json` is the single source of truth; every
 *     derived sink (`.claude-plugin/plugin.json` `.version` +
 *     `.metadata.compat.minBinaryVersion`, `manifest.json`, the server package,
 *     and both `SERVER_VERSION` string literals) is a mechanical projection of
 *     it. `scripts/sync-versions.sh` writes them; this test re-checks the same
 *     invariant from TypeScript so drift is caught in the normal `vitest` run,
 *     not only by the bash `version:check` gate.
 *
 *  2. `.claude-plugin` manifest coherence against the restructured tree. Every
 *     path plugin.json declares (agents, commands dir, skills dir) resolves on
 *     disk, and every shipped `SKILL.md` parses as YAML frontmatter with the
 *     required `name`/`description` fields. Intentionally-malformed fixtures
 *     under `skills/test-fixtures/` (and `skills/trigger-tests/`) are excluded —
 *     they exist to exercise the frontmatter validator and are not shipped
 *     skills.
 *
 * Release-tag / version coordination (preview tag): the git release tag for this
 * bundle is cut as `v2.12.0-preview.3`, matching the root `package.json` version
 * exactly. `PREVIEW_VERSION` below pins that coordination point — it must be
 * updated in lockstep with the next `package.json` bump (and its release tag),
 * which is the deliberate forcing function for the preview → next-version
 * handoff. `sync-versions.sh` propagates the number; this constant records the
 * tag/version contract the release process must honor.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';

// `src/` → repo root is one level up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The preview release tag this bundle coordinates with (see file header). */
const PREVIEW_VERSION = '2.12.0-preview.3';

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
    // Root package.json is the SoT; every sink is a projection of it.
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
    // Pins THIS bundle's outcome and the release-tag/version coordination point.
    // On the next bump, update package.json (via sync-versions.sh) AND
    // PREVIEW_VERSION here, and cut the matching `v<version>` git tag.
    expect(rootVersion).toBe(PREVIEW_VERSION);
  });

  it('pluginManifest_PathsExistInTree', () => {
    // Every path plugin.json declares must resolve against the restructured
    // tree. (Build artifacts like the bundled MCP JS are intentionally NOT
    // asserted — they don't exist pre-build.)
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

  it('pluginManifest_SkillDeclarationsParse_Locally', () => {
    // Parse every shipped SKILL.md frontmatter locally — no network `npx`.
    const skillsDir = join(repoRoot, 'rendered', 'skills');
    // Intentionally-malformed fixtures live here; they are not shipped skills.
    const excludedTopDirs = new Set(['test-fixtures', 'trigger-tests']);

    const skillFiles: string[] = [];
    for (const top of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!top.isDirectory() || excludedTopDirs.has(top.name)) continue;
      const runtimeDir = join(skillsDir, top.name);
      for (const skill of readdirSync(runtimeDir, { withFileTypes: true })) {
        // Skip transient `__…__` probe dirs (e.g. `__wt_probe__`, written into
        // the real skills tree by generate-legacy-skill-hashes.test.ts) that can
        // race this scan under parallel test execution. Real skill dirs are
        // kebab-case verbs and never start with `__`.
        if (!skill.isDirectory() || skill.name.startsWith('__')) continue;
        const skillMd = join(runtimeDir, skill.name, 'SKILL.md');
        if (existsSync(skillMd)) skillFiles.push(skillMd);
      }
    }

    // The restructured tree ships a non-trivial skill set; guard against an
    // enumeration that silently finds nothing (which would make the loop vacuous).
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
