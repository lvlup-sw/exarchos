/**
 * An end-to-end install from a clean clone. `plugin.json` points at the `rendered/` tree, and only
 * an install proves that the tree ships.
 *
 * Other checks read the working tree, where an untracked or ignored file satisfies `existsSync`.
 * A consumer gets neither. Thus the subject is a materialization of the tracked files of HEAD.
 * The three tests catch a wrong flatten, a wrong path in `plugin.json` and a hook that registers
 * twice. Each of those leaves a tree that looks correct on disk.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { installSkills } from '../../src/install/install-skills.js';
import { loadAllRuntimes } from '../../src/install/runtimes/load.js';
import { execFileAsync, spawnAsyncBuffer } from '../../tools/test-helpers/spawn.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');

let clone: string;
let scratch: string;

/**
 * Materializes the tracked content of HEAD, with no working-tree residue and no `.git`. The
 * archive stays a Buffer, because it is binary and utf8 decoding corrupts it.
 */
async function materializeCleanClone(dest: string): Promise<void> {
  const archive = await spawnAsyncBuffer('git', ['archive', '--format=tar', 'HEAD'], {
    cwd: REPO_ROOT,
  });
  if (archive.status !== 0 || archive.error !== undefined) {
    throw new Error(
      `git archive failed (exit ${String(archive.status)}): ${archive.error?.message ?? archive.stderr.toString('utf8')}`,
    );
  }
  await execFileAsync('tar', ['-x', '-C', dest], { input: archive.stdout });
}

const readJson = (root: string, rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, rel), 'utf8')) as Record<string, unknown>;

/** Files anywhere beneath `dir`, so a directory holding only empty children reads as empty. */
function fileCount(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += fileCount(join(dir, entry.name));
    else count += 1;
  }
  return count;
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'exarchos-fresh-install-'));
  clone = join(scratch, 'clone');
  mkdirSync(clone, { recursive: true });
  await materializeCleanClone(clone);
}, 120_000);

afterAll(() => {
  if (scratch) rmrf(scratch);
});

describe('FreshInstall', () => {
  /**
   * The test checks the denominator first, because an empty clone enters no loop and passes.
   * A declared directory must also hold files. A gitignored payload leaves a directory that is
   * present but empty: a tracked sibling keeps the parent directory, and the payload is absent.
   */
  it('FromCleanClone_ResolvesSkillsCommandsAndAgents', () => {
    expect(existsSync(join(clone, 'package.json')), 'clone did not materialize').toBe(true);

    const plugin = readJson(clone, '.claude-plugin/plugin.json');
    const declared: string[] = [];
    for (const key of ['commands', 'skills', 'agents', 'rules', 'hooks']) {
      const value = plugin[key];
      if (typeof value === 'string') declared.push(value);
      else if (Array.isArray(value)) {
        declared.push(...value.filter((v): v is string => typeof v === 'string'));
      }
    }
    expect(declared.length, 'plugin.json declares nothing to resolve').toBeGreaterThan(0);

    for (const raw of declared) {
      const rel = raw.replace(/^\.\//, '').replace(/\/$/, '');
      const abs = join(clone, rel);
      expect(existsSync(abs), `plugin.json declares ${raw}, absent from a clean clone`).toBe(true);
      if (statSync(abs).isDirectory()) {
        expect(fileCount(abs), `plugin.json declares ${raw}, which ships no files`).toBeGreaterThan(
          0,
        );
      }
    }

    const manifest = readJson(clone, 'manifest.json') as {
      components: Record<string, Array<{ id?: string; source?: string }>>;
    };
    const sources = Object.values(manifest.components)
      .flat()
      .filter((c): c is { id?: string; source: string } => typeof c.source === 'string');
    expect(sources.length, 'no manifest component declares a source').toBeGreaterThan(0);

    for (const c of sources) {
      const abs = join(clone, c.source);
      expect(
        existsSync(abs),
        `manifest component '${c.id ?? '?'}' source '${c.source}' is absent from a clean clone`,
      ).toBe(true);
      expect(
        fileCount(abs),
        `manifest component '${c.id ?? '?'}' source '${c.source}' ships no files`,
      ).toBeGreaterThan(0);
    }
  });

  /**
   * The install runs against the clone, into a throwaway HOME, as a consumer install does. It
   * writes nothing outside the scratch directory. `registerMcp` is a stub, because the real one
   * writes `~/.claude.json`.
   *
   * The harness reads `~/.claude/skills/<name>/SKILL.md`: flat, one directory for each skill. The
   * per-runtime nesting of the source tree must not survive the install. Each skill authored for
   * this harness must arrive, because a count of the installed skills passes on any subset.
   */
  it('RenderedSkill_IsDiscoveredByAHarness', async () => {
    const home = join(scratch, 'home');
    mkdirSync(home, { recursive: true });

    const runtimes = loadAllRuntimes(join(clone, 'content/harness/runtimes'));
    const claude = runtimes.find((r) => r.name === 'claude');
    expect(claude, 'the claude runtime map is absent from the clone').toBeDefined();

    await installSkills({
      agent: 'claude',
      runtimes,
      skillsSource: join(clone, 'rendered/skills'),
      homeDir: () => home,
      projectRoot: clone,
      scope: 'user',
      isInteractive: false,
      log: () => {},
      errLog: () => {},
      registerMcp: () => {},
    });

    const installed = join(home, '.claude', 'skills');
    expect(existsSync(installed), `nothing installed at ${installed}`).toBe(true);

    const names = readdirSync(installed, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(names.length, 'the install placed no skills').toBeGreaterThan(0);

    for (const name of names) {
      expect(
        existsSync(join(installed, name, 'SKILL.md')),
        `installed skill '${name}' has no SKILL.md at the flat harness path`,
      ).toBe(true);
    }

    const sourceRoot = join(clone, 'rendered/skills');
    const expected = new Set<string>();
    for (const tier of ['standard', 'claude']) {
      const dir = join(sourceRoot, tier);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) expected.add(entry.name);
      }
    }
    expect(expected.size, 'no skills found in the clone to install').toBeGreaterThan(0);
    expect([...expected].filter((n) => !names.includes(n)), 'authored skills never installed').toEqual(
      [],
    );

    expect(
      names.filter((n) => ['standard', 'claude', 'codex', 'cursor', 'generic'].includes(n)),
      'a per-runtime directory survived the flatten',
    ).toEqual([]);
  }, 120_000);

  /**
   * The harness loads `hooks/hooks.json` from the well-known plugin root. A second declaration in
   * `plugin.json` registers each hook twice, and each hook then fires twice with no failure and no
   * log line. The census counts two sites: the auto-loaded path and an explicit `plugin.json`
   * declaration of any shape.
   *
   * The census is a guard, so the test proves that it can fail. The same function over a plugin
   * that also declares hooks must report the double registration.
   */
  it('PluginHooks_LoadExactlyOnce', () => {
    const census = (
      plugin: Record<string, unknown>,
      hooksConfig: { hooks?: Record<string, unknown[]> },
    ): Map<string, number> => {
      const sites = new Map<string, number>();
      const bump = (type: string) => sites.set(type, (sites.get(type) ?? 0) + 1);
      for (const type of Object.keys(hooksConfig.hooks ?? {})) bump(type);
      const declared = plugin.hooks;
      if (typeof declared === 'string') {
        for (const type of Object.keys(hooksConfig.hooks ?? {})) bump(type);
      } else if (declared && typeof declared === 'object') {
        const inner = (declared as { hooks?: Record<string, unknown> }).hooks ?? declared;
        for (const type of Object.keys(inner as Record<string, unknown>)) bump(type);
      }
      return sites;
    };

    const plugin = readJson(clone, '.claude-plugin/plugin.json');
    const hooksConfig = readJson(clone, 'hooks/hooks.json') as {
      hooks?: Record<string, unknown[]>;
    };

    const declaredTypes = Object.keys(hooksConfig.hooks ?? {});
    expect(declaredTypes.length, 'hooks/hooks.json registers no hook types').toBeGreaterThan(0);

    const sites = census(plugin, hooksConfig);
    for (const [type, count] of sites) {
      expect(count, `hook '${type}' is registered ${count}× — it will fire ${count}×`).toBe(1);
    }

    const doubled = census({ ...plugin, hooks: hooksConfig }, hooksConfig);
    expect(
      [...doubled.values()],
      'the census cannot detect a double registration, so its verdict means nothing',
    ).toEqual(declaredTypes.map(() => 2));
  });
});
