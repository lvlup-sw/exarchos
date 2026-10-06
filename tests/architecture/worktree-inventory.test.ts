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

/**
 * Describes the defect of an inventory whose record count differs from its total.
 * Returns nothing for a consistent inventory.
 */
function recordCountDefect(candidate: Inventory): string | undefined {
  const { records, total } = candidate.worktrees;

  return records.length === total
    ? undefined
    : `the inventory holds ${records.length} records but its total is ${total}`;
}

describe('worktree inventory', () => {
  /** A partial inventory is a hazard, because an omitted worktree looks like one that does not exist. */
  it('WorktreeInventory_RecordCount_EqualsItsTotal', () => {
    expect(recordCountDefect(inventory)).toBeUndefined();
  });

  /** The seeded copy is one record short, which proves that the record count check can fail. */
  it('WorktreeInventory_SeededShortInventory_IsRejected', () => {
    const short = {
      ...inventory,
      worktrees: { ...inventory.worktrees, records: inventory.worktrees.records.slice(1) },
    } satisfies Inventory;

    expect(recordCountDefect(short)).toBeDefined();
  });

  /**
   * The committed inventory is a dated snapshot of one machine, and each new worktree changes
   * the live count. Thus the comparison runs only when `EXARCHOS_WORKTREE_AUDIT` is set.
   */
  it.skipIf(!process.env.EXARCHOS_WORKTREE_AUDIT)(
    'WorktreeInventory_LiveAudit_ComparesTheSnapshotWithTheMachineWhenAsked',
    async () => {
      const registered = await liveWorktreeCount();

      expect(
        inventory.worktrees.total,
        `the snapshot records ${inventory.worktrees.total} worktrees but this machine registers ${registered}`,
      ).toBe(registered);
    },
  );

  /**
   * The live comparison runs only when a caller sets the variable, and the `audit:worktrees` script is that caller.
   * The script must set the variable and name this file. Without the script, the comparison never runs.
   */
  it('WorktreeInventory_TheLiveAudit_HasAPackageScriptThatSetsItsVariableAndNamesThisFile', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const thisFile = path.relative(REPO_ROOT, import.meta.filename).split(path.sep).join('/');
    const callers = Object.entries(manifest.scripts)
      .filter(([, command]) => command.includes('EXARCHOS_WORKTREE_AUDIT') && command.includes(thisFile))
      .map(([name]) => name);

    expect(thisFile).toBe('tests/architecture/worktree-inventory.test.ts');
    expect(callers).toEqual(['audit:worktrees']);
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
