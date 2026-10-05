/**
 * Tests that a promotion never destroys a backup that has no usable journal. The fatal state
 * is: `target` absent, the backup holds the old tree, and the journal is absent or unreadable.
 * A process kill between the two renames, then a lost journal, leaves that state. The backup
 * is then the only copy of the old tree.
 *
 * The tests run the real {@link promoteTreeSync} on a real temp filesystem. They make the crash
 * state with faults through the {@link PromotionIo} seam, then remove or corrupt the journal.
 * The assertions compare the content digest of the backup tree.
 *
 * The second suite pins that the refusal is narrow, because a refusal of a legitimate state
 * blocks the install. A first install, a normal replacement, a stale backup beside a present
 * `target`, and a usable journal all promote.
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
  type PromotionExecutedRecord,
  type PromotionIo,
} from '../../../src/install/atomic-promotion.js';

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
 * Drive the real promotion into the state that a kill between the two renames leaves. In that
 * state `target` is absent, the backup holds the full old tree, and the journal is on disk.
 * It faults the commit rename and the rollback restore, then asserts that state. Each caller
 * then removes the journal, corrupts it, or keeps it.
 */
function crashBetweenRenames(): void {
  writeTree(target, OLD_TREE);
  const io = wrapIo(defaultPromotionIo(), (op, from) => {
    if (op === 'rename' && from.includes('.exarchos-stage')) throw new InjectedFault('commit killed');
    if (op === 'rename' && from.includes('.exarchos-backup')) throw new InjectedFault('rollback killed');
  });

  expect(() => promoteTreeSync({ target, entries: NEW_TREE }, io)).toThrow(PromotionError);

  expect(fs.existsSync(target)).toBe(false);
  expect(diskDigest(backupDir())).toBe(OLD_DIGEST);
  expect(fs.existsSync(journalFile())).toBe(true);
}

/** Return the value that `run` throws, or `undefined`. `expect(...).toThrow` does not give the value. */
function caught(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('DR-17 — an orphan backup is refused, never destroyed', () => {
  /**
   * The journal is the only record of where the old tree went, and it is lost. The backup must
   * keep each byte of the old tree. The error names the backup, the target and the journal
   * path, so an operator can find the tree.
   */
  it('PromoteTree_OrphanBackupNoJournal_PreservesBackup', () => {
    crashBetweenRenames();
    fs.rmSync(journalFile());
    const survivingBefore = readTree(backupDir());
    expect(digestTree(survivingBefore)).toBe(OLD_DIGEST);

    const err = caught(() => promoteTreeSync({ target, entries: NEW_TREE }));

    expect(diskDigest(backupDir())).toBe(OLD_DIGEST);
    expect(fs.existsSync(backupDir())).toBe(true);
    expect(readTree(backupDir())).toEqual(survivingBefore);

    expect(err).toBeInstanceOf(PromotionError);
    expect((err as PromotionError).code).toBe('ORPHAN_BACKUP');
    expect((err as PromotionError).message).toContain(backupDir());
    expect((err as PromotionError).message).toContain(target);
    expect((err as PromotionError).message).toContain(journalFile());
    expect((err as PromotionError).message).toContain('ABSENT');
  });

  /**
   * The staging directory of the crashed attempt is on disk, and the refusal must not change it.
   * The IO hook records each mutating call, and the refused call must make none. No journal
   * appears, `target` stays absent, and the backup holds only the old files.
   */
  it('PromoteTree_OrphanBackupNoJournal_DoesNotStageOverOldTree', () => {
    crashBetweenRenames();
    fs.rmSync(journalFile());
    const stagedBefore = diskDigest(stageDir());
    expect(stagedBefore).toBe(NEW_DIGEST);

    const mutations: string[] = [];
    const io = wrapIo(defaultPromotionIo(), (op, first, second) => {
      if (op === 'mkdirp' || op === 'writeFile' || op === 'removeTree' || op === 'rename') {
        mutations.push(`${op} ${first}${second === undefined ? '' : ` -> ${second}`}`);
      }
    });

    const err = caught(() => promoteTreeSync({ target, entries: NEW_TREE }, io));

    expect(mutations).toEqual([]);

    expect(diskDigest(stageDir())).toBe(stagedBefore);
    expect(fs.existsSync(journalFile())).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
    expect(diskDigest(target)).toBe('<absent>');

    expect(err).toBeInstanceOf(PromotionError);
    expect((err as PromotionError).code).toBe('ORPHAN_BACKUP');

    for (const entry of OLD_TREE) {
      const full = path.join(backupDir(), ...entry.path.split('/'));
      expect(fs.readFileSync(full, 'utf8')).toBe(entry.content);
    }
    expect(fs.existsSync(path.join(backupDir(), 'd.md'))).toBe(false);
    expect(diskDigest(backupDir())).not.toBe(NEW_DIGEST);
  });

  /**
   * The journal is truncated, not deleted. The error must say `UNREADABLE`, not `ABSENT`. The
   * refusal must not overwrite the corrupt journal, because it is evidence.
   */
  it('PromoteTree_OrphanBackupCorruptJournal_PreservesBackupAndReportsUnreadable', () => {
    crashBetweenRenames();
    fs.writeFileSync(journalFile(), '{"target":"C:\\\\part', 'utf8');

    const err = caught(() => promoteTreeSync({ target, entries: NEW_TREE }));

    expect(diskDigest(backupDir())).toBe(OLD_DIGEST);
    expect(err).toBeInstanceOf(PromotionError);
    expect((err as PromotionError).code).toBe('ORPHAN_BACKUP');
    expect((err as PromotionError).message).toContain(backupDir());
    expect((err as PromotionError).message).toContain('UNREADABLE');
    expect((err as PromotionError).message).not.toContain('is ABSENT');

    expect(fs.readFileSync(journalFile(), 'utf8')).toBe('{"target":"C:\\\\part');
  });

  /** The journal parses as JSON but is not a promotion journal. The error must say `UNREADABLE`, not `ABSENT`. */
  it('PromoteTree_OrphanBackupWrongShapeJournal_PreservesBackupAndReportsUnreadable', () => {
    crashBetweenRenames();
    fs.writeFileSync(journalFile(), JSON.stringify({ version: 2, note: 'not a journal' }), 'utf8');

    const err = caught(() => promoteTreeSync({ target, entries: NEW_TREE }));

    expect(diskDigest(backupDir())).toBe(OLD_DIGEST);
    expect(err).toBeInstanceOf(PromotionError);
    expect((err as PromotionError).code).toBe('ORPHAN_BACKUP');
    expect((err as PromotionError).message).toContain('UNREADABLE');
    expect((err as PromotionError).message).not.toContain('is ABSENT');
  });

  /** Recovery cannot consume an unreadable journal. It returns `false` and keeps the backup and the journal. */
  it('RecoverInterruptedPromotion_UnreadableJournal_ReportsNothingRecoveredAndKeepsBackup', () => {
    crashBetweenRenames();
    fs.writeFileSync(journalFile(), 'not json at all', 'utf8');

    expect(recoverInterruptedPromotion(target)).toBe(false);
    expect(diskDigest(backupDir())).toBe(OLD_DIGEST);
    expect(fs.existsSync(journalFile())).toBe(true);
  });

  /**
   * Through the effect carrier, a refusal must arrive as an error outcome, not as a throw. The
   * recorder gets no call, because the run promoted nothing. The `cause` keeps the typed
   * `ORPHAN_BACKUP` error, so a caller can tell it from any other install failure.
   */
  it('PromoteTree_OrphanBackup_SurfacesRefusalThroughTheEffectCarrier', async () => {
    crashBetweenRenames();
    fs.rmSync(journalFile());

    const recorded: PromotionExecutedRecord[] = [];
    const outcome = await promoteTree(
      { target, entries: NEW_TREE },
      LIVE,
      defaultPromotionIo(),
      (record) => {
        recorded.push(record);
      },
    );

    expect(isError(outcome)).toBe(true);
    expect(recorded).toEqual([]);
    if (isError(outcome)) {
      expect(outcome.error.code).toBe('INSTALL_EFFECT_FAILED');
      expect(outcome.error.message).toContain(backupDir());
      expect(outcome.error.cause).toBeInstanceOf(PromotionError);
      expect((outcome.error.cause as PromotionError).code).toBe('ORPHAN_BACKUP');
    }
    expect(diskDigest(backupDir())).toBe(OLD_DIGEST);
  });

  /** The operator renames the orphan backup to `target`, as the error says. The next run then promotes the new tree. */
  it('PromoteTree_OrphanBackupRestoredByOperator_ConvergesOnRetry', () => {
    crashBetweenRenames();
    fs.rmSync(journalFile());
    expect(() => promoteTreeSync({ target, entries: NEW_TREE })).toThrow(PromotionError);

    fs.renameSync(backupDir(), target);
    expect(diskDigest(target)).toBe(OLD_DIGEST);

    const report = promoteTreeSync({ target, entries: NEW_TREE });

    expect(report.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(fs.existsSync(backupDir())).toBe(false);
    expect(fs.existsSync(journalFile())).toBe(false);
  });
});

describe('DR-17 — the refusal does not fire on any legitimate promotion', () => {
  /** A first install has no target, no backup and no journal. */
  it('PromoteTree_CleanFirstInstall_PromotesNormally', () => {
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

  /** The promotion still removes the backup that it made. The guard does not make that backup a permanent orphan. */
  it('PromoteTree_ExistingTargetNoJournal_PromotesAndCleansItsOwnBackup', () => {
    writeTree(target, OLD_TREE);
    expect(diskDigest(target)).toBe(OLD_DIGEST);

    const report = promoteTreeSync({ target, entries: NEW_TREE });

    expect(report.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(fs.existsSync(backupDir())).toBe(false);
    expect(fs.existsSync(stageDir())).toBe(false);
    expect(fs.existsSync(journalFile())).toBe(false);
  });

  /**
   * An interrupted cleanup after the commit leaves a complete `target` and a redundant backup.
   * The removal of that backup loses nothing, so the guard must not fire.
   */
  it('PromoteTree_StaleBackupBesidePresentTarget_StillPromotesAndDiscardsIt', () => {
    writeTree(target, OLD_TREE);
    writeTree(backupDir(), OLD_TREE);
    expect(fs.existsSync(journalFile())).toBe(false);

    const report = promoteTreeSync({ target, entries: NEW_TREE });

    expect(report.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(fs.existsSync(backupDir())).toBe(false);
  });

  /**
   * An unreadable journal is fatal only when the backup is the last copy. Here `target` is
   * present, so the promotion continues.
   */
  it('PromoteTree_StaleBackupBesidePresentTargetCorruptJournal_StillPromotes', () => {
    writeTree(target, OLD_TREE);
    writeTree(backupDir(), OLD_TREE);
    fs.writeFileSync(journalFile(), '<<<corrupt>>>', 'utf8');

    const report = promoteTreeSync({ target, entries: NEW_TREE });

    expect(report.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(fs.existsSync(backupDir())).toBe(false);
    expect(fs.existsSync(journalFile())).toBe(false);
  });

  /** The journal is intact, so recovery restores the old tree from the backup. Then the promotion continues. */
  it('PromoteTree_ConsumableJournalAfterCrash_RecoversAndPromotesAsBefore', () => {
    crashBetweenRenames();
    const report = promoteTreeSync({ target, entries: NEW_TREE });

    expect(report.recoveredPriorAttempt).toBe(true);
    expect(report.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(fs.existsSync(backupDir())).toBe(false);
    expect(fs.existsSync(stageDir())).toBe(false);
    expect(fs.existsSync(journalFile())).toBe(false);
  });

  /** The guard runs on each call, so a false refusal shows as a throw on the second or third promotion. */
  it('PromoteTree_RepeatedPromotionsOfTheSameTree_NeverRefuse', () => {
    promoteTreeSync({ target, entries: OLD_TREE });
    promoteTreeSync({ target, entries: NEW_TREE });
    const third = promoteTreeSync({ target, entries: NEW_TREE });

    expect(third.promoted).toBe(true);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expect(fs.existsSync(backupDir())).toBe(false);
  });
});

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

  /**
   * A valid journal is on disk while `target` is absent. The state is still an orphan, and the
   * error says `UNCONSUMED`.
   */
  it('AssertNoOrphanBackup_UnconsumedValidJournal_ReportsItAsUnconsumed', () => {
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
