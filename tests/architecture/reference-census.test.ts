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
 * The only subtrees measured free of live references today. This is a ratchet:
 * as references are cleaned up the set grows and this list must grow with it,
 * so nothing is deleted on the strength of a stale measurement.
 */
const CLEARED_FOR_DELETION = ['docs/audits', 'docs/bugs', 'docs/market', 'docs/refactors'];

describe('reference census', () => {
  it('ReferenceCensus_EveryDeletionCandidate_HasZeroLiveReferences', () => {
    // Equality against the cleared list rather than a blanket zero assertion:
    // 12 of 16 subtrees are still referenced, and pretending otherwise is what
    // the census exists to prevent.
    const cleared = deletionCandidates
      .filter(([, s]) => s.liveReferrers === 0)
      .map(([name]) => name)
      .sort();

    expect(cleared).toEqual([...CLEARED_FOR_DELETION].sort());
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
    const rehomed = Object.entries(census.subtrees).filter(([, s]) => s.disposition === 're-home');

    expect(rehomed.length).toBeGreaterThan(0);
    for (const [name, subtree] of rehomed) {
      expect(subtree.ownFiles, `${name} is scheduled to move but holds no files`).toBeGreaterThan(0);
    }
  });
});
