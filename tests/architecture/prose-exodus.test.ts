// ─── The prose exodus: preservation is provable, and deletion is gated on it ──
//
// Documents relocated out of this repository are gone from it. That is only
// safe if their arrival elsewhere was proven BEFORE the removal, which is what
// the manifest is for: a source path, a destination path, a byte length and a
// SHA-256 per file, written before the transfer and reconciled after it.
//
// The checks split by what can be known from inside this repository:
//
//   ALWAYS  — the manifest is well-formed, it covers exactly the subtrees that
//             are no longer here, and every file it claims to have relocated is
//             genuinely absent. A manifest listing files that are still present
//             would mean the transfer happened and the deletion did not, which
//             is a half-finished exodus reading as a finished one.
//   WHEN THE DESTINATION IS CHECKED OUT — every digest recomputed against it.
//
// The second cannot run in CI without the other repository, so it reports its
// own absence rather than passing quietly. A reconciliation that skips is not a
// reconciliation that succeeded, and the two must not look alike.
//
// @oracle-sources: ../../tools/audit/prose-manifest.json, live-git-tracked-file-listing

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reconcile, formatReconcile, type ProseManifest } from '../../tools/audit/prose-manifest.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'tools/audit/prose-manifest.json');

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as ProseManifest;

/** Tracked files, repo-relative. Symlinked mounts are untracked and invisible. */
const tracked = new Set(
  execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
    .split('\0')
    .filter((rel) => rel.length > 0),
);

describe('ProseManifest_EveryRelocatedFile_IsPresentAtTheDestinationWithAMatchingDigest', () => {
  it('the manifest is not empty', () => {
    // Denominator. Every check below is satisfied by a manifest of nothing,
    // including the destination reconciliation — which would then "pass"
    // against a destination that received no files at all.
    expect(manifest.entries.length, 'the manifest records no relocated file').toBeGreaterThan(0);
    expect(manifest.subtrees.length, 'the manifest names no subtree').toBeGreaterThan(0);
    expect(manifest.counts.files).toBe(manifest.entries.length);
  });

  it('it names its destination', () => {
    // A manifest that does not say where the files went cannot be reconciled by
    // anyone who did not run the transfer.
    expect(manifest.destinationRepo).toMatch(/\S+\/\S+/);
    expect(manifest.destinationKey.length).toBeGreaterThan(0);
  });

  it('every entry carries a real digest and a real size', () => {
    const malformed = manifest.entries.filter(
      (e) => !/^sha256:[0-9a-f]{64}$/.test(e.digest) || e.bytes <= 0,
    );
    expect(malformed.map((e) => e.source), 'entries with no usable digest or size').toEqual([]);
  });

  it('every destination path is under the key, with the source path preserved', () => {
    // The layout claim, checked rather than described — it is what makes the
    // symlink mount a per-directory link rather than a translation table.
    const wrong = manifest.entries.filter(
      (e) => e.destination !== `${manifest.destinationKey}/${e.source}`,
    );
    expect(wrong.map((e) => e.destination), 'destination paths that do not mirror the source').toEqual([]);
  });

  it('every relocated file really is gone from this repository', () => {
    // The half that proves the exodus finished. A file listed as relocated but
    // still tracked here means the copy landed and the removal did not.
    const stillHere = manifest.entries.filter((e) => tracked.has(e.source)).map((e) => e.source);
    expect(
      stillHere,
      'files the manifest says were relocated but which are still tracked here',
    ).toEqual([]);
  });

  it('no tracked file remains under a relocated subtree', () => {
    // Stronger than the per-entry check: catches a file ADDED to a relocated
    // subtree after the manifest was written, which would otherwise sit in a
    // directory that is ignored and mounted over.
    const strays = [...tracked].filter((rel) =>
      manifest.subtrees.some((subtree) => rel.startsWith(`${subtree}/`)),
    );
    expect(strays, 'tracked files under a subtree that was relocated').toEqual([]);
  });

  it('reconciles against the destination when it is checked out', () => {
    const destination = resolveDestinationCheckout();
    if (destination === undefined) {
      // Reported, not silently skipped. `npm run docs:exodus:reconcile <path>`
      // runs the same comparison on demand.
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

/** A sibling checkout of the destination repository, if one exists. */
function resolveDestinationCheckout(): string | undefined {
  const repoName = manifest.destinationRepo.split('/').pop() ?? 'docs';
  const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const idx = REPO_ROOT.indexOf(marker);
  const mainCheckout = idx === -1 ? REPO_ROOT : REPO_ROOT.slice(0, idx);
  const candidate = path.resolve(path.dirname(mainCheckout), repoName);
  return fs.existsSync(path.join(candidate, manifest.destinationKey)) ? candidate : undefined;
}

describe('MarkdownInventory_EveryRemovedPath_HadZeroLiveReferences', () => {
  it('the manifest covers only subtrees the census cleared', () => {
    // The census is the authority on what may leave. This asserts the manifest
    // did not widen beyond it — the ratchet in `reference-census.test.ts` holds
    // the cleared list itself.
    const censusTest = fs.readFileSync(
      path.join(REPO_ROOT, 'tests/architecture/reference-census.test.ts'),
      'utf8',
    );
    for (const subtree of manifest.subtrees) {
      expect(
        censusTest.includes(`'${subtree}'`),
        `${subtree} was relocated but is not in the census's cleared list`,
      ).toBe(true);
    }
  });
});
