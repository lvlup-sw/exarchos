/**
 * The worktree and branch inventory — a record, not a removal warrant.
 *
 * Pruning is withdrawn. 66 of 67 worktrees carry commits absent from the base
 * branch, and one held the only copy of an unlanded implementation that was
 * found by accident. These assertions exist to keep the artifact honest about
 * what it is, so a later reader does not mistake a census for a hit list.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

type Inventory = {
  disposition: string;
  dispositionRationale: string;
  worktrees: {
    total: number;
    carryingUniqueWork: number;
    missingDirectory: number;
    countingCaveat: string;
    records: { path: string; branch: string | null; commitsNotOnBase: string }[];
  };
  branches: { total: number; mergedIntoBase: number; unmerged: number };
};

const inventory = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/worktree-inventory.json'), 'utf8'),
) as Inventory;

function liveWorktreeCount(): number {
  return execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((line) => line.startsWith('worktree ')).length;
}

describe('worktree inventory', () => {
  // The committed inventory is a snapshot of the author's multi-worktree
  // machine. A CI checkout (and this cloud agent) has one worktree, so the
  // live-count assertion is skipped there. Internal consistency still runs.
  it.skipIf(liveWorktreeCount() <= 1)('WorktreeInventory_EveryRegisteredWorktree_IsRecorded', () => {
    // A partial inventory is the dangerous kind: whatever it omits looks like
    // it does not exist.
    const registered = liveWorktreeCount();

    expect(inventory.worktrees.records).toHaveLength(inventory.worktrees.total);
    expect(inventory.worktrees.total).toBe(registered);
  });

  it('WorktreeInventory_Disposition_IsInventoryOnly', () => {
    // The instrument must not quietly acquire a destructive mode later.
    expect(inventory.disposition).toBe('inventory-only');
    expect(inventory.dispositionRationale).toMatch(/unlanded|reversible/i);
  });

  it('WorktreeInventory_AheadCount_CarriesTheSquashMergeCaveat', () => {
    // Without this the count reads as "66 worktrees hold unique work", which
    // would justify exactly the deletion this task refuses to perform.
    expect(inventory.worktrees.countingCaveat).toMatch(/squash/i);
    expect(inventory.worktrees.countingCaveat).toMatch(/overstate/i);
  });

  it('WorktreeInventory_EveryRecord_NamesItsBranchAndDivergence', () => {
    for (const record of inventory.worktrees.records) {
      expect(record.path.length).toBeGreaterThan(0);
      expect(record.commitsNotOnBase, `${record.path} has no divergence recorded`).toBeDefined();
    }
  });

  it('WorktreeInventory_BranchCounts_AreInternallyConsistent', () => {
    const { total, mergedIntoBase, unmerged } = inventory.branches;

    expect(mergedIntoBase + unmerged).toBe(total);
  });

  it('WorktreeInventory_ThisSessionsWorktree_IsAmongTheRecords', () => {
    // The session doing the inventorying is itself one of the entries. That is
    // the concrete reason a prune here is self-destructive, and pinning it
    // keeps the point from being lost.
    const branches = inventory.worktrees.records.map((r) => r.branch);

    expect(branches).toContain('worktree-exarchos-overhaul-staging');
  });
});
