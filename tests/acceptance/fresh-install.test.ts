import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { installSkills } from '../../src/install/install-skills.js';
import { loadAllRuntimes } from '../../src/install/runtimes/load.js';

/**
 * Repinning `plugin.json` at the `rendered/` tree is a sanctioned clean break,
 * and only an end-to-end install proves it landed.
 *
 * Every other check in this repo reads the working tree, where an untracked or
 * ignored file satisfies `existsSync` just as well as a committed one. A
 * consumer gets neither. So the subject here is a tracked-files-only
 * materialization of HEAD, and the questions asked of it are the three a wrong
 * flatten, a wrong repin, or a double-registered hook would each answer
 * differently — while leaving a tree that looks correct on disk.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');

let clone: string;
let scratch: string;

/** Materialize HEAD's tracked content — no working-tree residue, no .git. */
function materializeCleanClone(dest: string): void {
  const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], {
    cwd: REPO_ROOT,
    maxBuffer: 512 * 1024 * 1024,
    // A Buffer, not a string: the archive is binary and utf8 decoding corrupts it.
    encoding: 'buffer',
  });
  execFileSync('tar', ['-x', '-C', dest], { input: archive, maxBuffer: 512 * 1024 * 1024 });
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

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'exarchos-fresh-install-'));
  clone = join(scratch, 'clone');
  mkdirSync(clone, { recursive: true });
  materializeCleanClone(clone);
}, 120_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('FreshInstall', () => {
  it('FromCleanClone_ResolvesSkillsCommandsAndAgents', () => {
    // Guard the denominator first: an empty clone would pass every loop below
    // by never entering one.
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
      // Present-but-empty is the shape a gitignored payload leaves behind: the
      // parent directory survives because a sibling is tracked, the payload
      // does not.
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

  it('RenderedSkill_IsDiscoveredByAHarness', async () => {
    // The install runs against the CLONE, into a throwaway HOME — the same
    // local-copy path a consumer takes, with nothing from this working tree
    // and nothing written outside the scratch dir.
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
      // The real one writes ~/.claude.json; this install is about skill placement.
      registerMcp: () => {},
    });

    // `~/.claude/skills/<name>/SKILL.md` — flat, one directory per skill. The
    // per-runtime nesting the source tree carries must not survive the install,
    // because this path is what the harness reads.
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

    // Every skill authored for this harness has to arrive. Counting only the
    // ones that did would pass on any subset, including one.
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

    // A runtime dir surviving into the install means the flatten did not happen.
    expect(
      names.filter((n) => ['standard', 'claude', 'codex', 'cursor', 'generic'].includes(n)),
      'a per-runtime directory survived the flatten',
    ).toEqual([]);
  }, 120_000);

  it('PluginHooks_LoadExactlyOnce', () => {
    // `hooks/hooks.json` is auto-loaded from the well-known plugin root.
    // Declaring it in plugin.json as well registers it a second time, and every
    // hook fires twice — a duplication with no failure and no log line.
    const census = (
      plugin: Record<string, unknown>,
      hooksConfig: { hooks?: Record<string, unknown[]> },
    ): Map<string, number> => {
      const sites = new Map<string, number>();
      const bump = (type: string) => sites.set(type, (sites.get(type) ?? 0) + 1);
      // Site 1 — the auto-loaded well-known path.
      for (const type of Object.keys(hooksConfig.hooks ?? {})) bump(type);
      // Site 2 — an explicit plugin.json declaration, whatever shape it takes.
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

    // The census is itself a guard, so prove it can fail: the same function over
    // a plugin that also declares hooks must name the double registration.
    const doubled = census({ ...plugin, hooks: hooksConfig }, hooksConfig);
    expect(
      [...doubled.values()],
      'the census cannot detect a double registration, so its verdict means nothing',
    ).toEqual(declaredTypes.map(() => 2));
  });
});
