/**
 * The worktree and branch inventory is a record, not a list of things to remove.
 *
 * Pruning is withdrawn, because one worktree held the only copy of an unlanded
 * implementation. These assertions keep the artifact a census, so a later reader does not
 * use it as a prune list.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { execFileAsync } from '../../tools/test-helpers/spawn.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

type Inventory = {
  capturedIn: string;
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

async function liveWorktreeCount(): Promise<number> {
  return (
    await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: REPO_ROOT,
    })
  )
    .split('\n')
    .filter((line) => line.startsWith('worktree ')).length;
}

const worktreesAtCollection = await liveWorktreeCount();

describe('worktree inventory', () => {
  /**
   * The committed inventory is a snapshot of a machine with many worktrees. A CI checkout has
   * one worktree, so this test skips there. A partial inventory is a hazard, because an
   * omitted worktree looks like one that does not exist.
   */
  it.skipIf(worktreesAtCollection <= 1)('WorktreeInventory_EveryRegisteredWorktree_IsRecorded', async () => {
    const registered = await liveWorktreeCount();

    expect(inventory.worktrees.records).toHaveLength(inventory.worktrees.total);
    expect(inventory.worktrees.total).toBe(registered);
  });

  /** The inventory must not get a destructive mode later. */
  it('WorktreeInventory_Disposition_IsInventoryOnly', () => {
    expect(inventory.disposition).toBe('inventory-only');
    expect(inventory.dispositionRationale).toMatch(/unlanded|reversible/i);
  });

  /** Without the caveat, the ahead count reads as worktrees with unique work, which justifies a prune. */
  it('WorktreeInventory_AheadCount_CarriesTheSquashMergeCaveat', () => {
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

  /**
   * The session that captures the inventory is one of the entries, so a prune from that
   * session removes its own worktree. The expected path comes from `capturedIn` in the
   * artifact, because a pinned branch name goes stale when its worktree goes.
   */
  it('WorktreeInventory_ThisSessionsWorktree_IsAmongTheRecords', () => {
    const paths = inventory.worktrees.records.map((r) => r.path);

    expect(inventory.capturedIn.length).toBeGreaterThan(0);
    expect(paths).toContain(inventory.capturedIn);
  });
});
