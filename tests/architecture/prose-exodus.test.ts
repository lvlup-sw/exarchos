// The prose exodus. The manifest proves that each relocated document arrived
// at its destination before this repository removed it.
//
// The manifest holds a source path, a destination path, a byte length and a
// SHA-256 digest for each file.
//
// Each run checks that the manifest is well-formed and that each relocated
// file is absent here. A listed file that is still present shows a transfer
// with no deletion. When the destination is checked out, the suite also
// computes each digest again.
//
// CI has no destination checkout. There the digest check reports that it did
// not run, because a skipped reconciliation is not one that passed.
//
// @oracle-sources: ../../tools/audit/prose-manifest.json, live-git-tracked-file-listing

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  reconcile,
  formatReconcile,
  isRetained,
  RETAINED,
  type ProseManifest,
} from '../../tools/audit/prose-manifest.js';
import { execFileAsync, spawnAsync } from '../../tools/test-helpers/spawn.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'tools/audit/prose-manifest.json');

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as ProseManifest;

/** The tracked files, relative to the repository root. A symlinked mount is untracked, so it is not in this set. */
const tracked = new Set(
  (await execFileAsync('git', ['-C', REPO_ROOT, 'ls-files', '-z']))
    .split('\0')
    .filter((rel) => rel.length > 0),
);

describe('ProseManifest_EveryRelocatedFile_IsPresentAtTheDestinationWithAMatchingDigest', () => {
  /** The denominator. An empty manifest satisfies each check below, and also the reconciliation. */
  it('the manifest is not empty', () => {
    expect(manifest.entries.length, 'the manifest records no relocated file').toBeGreaterThan(0);
    expect(manifest.subtrees.length, 'the manifest names no subtree').toBeGreaterThan(0);
    expect(manifest.counts.files).toBe(manifest.entries.length);
  });

  /** Without a named destination, only the person who ran the transfer can reconcile the manifest. */
  it('it names its destination', () => {
    expect(manifest.destinationRepo).toMatch(/\S+\/\S+/);
    expect(manifest.destinationKey.length).toBeGreaterThan(0);
  });

  /**
   * Zero bytes is valid: a `.gitkeep` is empty, and its digest still has
   * meaning. Only a malformed digest or a negative size fails.
   */
  it('every entry carries a real digest and a real size', () => {
    const malformed = manifest.entries.filter(
      (e) => !/^sha256:[0-9a-f]{64}$/.test(e.digest) || e.bytes < 0,
    );
    expect(malformed.map((e) => e.source), 'entries with no usable digest or size').toEqual([]);
  });

  /**
   * The destination mirrors the source path. With that layout, a mount is one
   * symlink for each directory and needs no translation table.
   */
  it('every destination path is under the key, with the source path preserved', () => {
    const wrong = manifest.entries.filter(
      (e) => e.destination !== `${manifest.destinationKey}/${e.source}`,
    );
    expect(wrong.map((e) => e.destination), 'destination paths that do not mirror the source').toEqual([]);
  });

  /** A listed file that is still tracked here shows a copy with no removal. */
  it('every relocated file really is gone from this repository', () => {
    const stillHere = manifest.entries.filter((e) => tracked.has(e.source)).map((e) => e.source);
    expect(
      stillHere,
      'files the manifest says were relocated but which are still tracked here',
    ).toEqual([]);
  });

  /**
   * An ignore pattern with a trailing slash matches a directory. A mount is a
   * symlink, which git treats as a file, so such a pattern does not match it.
   * A committed symlink holds the relative path of one machine and dangles on
   * each other machine. The test checks by mode, so it finds a symlink at any
   * path under `docs/`.
   */
  it('no mount symlink is tracked', async () => {
    const linkEntries = (await execFileAsync('git', ['-C', REPO_ROOT, 'ls-files', '-s', '--', 'docs']))
      .split('\n')
      .filter((line) => line.startsWith('120000'))
      .map((line) => line.split('\t')[1] ?? line);

    expect(
      linkEntries,
      'symlinks tracked under docs/. A committed symlink stores its target as content, so it ' +
        'hard-codes one checkout\'s layout and dangles in every other. Untrack it and ignore the ' +
        'path WITHOUT a trailing slash.',
    ).toEqual([]);
  });

  /**
   * Only git can prove that an ignore rule matches the mount, because a pattern
   * that matches nothing looks the same as one that matches. Only a directory
   * that is fully relocated is a mount. A partly relocated directory stays a
   * real directory, and an ignore rule there hides the files that remain.
   */
  it('every FULLY relocated directory is ignored, so a mount cannot be committed', async () => {
    const emptied = manifest.subtrees.filter(
      (s) => s.includes('/') && !s.includes('.') && ![...tracked].some((t) => t.startsWith(`${s}/`)),
    );
    expect(emptied.length, 'no directory relocated completely').toBeGreaterThan(0);

    const notIgnored: string[] = [];
    for (const subtree of emptied) {
      const res = await spawnAsync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', subtree]);
      if (res.status !== 0) notIgnored.push(subtree);
    }
    expect(
      notIgnored,
      'relocated directories that are NOT ignored — a mount created there would be committable',
    ).toEqual([]);
  });

  /**
   * Each file under `docs/` is in `RETAINED` or is relocated. A new document
   * under `docs/` is relocatable by default, so the tree does not fill with
   * prose again.
   */
  it('nothing under docs/ is tracked unless it is retained', () => {
    const unretained = [...tracked].filter((rel) => rel.startsWith('docs/') && !isRetained(rel));
    expect(
      unretained,
      'tracked under docs/ but not retained — either relocate it or add it to RETAINED with a ' +
        'reason it is READ rather than merely mentioned',
    ).toEqual([]);
  });

  /**
   * The denominator for the test above. A `RETAINED` list that matches all of
   * `docs/` satisfies that test and relocates nothing.
   */
  it('the retained set is not everything', () => {
    const retainedCount = [...tracked].filter((r) => r.startsWith('docs/') && isRetained(r)).length;
    expect(retainedCount).toBeGreaterThan(0);
    expect(retainedCount).toBeLessThan(manifest.entries.length);
  });

  /**
   * With no destination checkout, the test warns that the reconciliation did
   * not run. `npm run docs:exodus:reconcile <path>` runs the same comparison.
   */
  it('reconciles against the destination when it is checked out', () => {
    const destination = resolveDestinationCheckout();
    if (destination === undefined) {
      console.warn(
        `[prose-exodus] destination checkout of ${manifest.destinationRepo} not found beside ` +
          'this repository — digest reconciliation did not run here. It is proven at transfer ' +
          'time and re-runnable via `npm run docs:exodus:reconcile <path>`.',
      );
      expect(manifest.entries.length).toBeGreaterThan(0);
      return;
    }
    const result = reconcile(manifest, destination);
    expect(result.checked, 'reconciled nothing').toBe(manifest.entries.length);
    expect(result.ok, formatReconcile(result)).toBe(true);
  });
});

/** A sibling checkout of the destination repository, when one exists. */
function resolveDestinationCheckout(): string | undefined {
  const repoName = manifest.destinationRepo.split('/').pop() ?? 'docs';
  const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const idx = REPO_ROOT.indexOf(marker);
  const mainCheckout = idx === -1 ? REPO_ROOT : REPO_ROOT.slice(0, idx);
  const candidate = path.resolve(path.dirname(mainCheckout), repoName);
  return fs.existsSync(path.join(candidate, manifest.destinationKey)) ? candidate : undefined;
}

describe('MarkdownInventory_AfterExodus_NoProseRemainsOutsideContentAndDocs', () => {
  /**
   * The test uses the retention predicate of the manifest generator. Thus a
   * retained file cannot be in the manifest by accident.
   */
  it('every relocated file was one the retention rule did not keep', () => {
    const wrongly = manifest.entries.filter((e) => isRetained(e.source)).map((e) => e.source);
    expect(wrongly, 'relocated despite being on the retained list').toEqual([]);
  });

  /**
   * An entry with no reason lets the retained set become a list of what is
   * there. The minimum is one entry because the list can shrink. An empty list
   * means that `docs/` is gone, which is a different change.
   */
  it('every retained path states why it is READ, not merely mentioned', () => {
    for (const entry of RETAINED) {
      expect(entry.because.length, `${entry.path} is retained with no stated reason`).toBeGreaterThan(40);
    }
    expect(RETAINED.length, 'nothing is retained').toBeGreaterThan(0);
  });

  /**
   * The filter keeps only root-level markdown, and each such file must be in the
   * allowed set. The top-level contract classifies the root-level files.
   */
  it('no tracked markdown sits outside the classified roots', () => {
    const stray = [...tracked].filter(
      (rel) =>
        rel.endsWith('.md') &&
        !rel.startsWith('content/') &&
        !rel.startsWith('rendered/') &&
        !rel.startsWith('docs/') &&
        !rel.startsWith('tests/') &&
        !rel.startsWith('tools/') &&
        !rel.startsWith('src/') &&
        !rel.startsWith('.github/') &&
        !rel.includes('/'),
    );
    const allowedRoot = new Set([
      'README.md', 'CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'ONBOARDING.md',
      'CHANGELOG.md', 'SECURITY.md', 'LICENSE.md', 'agent-principles.md', '.impeccable.md',
    ]);
    expect(stray.filter((f) => !allowedRoot.has(f))).toEqual([]);
  });
});
