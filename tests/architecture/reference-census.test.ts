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
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

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

const census = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/reference-census.json'), 'utf8'),
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

  it('ReferenceCensus_TheScanStillCoversPopulatedSubtrees', () => {
    // Denominator. Once four subtrees hold nothing, a census that had lost its
    // ability to see files at all would report every remaining subtree as empty
    // and every check above would pass by having no input.
    const populated = deletionCandidates.filter(([, s]) => s.ownFiles > 0);
    expect(populated.length, 'the census sees no populated subtree').toBeGreaterThan(5);
  });

  it('ReferenceCensus_LiveReferencedPath_IsExcludedFromDeletion', () => {
    const wrongly = deletionCandidates
      .filter(([name, s]) => s.liveReferrers > 0 && CLEARED_FOR_DELETION.includes(name))
      .map(([name]) => name);

    expect(wrongly, 'cleared for deletion while still referenced').toEqual([]);
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

  it('ReferenceCensus_ArchivalMarkdown_DoesNotBlockDeletion', () => {
    // The distinction that makes the gate usable: docs/audits carries archival
    // mentions and is still clear, because a dated record is out of scope.
    const audits = census.subtrees['docs/audits'];
    if (!audits) throw new Error('docs/audits is absent from the census');

    expect(audits.referrersByKind.markdownArchival).toBeGreaterThan(0);
    expect(audits.liveReferrers).toBe(0);
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
