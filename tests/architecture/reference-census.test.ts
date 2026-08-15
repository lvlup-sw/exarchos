/**
 * Which subtrees can actually be deleted, and which are still load-bearing.
 *
 * Deletion is the one step in this refactor with no cheap undo, so it is gated
 * on measurement rather than on the plan's intent. The census counts real
 * referrers; this file turns those counts into a gate and keeps it honest as
 * references are cleaned up.
 *
 * A referrer is LIVE if a reader or a tool would follow it: source, config,
 * snapshots, and instruction markdown outside `docs/`. A dated record under
 * `docs/` that mentions a path is history — rewriting it to survive a refactor
 * would falsify the record it exists to keep.
 *
 * ── THE GATE INVERTED, AND SO DID THIS FILE ─────────────────────────────────
 * This used to gate deletion: a subtree could leave only when nothing pointed
 * at it. Measured, that rule blocked 462 files on 362 references — and 200 of
 * those were a path in a COMMENT, a citation rather than a dependency. 128
 * pointed into `docs/designs/` or `docs/plans/`, which the comment policy
 * already forbids on the stated grounds that the document may move out of this
 * repository. The gate was preserving links another rule wanted deleted.
 *
 * The exodus is now governed by a RETAINED list — what stays, and why each
 * entry is READ rather than merely mentioned — enforced in
 * `prose-exodus.test.ts`. What is left for the census is the question that list
 * cannot answer about itself: is each retained subtree genuinely load-bearing,
 * or is the list hoarding? That fails in the direction that matters — a
 * retained subtree nothing references is one that should have left.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

type Subtree = {
  disposition: 'delete' | 're-home';
  ownFiles: number;
  externalReferrers: number;
  liveReferrers: number;
  referrersByKind: {
    code: number;
    config: number;
    snapshot: number;
    markdownLive: number;
    markdownArchival: number;
    other: number;
  };
  sampleLiveCodeReferrers: string[];
};

type Census = {
  trackedFiles: number;
  scannedFiles: number;
  namedFilesIncluded: string[];
  subtrees: Record<string, Subtree>;
};

/**
 * Committed capture. A drift snapshot, not the oracle: every assertion below
 * reads the live measurer so a referrer that appears the moment after a
 * capture still fails this suite.
 */
const snapshot = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/reference-census.json'), 'utf8'),
) as Census;

const census = JSON.parse(
  execFileSync(process.execPath, [path.join(REPO_ROOT, 'tools/audit/measure-reference-census.mjs')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
) as Census;

const deletionCandidates = Object.entries(census.subtrees).filter(
  ([, s]) => s.disposition === 'delete',
);

/**
 * Subtrees that have already LEFT for the external documents repository. They
 * still appear in the census — the directory is a mount point now — but with
 * zero files of their own.
 *
 * They are separated from the cleared set for a reason worth stating: after a
 * relocation, "zero live referrers" is trivially true of a directory holding
 * nothing, so a single cleared list would keep reporting these four as ready
 * to delete forever, and would keep passing while measuring nothing. Emptiness
 * and cleanliness look identical to a referrer count; only file count tells
 * them apart.
 */
const RELOCATED = ['docs/audits', 'docs/bugs', 'docs/market', 'docs/refactors'];

/**
 * Re-homed subtrees whose move is DONE — the content went somewhere else in
 * this repository rather than out of it, so the census row survives an empty
 * directory. Same reason as {@link RELOCATED}: "holds no files" is a completed
 * move, not a broken measurement, and the two must be told apart by name.
 */
const RE_HOMED_ALREADY = ['docs/evals'];

/**
 * Subtrees measured free of live references and still holding files — the set
 * genuinely eligible to move next. A ratchet: as referrers are retargeted this
 * grows, and it must be updated deliberately, so nothing leaves on the strength
 * of a stale measurement.
 *
 * Empty today, and that is the honest reading: the four that were eligible have
 * gone, and every subtree still here carries live referrers.
 */
const CLEARED_FOR_DELETION: readonly string[] = [];

describe('reference census', () => {
  it('ReferenceCensus_Snapshot_IsCurrentWithTheTree', () => {
    // Tolerance covers ordinary in-flight edits; a structural move blows past it.
    expect(Math.abs(census.trackedFiles - snapshot.trackedFiles)).toBeLessThan(50);
    expect(Object.keys(census.subtrees).sort()).toEqual(Object.keys(snapshot.subtrees).sort());
  });

  it('ReferenceCensus_EveryDeletionCandidate_HasZeroLiveReferences', () => {
    // Equality against the cleared list rather than a blanket zero assertion:
    // most subtrees are still referenced, and pretending otherwise is what the
    // census exists to prevent. Subtrees holding no files are excluded — see
    // RELOCATED — so this set means "clear AND still here".
    const cleared = deletionCandidates
      .filter(([, s]) => s.liveReferrers === 0 && s.ownFiles > 0)
      .map(([name]) => name)
      .sort();

    expect(cleared).toEqual([...CLEARED_FOR_DELETION].sort());
  });

  it('ReferenceCensus_RelocatedSubtree_HoldsNoFilesAndIsNotReCleared', () => {
    // The other half of the distinction, so a relocation cannot silently turn
    // into a permanent "ready to delete" verdict over an empty directory.
    for (const name of RELOCATED) {
      const subtree = census.subtrees[name];
      expect(subtree, `${name} is absent from the census entirely`).toBeDefined();
      expect(subtree?.ownFiles, `${name} was relocated but still holds files`).toBe(0);
      expect(
        CLEARED_FOR_DELETION.includes(name),
        `${name} has already left; it must not also be listed as cleared to delete`,
      ).toBe(false);
    }
  });

  it('ReferenceCensus_EveryRetainedSubtree_IsActuallyReferenced', () => {
    // The inverted question, and the one still worth asking. A subtree kept on
    // the grounds that something reads it, which nothing references, is the
    // retained list hoarding rather than retaining.
    const retainedAndPopulated = Object.entries(census.subtrees).filter(
      ([, s]) => s.ownFiles > 0,
    );

    // Denominator: a census that had lost the ability to see files would report
    // everything as empty and this check would pass on no input.
    expect(
      retainedAndPopulated.length,
      'the census sees no populated subtree at all — it is measuring nothing',
    ).toBeGreaterThan(0);

    const unreferenced = retainedAndPopulated
      .filter(([, s]) => s.liveReferrers === 0)
      .map(([name]) => name);

    expect(
      unreferenced,
      'subtrees still under docs/ that NOTHING references. Either something should read them or ' +
        'they belong in the documents repository — retention is for what is read, not for what ' +
        'happens to be here.',
    ).toEqual([]);
  });

  it('ReferenceCensus_LiveReferencedPath_IsExcludedFromDeletion', () => {
    const wrongly = deletionCandidates
      .filter(([name, s]) => s.liveReferrers > 0 && CLEARED_FOR_DELETION.includes(name))
      .map(([name]) => name);

    expect(wrongly, 'cleared for deletion while still referenced').toEqual([]);

    // The live list is empty today, so the filter above cannot fail. Seed a
    // still-referenced subtree into the cleared set and require the same
    // predicate to reject it.
    const liveReferenced = deletionCandidates.find(([, s]) => s.liveReferrers > 0);
    expect(
      liveReferenced,
      'no deletion candidate still has live referrers — the seed has nothing to reject',
    ).toBeDefined();
    const [seededName] = liveReferenced ?? [];
    expect(seededName, 'seeded cleared name is missing').toBeDefined();
    const seededCleared = [...CLEARED_FOR_DELETION, seededName as string];
    const seededWrongly = deletionCandidates
      .filter(([name, s]) => s.liveReferrers > 0 && seededCleared.includes(name))
      .map(([name]) => name);
    expect(seededWrongly).toContain(seededName);
  });

  it('ReferenceCensus_BlockedSubtree_NamesItsCodeReferrers', () => {
    // A blocked subtree with no sample referrer is an unactionable finding:
    // whoever unblocks it needs somewhere to start.
    for (const [name, subtree] of deletionCandidates) {
      if (subtree.referrersByKind.code === 0) continue;
      expect(subtree.sampleLiveCodeReferrers.length, `${name} reports code referrers but names none`).toBeGreaterThan(0);
    }
  });

  it('ReferenceCensus_Scan_CoveredMarkdownSnapshotsAndNamedFiles', () => {
    // The three classes that produce a false zero when missed. Each must have
    // been reached somewhere in the corpus, or the census is measuring less
    // than it claims.
    const totals = deletionCandidates.reduce(
      (acc, [, s]) => ({
        markdown: acc.markdown + s.referrersByKind.markdownLive + s.referrersByKind.markdownArchival,
        snapshot: acc.snapshot + s.referrersByKind.snapshot,
      }),
      { markdown: 0, snapshot: 0 },
    );

    expect(totals.markdown, 'no markdown referrer found anywhere').toBeGreaterThan(0);
    expect(totals.snapshot, 'no snapshot referrer found — the .snap glob is not reaching').toBeGreaterThan(0);
    expect(census.namedFilesIncluded).toContain('.github/CODEOWNERS');
  });

  it('ReferenceCensus_ArchivalMentions_AreStillToldApartFromLiveOnes', () => {
    // The classifier still has to discriminate, because the inverted question
    // depends on it: a retained subtree referenced only by dated records is not
    // load-bearing, it is being remembered.
    //
    // This used to pin `docs/audits` — archival mentions, zero live referrers,
    // therefore safe to delete. That subtree has since LEFT, and asserting on a
    // departed directory is how a check starts measuring nothing. Worse, its
    // referrer count is now noise: the comment in `prose-exodus.test.ts`
    // explaining the trailing-slash ignore bug NAMES it, so it reads as a live
    // code referrer of a directory that no longer exists. Exactly the
    // citation-counted-as-dependency confusion that made the old gate wrong.
    //
    // So the claim is stated over the whole census instead of one subtree.
    const kinds = Object.values(census.subtrees).map((s) => s.referrersByKind);
    expect(kinds.length, 'the census reports no subtree').toBeGreaterThan(0);

    const archival = kinds.reduce((n, k) => n + k.markdownArchival, 0);
    const live = kinds.reduce((n, k) => n + k.markdownLive, 0);

    // Both classes must be non-empty, or the split is not discriminating — a
    // classifier that puts everything in one bucket satisfies any check that
    // only looks at the other.
    expect(archival, 'no archival markdown mentions found — the split is not discriminating').toBeGreaterThan(0);
    expect(live, 'no live markdown referrers found — the split is not discriminating').toBeGreaterThan(0);
  });

  it('ReferenceCensus_ScanSurface_IsMostOfTheTree', () => {
    // A census that quietly read a fraction of the repository would report
    // fewer referrers than exist, which is the failure that permits deletion.
    expect(census.scannedFiles / census.trackedFiles).toBeGreaterThan(0.8);
  });

  it('ReferenceCensus_ReHomedSubtrees_AreMeasuredButNotGated', () => {
    // They move rather than disappear, so references are retargeted rather
    // than removed — but they still have to be counted before the move.
    //
    // A subtree that has ALREADY moved holds nothing, and asserting it still
    // holds files would fail for having succeeded. `docs/evals` is the live
    // case: its graders and datasets went to `tests/evals/` with the test-tree
    // consolidation, so the directory is gone while the census row remains.
    const rehomed = Object.entries(census.subtrees).filter(([, s]) => s.disposition === 're-home');
    expect(rehomed.length).toBeGreaterThan(0);

    const pending = rehomed.filter(([name]) => !RE_HOMED_ALREADY.includes(name));
    // Denominator: if every row were marked done, this check would assert
    // nothing and could not notice a subtree emptying by accident.
    expect(pending.length, 're-home rows exist but all are marked done').toBeGreaterThan(0);

    for (const [name, subtree] of pending) {
      expect(subtree.ownFiles, `${name} is scheduled to move but holds no files`).toBeGreaterThan(0);
    }

    for (const name of RE_HOMED_ALREADY) {
      expect(
        census.subtrees[name]?.ownFiles,
        `${name} is recorded as re-homed but still holds files`,
      ).toBe(0);
    }
  });
});
