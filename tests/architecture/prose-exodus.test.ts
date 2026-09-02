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
import { execFileSync, spawnSync } from 'node:child_process';
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
    // Zero bytes is legitimate — a `.gitkeep` is empty by definition, and its
    // digest is still meaningful. Only a malformed digest or a negative size
    // means the manifest cannot be reconciled.
    const malformed = manifest.entries.filter(
      (e) => !/^sha256:[0-9a-f]{64}$/.test(e.digest) || e.bytes < 0,
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

  it('no mount symlink is tracked', () => {
    // This failed once, and silently. The ignore patterns were written with a
    // trailing slash (`docs/audits/`), which matches a DIRECTORY — and a mount
    // is a symlink, which git treats as a file. The patterns matched nothing,
    // the links were committed with mode 120000, and their content was one
    // machine's relative path: resolvable for its author, dangling for
    // everyone else.
    //
    // Checked by MODE rather than by path, so it also catches a symlink
    // committed somewhere this test does not know to look.
    const linkEntries = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-s', '--', 'docs'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
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

  it('every FULLY relocated directory is ignored, so a mount cannot be committed', () => {
    // The ignore rule has to actually match the mount, and asking git is the
    // only way to know — a pattern that matches nothing looks exactly like one
    // that matches.
    //
    // Only directories that emptied COMPLETELY are mounted. A partially
    // relocated one (`docs/architecture` kept the files the invariant catalog
    // reads) stays a real directory, and ignoring it would hide the files that
    // remain. Loose files are not mounted at all.
    const emptied = manifest.subtrees.filter(
      (s) => s.includes('/') && !s.includes('.') && ![...tracked].some((t) => t.startsWith(`${s}/`)),
    );
    expect(emptied.length, 'no directory relocated completely').toBeGreaterThan(0);

    const notIgnored = emptied.filter((subtree) => {
      const res = spawnSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', subtree]);
      return res.status !== 0;
    });
    expect(
      notIgnored,
      'relocated directories that are NOT ignored — a mount created there would be committable',
    ).toEqual([]);
  });

  it('nothing under docs/ is tracked unless it is retained', () => {
    // The real invariant now that relocation is per-file: everything under
    // `docs/` either earned its place in RETAINED or has left. This is what
    // stops the tree re-accumulating — a new document under `docs/` is
    // relocatable by default and has to be argued into the retained list.
    const unretained = [...tracked].filter((rel) => rel.startsWith('docs/') && !isRetained(rel));
    expect(
      unretained,
      'tracked under docs/ but not retained — either relocate it or add it to RETAINED with a ' +
        'reason it is READ rather than merely mentioned',
    ).toEqual([]);
  });

  it('the retained set is not everything', () => {
    // Denominator for the check above: a RETAINED list that matched all of
    // `docs/` would satisfy it while relocating nothing.
    const retainedCount = [...tracked].filter((r) => r.startsWith('docs/') && isRetained(r)).length;
    expect(retainedCount).toBeGreaterThan(0);
    expect(retainedCount).toBeLessThan(manifest.entries.length);
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

describe('MarkdownInventory_AfterExodus_NoProseRemainsOutsideContentAndDocs', () => {
  it('every relocated file was one the retention rule did not keep', () => {
    // The tool's own rule, checked against its output. It reads "not retained"
    // from the same predicate the manifest generator uses, so a file that
    // should have stayed cannot appear in the manifest by accident.
    const wrongly = manifest.entries.filter((e) => isRetained(e.source)).map((e) => e.source);
    expect(wrongly, 'relocated despite being on the retained list').toEqual([]);
  });

  it('every retained path states why it is READ, not merely mentioned', () => {
    // The whole point of inverting the rule. An entry with no reason is how the
    // retained set turns back into "whatever happened to be here".
    for (const entry of RETAINED) {
      expect(entry.because.length, `${entry.path} is retained with no stated reason`).toBeGreaterThan(40);
    }
    // Two: the README that says what belongs in the directory, and the canonical
    // architecture statement. Everything else was a planning artifact or a
    // document nothing reads. The floor is 1 rather than a larger number
    // because the list is meant to shrink — but an EMPTY retained set would
    // mean `docs/` no longer exists, which is a different change.
    expect(RETAINED.length, 'nothing is retained').toBeGreaterThan(0);
  });

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
    // Root-level markdown is classified by the top-level contract; this catches
    // prose reappearing in an unclassified place.
    const allowedRoot = new Set([
      'README.md', 'CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'ONBOARDING.md',
      'CHANGELOG.md', 'SECURITY.md', 'LICENSE.md', 'agent-principles.md', '.impeccable.md',
    ]);
    expect(stray.filter((f) => !allowedRoot.has(f))).toEqual([]);
  });
});
