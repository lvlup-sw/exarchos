/**
 * Asserts that each subtree that stays under `docs/` has a live reference.
 *
 * A referrer is live when a reader or a tool follows it: source, config,
 * snapshots, and instruction markdown outside `docs/`. A dated record under
 * `docs/` that mentions a path is history. The census reads file text, so a
 * subtree path in a comment of a scanned file also counts as a referrer.
 *
 * A `RETAINED` list governs the prose exodus, and `prose-exodus.test.ts`
 * enforces it. The census answers the question that the list cannot answer
 * about itself: does something reference each retained subtree? A retained
 * subtree that nothing references must leave.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { execFileAsync } from '../../tools/test-helpers/spawn.js';

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
 * The committed capture. It is a drift snapshot and not the oracle. Each
 * assertion below reads the live measurer, so a referrer that appears after a
 * capture still fails this suite.
 */
const snapshot = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/reference-census.json'), 'utf8'),
) as Census;

const census = JSON.parse(
  await execFileAsync(process.execPath, [path.join(REPO_ROOT, 'tools/audit/measure-reference-census.mjs')], {
    cwd: REPO_ROOT,
  }),
) as Census;

const deletionCandidates = Object.entries(census.subtrees).filter(
  ([, s]) => s.disposition === 'delete',
);

/**
 * The subtrees that left for the external documents repository. Each one is in
 * the census with zero files of its own, because its directory is a mount point.
 *
 * They are apart from the cleared set because a referrer count cannot tell an
 * empty subtree from a clean one. One cleared list reports an empty subtree
 * with no live referrer as ready to delete forever. Only the file count
 * separates the two.
 */
const RELOCATED = ['docs/audits', 'docs/bugs', 'docs/market', 'docs/refactors'];

/**
 * The re-homed subtrees whose move is complete. Their content went to another
 * place in this repository, so the census row outlives an empty directory. As
 * with {@link RELOCATED}, a row with no files is a complete move and not a
 * broken measurement.
 */
const RE_HOMED_ALREADY = ['docs/evals', 'docs/schemas', 'docs/assets', 'docs/architecture'];

/**
 * The subtrees with no live reference that still hold files: the set that can
 * move next. It is a ratchet. A person must update it when a subtree becomes
 * clear, so nothing leaves because of a stale measurement. It is empty today,
 * because each subtree that still holds files has live referrers.
 */
const CLEARED_FOR_DELETION: readonly string[] = [];

describe('reference census', () => {
  /** The tolerance of 50 files covers ordinary edits, and a structural move exceeds it. */
  it('ReferenceCensus_Snapshot_IsCurrentWithTheTree', () => {
    expect(Math.abs(census.trackedFiles - snapshot.trackedFiles)).toBeLessThan(50);
    expect(Object.keys(census.subtrees).sort()).toEqual(Object.keys(snapshot.subtrees).sort());
  });

  /**
   * The assertion is equality with the cleared list and not a zero count for
   * each subtree, because most subtrees still have referrers. The filter drops
   * a subtree with no files, so the set means clear and still present.
   */
  it('ReferenceCensus_EveryDeletionCandidate_HasZeroLiveReferences', () => {
    const cleared = deletionCandidates
      .filter(([, s]) => s.liveReferrers === 0 && s.ownFiles > 0)
      .map(([name]) => name)
      .sort();

    expect(cleared).toEqual([...CLEARED_FOR_DELETION].sort());
  });

  /**
   * A relocated subtree must hold no files and must not be in the cleared list.
   * Otherwise an empty directory stays ready to delete forever.
   */
  it('ReferenceCensus_RelocatedSubtree_HoldsNoFilesAndIsNotReCleared', () => {
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

  /**
   * A retained subtree that nothing references must leave. The denominator is
   * the subtree table and not the set that still holds files. Thus a scanner
   * that returns no rows fails here.
   */
  it('ReferenceCensus_EveryRetainedSubtree_IsActuallyReferenced', () => {
    expect(Object.keys(census.subtrees).length, 'the census reports no subtree').toBeGreaterThan(10);

    const retainedAndPopulated = Object.entries(census.subtrees).filter(
      ([, s]) => s.ownFiles > 0,
    );
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

  /**
   * `CLEARED_FOR_DELETION` is empty today, so the first filter cannot fail. The
   * test seeds a referenced subtree into a copy of the list, and the same
   * filter expression must report it.
   */
  it('ReferenceCensus_LiveReferencedPath_IsExcludedFromDeletion', () => {
    const wrongly = deletionCandidates
      .filter(([name, s]) => s.liveReferrers > 0 && CLEARED_FOR_DELETION.includes(name))
      .map(([name]) => name);

    expect(wrongly, 'cleared for deletion while still referenced').toEqual([]);

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

  /** A blocked subtree must name a sample referrer, so the person who unblocks it has a place to start. */
  it('ReferenceCensus_BlockedSubtree_NamesItsCodeReferrers', () => {
    for (const [name, subtree] of deletionCandidates) {
      if (subtree.referrersByKind.code === 0) continue;
      expect(subtree.sampleLiveCodeReferrers.length, `${name} reports code referrers but names none`).toBeGreaterThan(0);
    }
  });

  /**
   * A scan that misses markdown, snapshots or named files reports a false zero.
   * The census must reach each class at least one time.
   */
  it('ReferenceCensus_Scan_CoveredMarkdownSnapshotsAndNamedFiles', () => {
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

  /**
   * The classifier must separate archival mentions from live ones. A retained
   * subtree that only dated records reference is not in use. The claim covers
   * the whole census and not one subtree, because a subtree can leave. Both
   * classes must have members, or the split does not discriminate.
   */
  it('ReferenceCensus_ArchivalMentions_AreStillToldApartFromLiveOnes', () => {
    const kinds = Object.values(census.subtrees).map((s) => s.referrersByKind);
    expect(kinds.length, 'the census reports no subtree').toBeGreaterThan(0);

    const archival = kinds.reduce((n, k) => n + k.markdownArchival, 0);
    const live = kinds.reduce((n, k) => n + k.markdownLive, 0);

    expect(archival, 'no archival markdown mentions found — the split is not discriminating').toBeGreaterThan(0);
    expect(live, 'no live markdown referrers found — the split is not discriminating').toBeGreaterThan(0);
  });

  /** A census that reads only part of the repository reports too few referrers, and that permits a deletion. */
  it('ReferenceCensus_ScanSurface_IsMostOfTheTree', () => {
    expect(census.scannedFiles / census.trackedFiles).toBeGreaterThan(0.8);
  });

  /**
   * A re-homed subtree moves inside the repository, so its references change
   * target and the census still counts them. A subtree whose move is complete
   * holds no files. `docs/evals` is one: its graders and datasets are in
   * `tests/evals/`, and the census row remains.
   */
  it('ReferenceCensus_ReHomedSubtrees_AreMeasuredButNotGated', () => {
    const rehomed = Object.entries(census.subtrees).filter(([, s]) => s.disposition === 're-home');
    expect(rehomed.length).toBeGreaterThan(0);

    expect(rehomed.map(([name]) => name).sort()).toEqual([...RE_HOMED_ALREADY].sort());

    for (const [name, subtree] of rehomed) {
      expect(
        subtree.ownFiles,
        `${name} is recorded as re-homed but still holds files`,
      ).toBe(0);
    }
  });
});
