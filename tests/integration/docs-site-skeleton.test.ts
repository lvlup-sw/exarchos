// ─── The published site, after the reduction ─────────────────────────────────
//
// `documentation/` held 46 hand-written pages describing an Exarchos several
// refactors out of date. They were removed rather than migrated and what
// survives is the machinery: a config, one index, and `public/`.
//
// Two things have to stay true, and only one of them is obvious.
//
// The obvious one is that the site still builds — a skeleton nobody can build
// is not a skeleton, it is rubble, and the reduction moved the toolchain into
// the root manifest and the source into `docs/`, so every part of that wiring
// is new.
//
// The other is that the build publishes ONLY the skeleton. `docs/` is also the
// mount point for the relocated documents: `npm run docs:mount` links several
// hundred internal designs, plans and RCAs into this exact directory. Nothing
// fails if they are picked up — the build succeeds, and publishes them to a
// public GitHub Pages site. That failure is silent, which is why it is asserted
// here rather than trusted to the config being obviously correct.
//
// The two sides never come from the same place: what the site PUBLISHES is read
// out of the build output, and what it MUST NOT publish is read from the live
// directory. A config that excluded nothing would agree with itself.
//
// @oracle-sources: vitepress-build-output, live-docs-directory-listing, ../../package.json, ../../tools/release/mount-docs.mjs
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

let build: ReturnType<typeof spawnSync>;

beforeAll(() => {
  // Through the npm script, not the vitepress binary. The script string is
  // itself part of what this task retargeted, and invoking the binary directly
  // would leave a `docs:build` that points at the deleted tree passing.
  build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'docs:build'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 180_000,
  });
}, 200_000);

describe('the reduced documentation site', () => {
  it('Documentation_AfterReduction_VitePressStillBuilds', () => {
    expect(
      build.status,
      `\`npm run docs:build\` failed.\n--- stdout ---\n${build.stdout ?? ''}\n--- stderr ---\n${build.stderr ?? ''}`,
    ).toBe(0);

    expect(existsSync(path.join(DIST_DIR, 'index.html')), 'no index.html was emitted').toBe(true);

    // The hero index rendered rather than merely existing as an empty shell.
    const index = readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8');
    expect(index).toContain('Exarchos');

    // `public/` is served verbatim, and it is what the deploy workflow stages
    // the bootstrap installers into. A build that drops it takes the README's
    // install one-liner down with it.
    expect(existsSync(path.join(DIST_DIR, 'logo.svg')), 'public/ was not published').toBe(true);
  });

  it('Documentation_AfterReduction_PublishesOnlyTheSkeleton', () => {
    expect(build.status, 'build failed; the publication set is not meaningful').toBe(0);

    const published = publishedFiles();
    const pages = published.filter((f) => f.endsWith('.html')).sort();

    // Exactly the home page and VitePress's own 404. Stated as equality rather
    // than "contains index.html", because the failure this guards is EXTRA
    // pages, which every containment check passes.
    expect(pages, `unexpected pages published:\n${pages.join('\n')}`).toEqual([
      '404.html',
      'index.html',
    ]);

    // `docs/README.md` explains the directory to someone reading the
    // repository. VitePress also treats README.md as an index candidate, so
    // leaving it in makes the home page ambiguous as well as public.
    expect(pages).not.toContain('README.html');
  });

  it('Documentation_WithDocumentsMounted_ExcludesEveryMountedSubtree', () => {
    const mounted = mountedSubtrees();

    if (mounted.length === 0) {
      // Reported, never silently skipped. On CI nothing is mounted and there is
      // genuinely nothing to exclude — but a reader has to be able to tell that
      // from the assertion having run and found the tree clean.
      console.warn(
        '[docs-site] no relocated subtrees are mounted here, so the mount-leak arm had no ' +
          'subject. Run `npm run docs:mount` and re-run to exercise it.',
      );
      expect(existsSync(path.join(DOCS_DIR, 'index.md'))).toBe(true);
      return;
    }

    // Each mount is a symlink to a directory of documents. If VitePress
    // followed one, those documents land under that name in the output as
    // RENDERED PAGES — which is the form that matters, and also the only form
    // that can be told apart from the bundler's own output. Vite emits its
    // chunks and fonts to `dist/assets/`, and `docs/assets` happens to be one
    // of the mounted subtrees, so a match on directory name alone reports a
    // leak on every build that ever bundles a stylesheet.
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

  it('Documentation_AfterReduction_TheRetiredSiteIsGone', () => {
    // The reduction is only real if the old tree left. A skeleton beside the
    // 46 pages it replaced is not a reduction, it is a second copy.
    expect(
      existsSync(path.join(REPO_ROOT, 'documentation')),
      'documentation/ still exists — the site was reduced but the old tree was not removed',
    ).toBe(false);

    const tracked = spawnSync('git', ['-C', REPO_ROOT, 'ls-files', '--', 'documentation'], {
      encoding: 'utf8',
    });
    expect(tracked.status, 'git ls-files failed').toBe(0);
    expect((tracked.stdout ?? '').trim(), 'files are still tracked under documentation/').toBe('');
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

  it('the mount point and the site source are the same directory', () => {
    // The premise the exclusion rests on. If the site ever moves out of the
    // directory the documents mount into, the symlink-derived exclusion becomes
    // an elaborate no-op and this suite would keep passing.
    expect(existsSync(path.join(DOCS_DIR, '.vitepress', 'config.ts'))).toBe(true);
    const mountRoot = readFileSync(
      path.join(REPO_ROOT, 'tools', 'release', 'mount-docs.mjs'),
      'utf8',
    );
    expect(mountRoot, 'the mount script no longer links into docs/').toContain("'docs', name");
  });
});

/** Guard the helper itself: a walk that finds nothing passes every check above. */
describe('the publication census', () => {
  it('found the build output', () => {
    expect(build.status).toBe(0);
    expect(publishedFiles().length, 'the dist walk enumerated nothing').toBeGreaterThan(3);
  });

  it('reads mounts by link type, not by name', () => {
    // `docs/` holds real entries too. If this ever counted them as mounts the
    // exclusion would grow to cover the skeleton and publish nothing at all.
    for (const name of ['README.md', 'index.md']) {
      const p = path.join(DOCS_DIR, name);
      if (!existsSync(p)) continue;
      expect(lstatSync(p).isSymbolicLink(), `${name} should be a real file`).toBe(false);
    }
  });
});
