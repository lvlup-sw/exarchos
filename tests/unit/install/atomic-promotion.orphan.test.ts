/**
 * atomic-promotion.orphan.test.ts — DR-17: a backup is never destroyed without a
 * consumable journal.
 *
 * The fatal state is narrow and entirely mechanical:
 *
 *     target ABSENT   +   backup = the OLD tree   +   journal gone or garbage
 *
 * It is what a process kill between `rename(target → backup)` and
 * `rename(staging → target)` leaves behind once the journal that recorded those
 * two paths is lost (deleted by a cleanup script, truncated by a crash, or
 * written by a version that spelled it differently). The backup directory is
 * then the ONLY copy of the old tree in existence, and `promoteTreeSync` used to
 * open with an unconditional `safeRemove(plan.backupDir)` — deleting it, on the
 * strength of a comment that inferred "recovery already consumed any
 * journal-tracked backup", an inference that only holds when a journal was
 * actually found.
 *
 * These proofs run the REAL {@link promoteTreeSync} against a REAL temp
 * filesystem and construct the crash state the way the crash does — by faulting
 * both the commit rename and the rollback restore through the injectable
 * {@link PromotionIo} seam, then removing/corrupting the journal — rather than
 * by hand-placing directories. What is asserted is the surviving bytes: the
 * backup tree's content digest, byte-for-byte, before and after.
 *
 * The other half of the job is proving the refusal is NARROW. A guard that
 * refuses too eagerly would brick every install, so the legitimate states are
 * pinned explicitly: a clean first install, a normal replace-the-old-tree
 * promotion (including its own post-commit backup cleanup), a promotion that
 * finds a stale backup next to a PRESENT target, and a promotion that finds a
 * genuinely consumable journal.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir, rmrf } from '../../../tools/test-helpers/temp-dir.js';
import { digestTree, type DigestEntry } from '../../../src/install/install-identity.js';
import { LIVE, isError } from '../../../src/dispatch/core/effect-carrier.js';
import {
  PromotionError,
  assertNoOrphanBackup,
  defaultPromotionIo,
  promoteTree,
  promoteTreeSync,
  recoverInterruptedPromotion,
  type PromotionIo,
} from '../../../src/install/atomic-promotion.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const OLD_TREE: DigestEntry[] = [
  { path: 'a.md', content: 'OLD alpha\n' },
  { path: 'nested/b.md', content: 'OLD beta\n' },
  { path: 'nested/deep/c.md', content: 'OLD gamma\n' },
];

const NEW_TREE: DigestEntry[] = [
  { path: 'a.md', content: 'NEW alpha (rewritten)\n' },
  { path: 'nested/b.md', content: 'NEW beta (rewritten)\n' },
  { path: 'd.md', content: 'NEW delta (added)\n' },
];

const OLD_DIGEST = digestTree(OLD_TREE);
const NEW_DIGEST = digestTree(NEW_TREE);

let root: string;
let target: string;

beforeEach(() => {
  root = makeTempDir('exarchos-orphan-');
  target = path.join(root, 'skills');
});

afterEach(() => {
  rmrf(root);
});

const stageDir = (): string => path.join(root, '.skills.exarchos-stage');
const backupDir = (): string => path.join(root, '.skills.exarchos-backup');
const journalFile = (): string => path.join(root, '.skills.exarchos-promote.json');

/** Materialize a tree on disk under `dir`. */
function writeTree(dir: string, entries: readonly DigestEntry[]): void {
  for (const entry of entries) {
    const full = path.join(dir, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, entry.content, 'utf8');
  }
}

/** Read a tree off disk into content entries (recursive). */
function readTree(dir: string): DigestEntry[] {
  if (!fs.existsSync(dir)) return [];
  const out: DigestEntry[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const dirent of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      if (dirent.isDirectory()) walk(path.join(d, dirent.name), rel);
      else if (dirent.isFile()) out.push({ path: rel, content: fs.readFileSync(path.join(d, dirent.name), 'utf8') });
    }
  };
  walk(dir, '');
  return out;
}

/** Digest of the tree currently on disk at `dir` (`sha256:…` or `<absent>`). */
function diskDigest(dir: string): string {
  return fs.existsSync(dir) ? digestTree(readTree(dir)) : '<absent>';
}

/** Wrap a base IO so `hook` runs BEFORE each delegated operation. */
function wrapIo(
  base: PromotionIo,
  hook: (op: keyof PromotionIo, first: string, second?: string) => void,
): PromotionIo {
  return {
    mkdirp: (d) => { hook('mkdirp', d); base.mkdirp(d); },
    writeFile: (f, data) => { hook('writeFile', f); base.writeFile(f, data); },
    readFile: (f) => { hook('readFile', f); return base.readFile(f); },
    listTree: (d) => { hook('listTree', d); return base.listTree(d); },
    exists: (t) => { hook('exists', t); return base.exists(t); },
    rename: (from, to) => { hook('rename', from, to); base.rename(from, to); },
    removeTree: (t) => { hook('removeTree', t); base.removeTree(t); },
  };
}

class InjectedFault extends Error {}

/**
 * Drive the REAL promotion into the post-crash state a SIGKILL between the two
 * renames leaves: `target` absent, `backup` holding the complete OLD tree, and
 * the journal on disk. Faults both the commit rename and the in-line rollback
 * restore, which is exactly the "hard crash" the module documents.
 *
 * Returns with the journal STILL PRESENT — each test then decides how the
 * journal is lost (deleted / truncated / wrong shape), because that is the axis
 * DR-17 is about.
 */
function crashBetweenRenames(): void {
  writeTree(target, OLD_TREE);
  const io = wrapIo(defaultPromotionIo(), (op, from) => {
    if (op === 'rename' && from.includes('.exarchos-stage')) throw new InjectedFault('commit killed');
    if (op === 'rename' && from.includes('.exarchos-backup')) throw new InjectedFault('rollback killed');
  });

  expect(() => promoteTreeSync({ target, entries: NEW_TREE }, io)).toThrow(PromotionError);

  // Precondition of every DR-17 proof below: this is the state on disk.
  expect(fs.existsSync(target)).toBe(false);
  expect(diskDigest(backupDir())).toBe(OLD_DIGEST);
  expect(fs.existsSync(journalFile())).toBe(true);
}

/** Capture a thrown value without `expect(...).toThrow`'s type erasure. */
function caught(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (err) {
    return err;
  }
}

// ─── DR-17: the orphan backup is preserved, not discarded ────────────────────

describe('DR-17 — an orphan backup is refused, never destroyed', () => {
  it('PromoteTree_OrphanBackupNoJournal_PreservesBackup', () => {
    crashBetweenRenames();
    // The journal — the only record of where the old tree went — is lost.
    fs.rmSync(journalFile());
    const survivingBefore = readTree(backupDir());
    expect(digestTree(survivingBefore)).toBe(OLD_DIGEST);

    const err = caught(() => promoteTreeSync({ target, entries: NEW_TREE }));

    // The point of the whole exercise, asserted FIRST: the last copy of OLD is
    // still there, byte-for-byte — not merely "a directory still exists".
    expect(diskDigest(backupDir())).toBe(OLD_DIGEST);
    expect(fs.existsSync(backupDir())).toBe(true);
    expect(readTree(backupDir())).toEqual(survivingBefore);

    // Refused, with a typed identity and an actionable message that NAMES the
    // orphan (an operator has to be able to find the bytes we would not touch).
    expect(err).toBeInstanceOf(PromotionError);
    expect((err as PromotionError).code).toBe('ORPHAN_BACKUP');
    expect((err as PromotionError).message).toContain(backupDir());
    expect((err as PromotionError).message).toContain(target);
    expect((err as PromotionError).message).toContain(journalFile());
    expect((err as PromotionError).message).toContain('ABSENT');
  });

  it('PromoteTree_OrphanBackupNoJournal_DoesNotStageOverOldTree', () => {
    crashBetweenRenames();
    fs.rmSync(journalFile());
    // The crashed attempt's staging dir is still on disk. A refusal must leave it
    // exactly as it found it — no re-stage, and above all no promotion of it.
    const stagedBefore = diskDigest(stageDir());
    expect(stagedBefore).toBe(NEW_DIGEST);

    // Record every filesystem MUTATION the refused call performs. "Refuses
    // rather than overwriting destructively" is a claim about what did not
    // happen, so observe the seam, not just the wreckage afterwards.
    const mutations: string[] = [];
    const io = wrapIo(defaultPromotionIo(), (op, first, second) => {
      if (op === 'mkdirp' || op === 'writeFile' || op === 'removeTree' || op === 'rename') {
        mutations.push(`${op} ${first}${second === undefined ? '' : ` -> ${second}`}`);
      }
    });

    const err = caught(() => promoteTreeSync({ target, entries: NEW_TREE }, io));

    // Not one mutating operation: no `removeTree` of the backup, no staging
    // write, no `target → backup` rename, no commit.
    expect(mutations).toEqual([]);

    // Refusal is a REFUSAL, not a half-promotion: nothing re-staged, no journal
    // rewritten over the evidence, and the destination still absent — so no
    // commit could have clobbered the old tree.
    expect(diskDigest(stageDir())).toBe(stagedBefore);
    expect(fs.existsSync(journalFile())).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
    expect(diskDigest(target)).toBe('<absent>');

    expect(err).toBeInstanceOf(PromotionError);
    expect((err as PromotionError).code).toBe('ORPHAN_BACKUP');

    // And the old tree was not partially overwritten in place: every OLD file is
    // intact with OLD bytes, and no NEW-only file leaked into it.
    for (const entry of OLD_TREE) {
      const full = path.join(backupDir(), ...entry.path.split('/'));
      expect(fs.readFileSync(full, 'utf8')).toBe(entry.content);
    }
    expect(fs.existsSync(path.join(backupDir(), 'd.md'))).toBe(false);
    expect(diskDigest(backupDir())).not.toBe(NEW_DIGEST);
  });

  it('PromoteTree_OrphanBackupCorruptJournal_PreservesBackupAndReportsUnreadable', () => {
    crashBetweenRenames();
    // Not deleted — TRUNCATED. `readJournal` used to fold this into the same
    // `undefined` as "absent", which is why the corrupt case was invisible.
    fs.writeFileSync(journalFile(), '{"target":"C:\\\\part', 'utf8');

    const err = caught(() => promoteTreeSync({ target, entries: NEW_TREE }));

    expect(diskDigest(backupDir())).toBe(OLD_DIGEST);
    expect(err).toBeInstanceOf(PromotionError);
    expect((err as PromotionError).code).toBe('ORPHAN_BACKUP');
    expect((err as PromotionError).message).toContain(backupDir());
    // The diagnosis distinguishes a corrupt journal from a missing one.
    expect((err as PromotionError).message).toContain('UNREADABLE');
    expect((err as PromotionError).message).not.toContain('is ABSENT');

    // The corrupt journal is EVIDENCE — a refusal must not overwrite it with a
    // fresh one, which is precisely what proceeding to promote would do.
    expect(fs.readFileSync(journalFile(), 'utf8')).toBe('{"target":"C:\\\\part');
  });

  it('PromoteTree_OrphanBackupWrongShapeJournal_PreservesBackupAndReportsUnreadable', () => {
    crashBetweenRenames();
    // Parses fine; is not a promotion journal. `isPromotionJournal` rejects it,
    // and that rejection must reach the operator as "unreadable", not "absent".
    fs.writeFileSync(journalFile(), JSON.stringify({ version: 2, note: 'not a journal' }), 'utf8');

    const err = caught(() => promoteTreeSync({ target, entries: NEW_TREE }));

    expect(diskDigest(backupDir())).toBe(OLD_DIGEST);
    expect(err).toBeInstanceOf(PromotionError);
    expect((err as PromotionError).code).toBe('ORPHAN_BACKUP');
    expect((err as PromotionError).message).toContain('UNREADABLE');
    expect((err as PromotionError).message).not.toContain('is ABSENT');
  });

  it('RecoverInterruptedPromotion_UnreadableJournal_ReportsNothingRecoveredAndKeepsBackup', () => {
    crashBetweenRenames();
    fs.writeFileSync(journalFile(), 'not json at all', 'utf8');

    // Standalone recovery cannot consume an unreadable journal — and does not
    // pretend to, nor "clean up" the backup it cannot account for.
    expect(recoverInterruptedPromotion(target)).toBe(false);
    expect(diskDigest(backupDir())).toBe(OLD_DIGEST);
    expect(fs.existsSync(journalFile())).toBe(true);
  });

  it('PromoteTree_OrphanBackup_SurfacesRefusalThroughTheEffectCarrier', async () => {
    crashBetweenRenames();
    fs.rmSync(journalFile());

    // The carrier is the seam callers (onboard install) use: a refusal has to
    // arrive as a structured error outcome, not an unhandled throw.
    const outcome = await promoteTree({ target, entries: NEW_TREE }, LIVE);

    expect(isError(outcome)).toBe(true);
    if (isError(outcome)) {
      expect(outcome.error.code).toBe('INSTALL_EFFECT_FAILED');
      expect(outcome.error.message).toContain(backupDir());
      // The typed refusal survives as the carrier's `cause`, so a caller can
      // still tell ORPHAN_BACKUP from any other install failure.
      expect(outcome.error.cause).toBeInstanceOf(PromotionError);
      expect((outcome.error.cause as PromotionError).code).toBe('ORPHAN_BACKUP');
    }
    expect(diskDigest(backupDir())).toBe(OLD_DIGEST);
  });

  it('PromoteTree_OrphanBackupRestoredByOperator_ConvergesOnRetry', () => {
    crashBetweenRenames();
    fs.rmSync(journalFile());
    expect(() => promoteTreeSync({ target, entries: NEW_TREE })).toThrow(PromotionError);

    // The refusal is not a dead end: it tells the operator to restore the orphan,
    // and doing exactly that makes the very next run converge to NEW.
    fs.renameSync(backupDir(), target);
    expect(diskDigest(target)).toBe(OLD_DIGEST);

    const report = promoteTreeSync({ target, entries: NEW_TREE });

    expect(report.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(fs.existsSync(backupDir())).toBe(false);
    expect(fs.existsSync(journalFile())).toBe(false);
  });
});

// ─── The refusal must be NARROW: legitimate promotions are untouched ─────────

describe('DR-17 — the refusal does not fire on any legitimate promotion', () => {
  it('PromoteTree_CleanFirstInstall_PromotesNormally', () => {
    // No target, no backup, no journal — the state every fresh install is in.
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(backupDir())).toBe(false);
    expect(fs.existsSync(journalFile())).toBe(false);

    const report = promoteTreeSync({ target, entries: NEW_TREE });

    expect(report.promoted).toBe(true);
    expect(report.recoveredPriorAttempt).toBe(false);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(fs.existsSync(backupDir())).toBe(false);
    expect(fs.existsSync(stageDir())).toBe(false);
    expect(fs.existsSync(journalFile())).toBe(false);
  });

  it('PromoteTree_ExistingTargetNoJournal_PromotesAndCleansItsOwnBackup', () => {
    writeTree(target, OLD_TREE);
    expect(diskDigest(target)).toBe(OLD_DIGEST);

    const report = promoteTreeSync({ target, entries: NEW_TREE });

    expect(report.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    // The backup this promotion made for itself is still cleaned up afterwards —
    // the guard did not turn normal scaffolding into a permanent orphan.
    expect(fs.existsSync(backupDir())).toBe(false);
    expect(fs.existsSync(stageDir())).toBe(false);
    expect(fs.existsSync(journalFile())).toBe(false);
  });

  it('PromoteTree_StaleBackupBesidePresentTarget_StillPromotesAndDiscardsIt', () => {
    // Post-commit cleanup interrupted: the destination is a COMPLETE tree and the
    // backup is a redundant second copy. Discarding it loses nothing, so the
    // guard must NOT fire here — this is the common leftover in the wild.
    writeTree(target, OLD_TREE);
    writeTree(backupDir(), OLD_TREE);
    expect(fs.existsSync(journalFile())).toBe(false);

    const report = promoteTreeSync({ target, entries: NEW_TREE });

    expect(report.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(fs.existsSync(backupDir())).toBe(false);
  });

  it('PromoteTree_StaleBackupBesidePresentTargetCorruptJournal_StillPromotes', () => {
    // Same as above but the leftover journal is garbage. An unreadable journal is
    // only fatal when the backup is the LAST copy; with the target present it is
    // not, so the promotion proceeds rather than refusing.
    writeTree(target, OLD_TREE);
    writeTree(backupDir(), OLD_TREE);
    fs.writeFileSync(journalFile(), '<<<corrupt>>>', 'utf8');

    const report = promoteTreeSync({ target, entries: NEW_TREE });

    expect(report.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(fs.existsSync(backupDir())).toBe(false);
    expect(fs.existsSync(journalFile())).toBe(false);
  });

  it('PromoteTree_ConsumableJournalAfterCrash_RecoversAndPromotesAsBefore', () => {
    crashBetweenRenames();
    // Journal left intact: recovery restores OLD from the backup, then the
    // promotion proceeds. Nothing about DR-17 may perturb this path.
    const report = promoteTreeSync({ target, entries: NEW_TREE });

    expect(report.recoveredPriorAttempt).toBe(true);
    expect(report.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(fs.existsSync(backupDir())).toBe(false);
    expect(fs.existsSync(stageDir())).toBe(false);
    expect(fs.existsSync(journalFile())).toBe(false);
  });

  it('PromoteTree_RepeatedPromotionsOfTheSameTree_NeverRefuse', () => {
    // Convergence loop: the guard runs on every call, so a spurious refusal
    // would surface as a throw on the 2nd or 3rd identical promotion.
    promoteTreeSync({ target, entries: OLD_TREE });
    promoteTreeSync({ target, entries: NEW_TREE });
    const third = promoteTreeSync({ target, entries: NEW_TREE });

    expect(third.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(fs.existsSync(backupDir())).toBe(false);
  });
});

// ─── The guard's own contract, pinned directly ───────────────────────────────

describe('assertNoOrphanBackup — the guard in isolation', () => {
  it('AssertNoOrphanBackup_TargetAbsentBackupPresent_ThrowsOrphanBackup', () => {
    writeTree(backupDir(), OLD_TREE);

    const err = caught(() => { assertNoOrphanBackup(target); });

    expect(err).toBeInstanceOf(PromotionError);
    expect((err as PromotionError).code).toBe('ORPHAN_BACKUP');
    expect((err as PromotionError).name).toBe('PromotionError');
    expect((err as PromotionError).message).toContain(backupDir());
  });

  it('AssertNoOrphanBackup_TargetPresent_Passes', () => {
    writeTree(target, OLD_TREE);
    writeTree(backupDir(), OLD_TREE);

    expect(() => { assertNoOrphanBackup(target); }).not.toThrow();
  });

  it('AssertNoOrphanBackup_NoBackup_Passes', () => {
    expect(() => { assertNoOrphanBackup(target); }).not.toThrow();

    writeTree(target, OLD_TREE);
    expect(() => { assertNoOrphanBackup(target); }).not.toThrow();
  });

  it('AssertNoOrphanBackup_UnconsumedValidJournal_ReportsItAsUnconsumed', () => {
    // A valid journal that recovery somehow left behind while the target is still
    // absent: still an orphan, and the diagnosis says so rather than claiming the
    // journal is missing.
    writeTree(backupDir(), OLD_TREE);
    fs.writeFileSync(
      journalFile(),
      JSON.stringify({
        target,
        stagingDir: stageDir(),
        backupDir: backupDir(),
        journalPath: journalFile(),
      }),
      'utf8',
    );

    const err = caught(() => { assertNoOrphanBackup(target); });

    expect(err).toBeInstanceOf(PromotionError);
    expect((err as PromotionError).code).toBe('ORPHAN_BACKUP');
    expect((err as PromotionError).message).toContain('UNCONSUMED');
    expect(diskDigest(backupDir())).toBe(OLD_DIGEST);
  });
});
