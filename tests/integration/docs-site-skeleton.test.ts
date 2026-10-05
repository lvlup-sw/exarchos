// The published site is a skeleton: a config, one index and `public/`.
//
// The site must build. The `docs:build` script and the `docs/` source tree are the wiring that these tests check.
//
// The build must publish only the skeleton. `docs/` is also the mount point of `npm run docs:mount`,
// which links several hundred internal designs, plans and RCAs into it. A build that picks them up
// succeeds and publishes them to a public GitHub Pages site, so no failure shows the leak.
//
// The two sides come from different places. The published set comes from the build output, and the
// set that must stay private comes from the live directory. A config that excludes nothing agrees with itself.
//
// @oracle-sources: vitepress-build-output, live-docs-directory-listing, ../../package.json, ../../tools/release/mount-docs.mjs
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnAsync, type SpawnResult } from '../../tools/test-helpers/spawn.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const DIST_DIR = path.join(DOCS_DIR, '.vitepress', 'dist');

/** The relocated subtrees currently linked into `docs/` by `docs:mount`. */
function mountedSubtrees(): string[] {
  return readdirSync(DOCS_DIR, { withFileTypes: true })
    .filter((e) => e.isSymbolicLink())
    .map((e) => e.name)
    .sort();
}

/** Every file the build emitted, as paths relative to `dist/`. */
function publishedFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(path.join(DIST_DIR, rel), { withFileTypes: true })) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else out.push(child);
    }
  };
  walk('');
  return out.sort();
}

let build: SpawnResult;

/** The build runs through the npm script, not the vitepress binary, so a `docs:build` script that points at a wrong tree fails here. */
beforeAll(async () => {
  build = await spawnAsync('npm', ['run', 'docs:build'], {
    cwd: REPO_ROOT,
    timeout: 180_000,
  });
}, 200_000);

describe('the reduced documentation site', () => {
  /**
   * The index must contain the text `Exarchos`, not only exist.
   * `public/` is served verbatim, and the deploy workflow stages the bootstrap installers into it.
   * A build that omits `public/` breaks the install one-liner in the README.
   */
  it('Documentation_AfterReduction_VitePressStillBuilds', () => {
    expect(
      build.status,
      `\`npm run docs:build\` failed.\n--- stdout ---\n${build.stdout}\n--- stderr ---\n${build.stderr}`,
    ).toBe(0);

    expect(existsSync(path.join(DIST_DIR, 'index.html')), 'no index.html was emitted').toBe(true);

    const index = readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8');
    expect(index).toContain('Exarchos');

    expect(existsSync(path.join(DIST_DIR, 'logo.svg')), 'public/ was not published').toBe(true);
  });

  /**
   * The pages must be exactly the home page and the 404 page of VitePress.
   * A containment check passes with extra pages, so the check is an equality.
   * `docs/README.md` explains the directory to a repository reader. VitePress treats it as an index candidate, so it must stay out.
   */
  it('Documentation_AfterReduction_PublishesOnlyTheSkeleton', () => {
    expect(build.status, 'build failed; the publication set is not meaningful').toBe(0);

    const published = publishedFiles();
    const pages = published.filter((f) => f.endsWith('.html')).sort();

    expect(pages, `unexpected pages published:\n${pages.join('\n')}`).toEqual([
      '404.html',
      'index.html',
    ]);

    expect(pages).not.toContain('README.html');
  });

  /**
   * With no mount, as on CI, the test prints a warning and checks only that `docs/index.md` exists.
   * Each mount is a symlink to a directory of documents. If VitePress follows one, the documents appear as rendered pages under that name.
   * The match needs an `.html` file under the mount name. A match on the name alone reports a false leak on each build.
   * Vite writes its chunks and fonts to `dist/assets/`, and `docs/assets` is one of the mounted subtrees.
   */
  it('Documentation_WithDocumentsMounted_ExcludesEveryMountedSubtree', () => {
    const mounted = mountedSubtrees();

    if (mounted.length === 0) {
      console.warn(
        '[docs-site] no relocated subtrees are mounted here, so the mount-leak arm had no ' +
          'subject. Run `npm run docs:mount` and re-run to exercise it.',
      );
      expect(existsSync(path.join(DOCS_DIR, 'index.md'))).toBe(true);
      return;
    }

    const published = publishedFiles();
    const leaked = mounted.filter((name) =>
      published.some((f) => f.startsWith(`${name}/`) && f.endsWith('.html')),
    );

    expect(
      leaked,
      `relocated document subtrees were published to the public site: ${leaked.join(', ')}. ` +
        'These are internal designs, plans and RCAs. The config excludes what is mounted by ' +
        'reading the tree for symlinks — that read has stopped matching the mount.',
    ).toEqual([]);
  });

  /** The skeleton replaces the `documentation/` tree. If that tree stays, the repo holds two copies of the site. */
  it('Documentation_AfterReduction_TheRetiredSiteIsGone', async () => {
    expect(
      existsSync(path.join(REPO_ROOT, 'documentation')),
      'documentation/ still exists — the site was reduced but the old tree was not removed',
    ).toBe(false);

    const tracked = await spawnAsync('git', ['-C', REPO_ROOT, 'ls-files', '--', 'documentation']);
    expect(tracked.status, 'git ls-files failed').toBe(0);
    expect(tracked.stdout.trim(), 'files are still tracked under documentation/').toBe('');
  });

  it('Documentation_AfterReduction_TheDocsScriptsTargetTheNewTree', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    for (const name of ['docs:dev', 'docs:build', 'docs:preview']) {
      const script = manifest.scripts[name];
      expect(script, `${name} is missing`).toBeDefined();
      expect(script, `${name} still points at the removed tree`).not.toContain('documentation');
      expect(script, `${name} does not build from docs/`).toContain('docs');
    }
  });

  /**
   * The exclusion depends on this premise. If the site source leaves the directory that the documents mount into,
   * the symlink-based exclusion excludes nothing, and the other tests still pass.
   */
  it('the mount point and the site source are the same directory', () => {
    expect(existsSync(path.join(DOCS_DIR, '.vitepress', 'config.ts'))).toBe(true);
    const mountRoot = readFileSync(
      path.join(REPO_ROOT, 'tools', 'release', 'mount-docs.mjs'),
      'utf8',
    );
    expect(mountRoot, 'the mount script no longer links into docs/').toContain("'docs', name");
  });
});

/** Guards the helpers. A walk of `dist` that finds nothing makes the mount-leak check pass with no subject. */
describe('the publication census', () => {
  it('found the build output', () => {
    expect(build.status).toBe(0);
    expect(publishedFiles().length, 'the dist walk enumerated nothing').toBeGreaterThan(3);
  });

  /** `docs/` also holds real files. If the census counts them as mounts, the exclusion covers the skeleton and the site publishes nothing. */
  it('reads mounts by link type, not by name', () => {
    for (const name of ['README.md', 'index.md']) {
      const p = path.join(DOCS_DIR, name);
      if (!existsSync(p)) continue;
      expect(lstatSync(p).isSymbolicLink(), `${name} should be a real file`).toBe(false);
    }
  });
});
