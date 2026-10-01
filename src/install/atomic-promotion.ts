/**
 * Staged, atomic promotion of a multi-file tree. `../utils/atomic-write.ts` covers one file.
 * A tree can fail partway and leave a mix of old and new files.
 *
 * Stage: write each file into a sibling staging directory with fsync. The live `target` does not change.
 * Verify: compare the {@link digestTree} of the staged tree with the digest of the requested entries.
 * Promote: write a journal, rename `target` to the backup, then rename the staging directory to `target`.
 * Each rename returns a {@link DurabilityBarrier} after a parent-directory fsync, and the next step takes it as an argument.
 *
 * {@link recoverFromJournal} uses only the presence of `target`. It keeps the new tree, or it restores the backup. Thus one interruption never leaves a mix.
 * A backup with an absent `target` and no usable journal is the last copy of the old tree. {@link assertNoOrphanBackup} refuses that state.
 *
 * {@link promoteTreeSync} recovers an old journal first, so a re-run converges. Each filesystem call goes through {@link PromotionIo}, so tests can inject faults.
 * {@link promoteTree} wraps the engine in the effect carrier. A dry run does not touch the disk.
 * A live run needs a {@link PromotionRecorder}, and it records `promotion.executed` on success. The module supports UTF-8 text trees only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  atomicWriteFile,
  fsyncDirSync,
  publishTempFileSync,
  type DirectorySyncOutcome,
  type DurabilityBarrier,
} from '../utils/atomic-write.js';
import { resolveContainedArtifactPath } from '../storage/artifacts/artifact-path.js';
import {
  digestTree,
  type DigestEntry,
} from './install-identity.js';
import {
  LIVE,
  emissionRecorder,
  runEffect,
  records,
  type EffectMode,
  type EffectOutcome,
  type EffectPlan,
} from '../dispatch/core/effect-carrier.js';

/**
 * Promotion failure codes. `ORPHAN_BACKUP` means that `target` is absent, the backup holds the only copy of the old tree,
 * and no usable journal exists. See {@link assertNoOrphanBackup}.
 */
export type PromotionErrorCode =
  | 'STAGE_INCOMPLETE'
  | 'PROMOTE_FAILED'
  | 'RECOVERY_FAILED'
  | 'ORPHAN_BACKUP';

/** Typed, structured failure from the promotion engine. */
export class PromotionError extends Error {
  constructor(
    readonly code: PromotionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PromotionError';
  }
}

/**
 * Filesystem seam for the promotion engine. Each path comes from the caller `target` and stays in its parent directory.
 * Thus an implementation does not check containment again. Tests inject it to force a failure at one stage without a mock of `node:fs`.
 */
export interface PromotionIo {
  /** Recursively create a directory (`mkdir -p`). */
  mkdirp(directory: string): void;
  /** Durably write a file's bytes (open + write + fsync + close). Parent exists. */
  writeFile(file: string, data: Buffer): void;
  /** Read a file's bytes. */
  readFile(file: string): Buffer;
  /** List file paths (POSIX-relative to `directory`) under `directory`, recursively. */
  listTree(directory: string): string[];
  /** True when a path (file or directory) exists. */
  exists(target: string): boolean;
  /** Atomic same-volume rename of a file or directory. */
  rename(from: string, to: string): void;
  /** Recursively remove a file or directory (`rm -rf`). */
  removeTree(target: string): void;
  /**
   * fsync the directory itself, so the entries that a preceding {@link rename} made reach stable storage.
   * It is optional. An IO without it uses the real {@link fsyncDirSync}, so a test seam that faults only a rename keeps full durability.
   * Supply it to observe or fault the durability step.
   */
  syncDirectory?(directory: string): DirectorySyncOutcome;
}

/**
 * The default IO, backed by synchronous `node:fs`. Its `rename` uses `publishTempFileSync`, which retries the transient Windows `EPERM` and `EACCES` rename race.
 * A bare `renameSync` fails on NTFS when an indexer or an antivirus holds a new tree open.
 */
export function defaultPromotionIo(): PromotionIo {
  const syncDirectory = (directory: string): DirectorySyncOutcome => fsyncDirSync(directory);
  return {
    mkdirp: (directory) => {
      fs.mkdirSync(directory, { recursive: true });
    },
    writeFile: (file, data) => {
      const fd = fs.openSync(file, 'w');
      try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
    readFile: (file) => fs.readFileSync(file),
    listTree: (directory) => listTreeSync(directory),
    exists: (target) => fs.existsSync(target),
    rename: (from, to) => {
      publishTempFileSync(from, to, { syncDirectory });
    },
    removeTree: (target) => {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
    syncDirectory,
  };
}

/**
 * Rename, then fsync the parent directory, and return a {@link DurabilityBarrier} as proof.
 * The next step takes the barrier as a parameter (see {@link afterDurable}).
 * Thus the order of journal, backup, and tree is a dependency in the code, not only an order of lines.
 * The fsync is unconditional. The default `rename` already syncs, but an injected `rename` can sync nothing, and the barrier must mean the same for both.
 */
function renameDurable(from: string, to: string, io: PromotionIo): DurabilityBarrier {
  io.rename(from, to);
  return { published: to, directory: syncDirectoryVia(io, path.dirname(to)) };
}

/** Resolve the durability step: injected seam if present, real fsync otherwise. */
function syncDirectoryVia(io: PromotionIo, directory: string): DirectorySyncOutcome {
  return (io.syncDirectory ?? fsyncDirSync)(directory);
}

/**
 * Consume a barrier before a step writes into `directory`. Throw when the barrier does not cover that directory.
 * Each barrier has the same type, so the compiler cannot catch a wrong barrier. Thus this runtime check is exported, and tests pin it.
 *
 * It checks both halves. `published` is where the rename went, and `directory.directory` is where the fsync went.
 * Through {@link promoteTreeSync}, the `published` half cannot fail, because `stagePlanFor` puts all paths in one parent. A new caller can break that.
 */
export function afterDurable(barrier: DurabilityBarrier, directory: string): void {
  const covered = path.dirname(barrier.published);
  if (covered !== directory || barrier.directory.directory !== directory) {
    throw new PromotionError(
      'PROMOTE_FAILED',
      `durability barrier for ${barrier.published} covers ${covered} ` +
        `(fsync'd ${barrier.directory.directory}), not ${directory}`,
    );
  }
}

/** Recursively enumerate file paths under `root`, POSIX-normalized and relative. */
function listTreeSync(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    const dirents = fs.readdirSync(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      if (dirent.isDirectory()) {
        walk(path.join(dir, dirent.name), rel);
      } else if (dirent.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(root, '');
  return out;
}

/** The three scaffolding paths a promotion of `target` uses. */
interface StagePlan {
  readonly target: string;
  readonly stagingDir: string;
  readonly backupDir: string;
  readonly journalPath: string;
}

/**
 * Derive the scaffolding paths for `target`. They have no random suffix, so a retry can find the journal of an interrupted attempt.
 * This is safe, because each `target` has one owner writer, as `atomic-write.ts` also assumes.
 * All paths are in the parent of `target`, so the renames stay on one volume and are atomic.
 */
function stagePlanFor(target: string): StagePlan {
  const parent = path.dirname(target);
  const base = path.basename(target);
  return {
    target,
    stagingDir: path.join(parent, `.${base}.exarchos-stage`),
    backupDir: path.join(parent, `.${base}.exarchos-backup`),
    journalPath: path.join(parent, `.${base}.exarchos-promote.json`),
  };
}

/** The on-disk journal: enough to deterministically recover an interruption. */
interface PromotionJournal {
  readonly target: string;
  readonly stagingDir: string;
  readonly backupDir: string;
  readonly journalPath: string;
}

function isPromotionJournal(value: unknown): value is PromotionJournal {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.target === 'string' &&
    typeof record.stagingDir === 'string' &&
    typeof record.backupDir === 'string' &&
    typeof record.journalPath === 'string'
  );
}

/**
 * Write the journal with `atomicWriteFile`, not through the IO seam. A torn journal is as bad as a torn promotion, and the seam faults target the tree.
 * The directory fsync goes through the promotion seam, so tests can observe and fault the durability step of the journal too.
 */
function writeJournal(plan: StagePlan, io: PromotionIo): DurabilityBarrier {
  const journal: PromotionJournal = {
    target: plan.target,
    stagingDir: plan.stagingDir,
    backupDir: plan.backupDir,
    journalPath: plan.journalPath,
  };
  return atomicWriteFile(plan.journalPath, JSON.stringify(journal), {
    syncDirectory: (directory) => syncDirectoryVia(io, directory),
  });
}

/**
 * The three dispositions of the on-disk journal. Recovery uses only `present`.
 * `absent` is a clean first install. `unreadable` is a torn or wrong-shape journal, whose backup can be the last copy of the old tree.
 * The split lets a refusal name the state that it found.
 */
type JournalRead =
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable'; readonly reason: string }
  | { readonly status: 'present'; readonly journal: PromotionJournal };

/** Read the journal. A file that exists but does not parse, or that a read cannot open, is `unreadable`, not `absent`. */
function readJournal(plan: StagePlan, io: PromotionIo): JournalRead {
  if (!io.exists(plan.journalPath)) return { status: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(io.readFile(plan.journalPath).toString('utf8'));
  } catch (err) {
    return { status: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
  if (!isPromotionJournal(parsed)) {
    return {
      status: 'unreadable',
      reason: 'parsed JSON is not a promotion journal (target/stagingDir/backupDir/journalPath)',
    };
  }
  return { status: 'present', journal: parsed };
}

/** One-line diagnosis of why a journal cannot drive recovery. */
function describeJournal(read: JournalRead, journalPath: string): string {
  switch (read.status) {
    case 'absent':
      return `its promotion journal ${journalPath} is ABSENT`;
    case 'unreadable':
      return `its promotion journal ${journalPath} is UNREADABLE (${read.reason})`;
    case 'present':
      return `its promotion journal ${journalPath} survived recovery UNCONSUMED`;
  }
}

/**
 * Bring an interrupted promotion to a complete state, from the presence of `target` only.
 * When `target` exists, it is the old tree or the new tree, so the backup and staging directories go.
 * When `target` is absent, the run stopped between the two renames, so the backup renames back to `target`.
 * With no `target` and no backup, the target is new, and only the staging directory goes.
 *
 * The restore is the one step that is not best-effort. When it throws, the journal stays, so a later {@link promoteTreeSync} runs recovery again.
 * The restore is durable, because a second crash can lose a rename that is not on stable storage.
 */
function recoverFromJournal(journal: PromotionJournal, io: PromotionIo): void {
  if (io.exists(journal.target)) {
    safeRemove(journal.backupDir, io);
    safeRemove(journal.stagingDir, io);
  } else if (io.exists(journal.backupDir)) {
    renameDurable(journal.backupDir, journal.target, io);
    safeRemove(journal.stagingDir, io);
  } else {
    safeRemove(journal.stagingDir, io);
  }
  safeRemove(journal.journalPath, io);
}

/** Best-effort recursive remove — never throws, never masks a real failure. */
function safeRemove(target: string, io: PromotionIo): void {
  try {
    if (io.exists(target)) io.removeTree(target);
  } catch {
  }
}

/**
 * If a journal from a prior interrupted promotion of `target` exists, recover it
 * (leaving the destination complete) and report `true`. The idempotent-retry
 * entry point: called at the start of every {@link promoteTreeSync}.
 */
export function recoverInterruptedPromotion(target: string, io: PromotionIo = defaultPromotionIo()): boolean {
  const plan = stagePlanFor(target);
  const read = readJournal(plan, io);
  if (read.status !== 'present') return false;
  recoverFromJournal(read.journal, io);
  return true;
}

/**
 * Throw `ORPHAN_BACKUP` when `target` is absent and the backup is present. Then the backup holds the only copy of the old tree.
 * A removal of the backup, or a new tree over it, destroys that copy. The error names the orphan and the operator options.
 * The check uses disk state. A journal read only explains why the state is stuck.
 *
 * A present `target` makes a backup a redundant copy, and an absent backup leaves nothing to lose. Both states pass.
 * {@link promoteTreeSync} calls it after recovery, so the diagnosis there is `absent` or `unreadable`.
 * It is exported, so tests and callers can ask the same question.
 */
export function assertNoOrphanBackup(target: string, io: PromotionIo = defaultPromotionIo()): void {
  const plan = stagePlanFor(target);
  if (io.exists(plan.target)) return;
  if (!io.exists(plan.backupDir)) return;

  const diagnosis = describeJournal(readJournal(plan, io), plan.journalPath);
  throw new PromotionError(
    'ORPHAN_BACKUP',
    `refusing to promote into ${plan.target}: the target is absent and the orphan backup ` +
      `${plan.backupDir} holds the only surviving copy of the previous tree, but ${diagnosis}, ` +
      `so recovery cannot consume it. Discarding it — or promoting over it — would destroy that ` +
      `tree irrecoverably. Inspect ${plan.backupDir}, then either restore it (rename it to ` +
      `${plan.target}) or delete it deliberately, and re-run.`,
  );
}

/** A tree promotion request: the destination and the complete new tree. */
export interface TreePromotionRequest {
  /** Absolute directory to promote the new tree into. */
  readonly target: string;
  /** The complete new tree, as POSIX-relative path / UTF-8 content entries. */
  readonly entries: readonly DigestEntry[];
  /** Effect owner recorded in the {@link EffectPlan} (defaults to this module). */
  readonly owner?: string;
}

/** The result of a completed promotion. */
export interface PromotionReport {
  readonly target: string;
  /** Content-addressed {@link digestTree} of the promoted (new) tree. */
  readonly treeDigest: string;
  /** True once the NEW tree is in place. */
  readonly promoted: boolean;
  /** True when a journal from a prior interrupted attempt was recovered first. */
  readonly recoveredPriorAttempt: boolean;
  /**
   * The result of the parent-directory fsync for the commit rename. It is `'synced'` on POSIX.
   * It is `'unsupported'` with the errno where the host refuses a directory fsync. Win32 reports `EPERM`.
   * A caller can thus tell a durable promotion from an atomic promotion whose durability the platform cannot prove.
   */
  readonly directoryDurability: DirectorySyncOutcome;
}

/**
 * Write each entry into the staging directory. An entry path is caller data, so a `..` segment or an absolute path can escape a bare `path.join`.
 * `resolveContainedArtifactPath` checks each component and the joined result. A violation throws `STAGE_INCOMPLETE` before any byte is written.
 */
function stageEntries(plan: StagePlan, entries: readonly DigestEntry[], io: PromotionIo): void {
  io.mkdirp(plan.stagingDir);
  for (const entry of entries) {
    const rel = entry.path.replace(/\\/g, '/');
    let full: string;
    try {
      full = resolveContainedArtifactPath(plan.stagingDir, rel.split('/'));
    } catch (err) {
      throw new PromotionError(
        'STAGE_INCOMPLETE',
        `refusing to stage entry ${JSON.stringify(entry.path)} for ${plan.target}: ` +
          `its path escapes the staging directory ${plan.stagingDir}`,
        { cause: err },
      );
    }
    io.mkdirp(path.dirname(full));
    io.writeFile(full, Buffer.from(entry.content, 'utf8'));
  }
}

function readStagedEntries(plan: StagePlan, io: PromotionIo): DigestEntry[] {
  return io.listTree(plan.stagingDir).map((rel) => ({
    path: rel,
    content: io.readFile(path.join(plan.stagingDir, ...rel.split('/'))).toString('utf8'),
  }));
}

/**
 * The atomic swap: write the journal, move any `target` to the backup, then rename the verified staging tree into place.
 * On a failure it runs {@link recoverFromJournal} to restore the old tree, then throws `PROMOTE_FAILED`. When recovery also fails, the journal stays for a retry.
 * The steps chain through {@link DurabilityBarrier} values, so each step needs the barrier of the step before it.
 * After the commit, cleanup is best-effort and does not throw. A leftover backup still leaves a complete new tree, and a later run removes it.
 */
function commitPromotion(plan: StagePlan, io: PromotionIo): DirectorySyncOutcome {
  let committed: DurabilityBarrier;
  try {
    const journalBarrier = writeJournal(plan, io);
    const backupBarrier = backupExistingTarget(plan, io, journalBarrier);
    committed = promoteStagedTree(plan, io, backupBarrier);
  } catch (err) {
    try {
      const read = readJournal(plan, io);
      recoverFromJournal(read.status === 'present' ? read.journal : journalFromPlan(plan), io);
    } catch {
    }
    throw new PromotionError(
      'PROMOTE_FAILED',
      `failed to promote staged tree into ${plan.target}`,
      { cause: err },
    );
  }
  safeRemove(plan.backupDir, io);
  safeRemove(plan.journalPath, io);
  return committed.directory;
}

/**
 * Move any old tree aside. It takes the journal barrier, because the journal is the only record of where the old tree went.
 * A backup rename that is durable before the journal leaves a crash with no `target` and no journal.
 * Returns `undefined` when no old tree exists. Then the commit has no backup to order against.
 */
function backupExistingTarget(
  plan: StagePlan,
  io: PromotionIo,
  journal: DurabilityBarrier,
): DurabilityBarrier | undefined {
  afterDurable(journal, path.dirname(plan.backupDir));
  if (!io.exists(plan.target)) return undefined;
  return renameDurable(plan.target, plan.backupDir, io);
}

/** The COMMIT POINT: atomic, and not begun until the backup entry is durable. */
function promoteStagedTree(
  plan: StagePlan,
  io: PromotionIo,
  backup: DurabilityBarrier | undefined,
): DurabilityBarrier {
  if (backup !== undefined) afterDurable(backup, path.dirname(plan.target));
  return renameDurable(plan.stagingDir, plan.target, io);
}

function journalFromPlan(plan: StagePlan): PromotionJournal {
  return {
    target: plan.target,
    stagingDir: plan.stagingDir,
    backupDir: plan.backupDir,
    journalPath: plan.journalPath,
  };
}

/**
 * Stage, verify, and atomically promote a complete tree into `request.target`. {@link promoteTree} wraps this throwing core.
 * First it recovers a prior journal, then {@link assertNoOrphanBackup} refuses an orphan backup.
 *
 * A stage failure leaves the old tree and removes the partial stage. A digest mismatch throws `STAGE_INCOMPLETE` with the old tree in place.
 * A promote failure rolls back to the old tree, or leaves a journal after a double fault. Success leaves the new tree.
 *
 * Before the stage, it removes old staging and backup directories. This is safe only because the orphan check passed, so `target` is present or no backup exists.
 * Recovery alone does not make it safe, because recovery does nothing with an absent or corrupt journal.
 * The removal must come before the rename of `target` to the backup, which otherwise collides with the directory (`EPERM` on Windows, `ENOTEMPTY` or `EEXIST` elsewhere).
 */
export function promoteTreeSync(
  request: TreePromotionRequest,
  io: PromotionIo = defaultPromotionIo(),
): PromotionReport {
  const plan = stagePlanFor(request.target);
  const recoveredPriorAttempt = recoverInterruptedPromotion(request.target, io);
  assertNoOrphanBackup(request.target, io);

  const expected = digestTree(request.entries);

  try {
    safeRemove(plan.stagingDir, io);
    safeRemove(plan.backupDir, io);
    stageEntries(plan, request.entries, io);
    const actual = digestTree(readStagedEntries(plan, io));
    if (actual !== expected) {
      throw new PromotionError(
        'STAGE_INCOMPLETE',
        `staged tree digest ${actual} does not match requested ${expected} for ${request.target}`,
      );
    }
  } catch (err) {
    safeRemove(plan.stagingDir, io);
    if (err instanceof PromotionError) throw err;
    throw new PromotionError(
      'STAGE_INCOMPLETE',
      `failed to stage tree for ${request.target}`,
      { cause: err },
    );
  }

  const directoryDurability = commitPromotion(plan, io);

  return {
    target: request.target,
    treeDigest: expected,
    promoted: true,
    recoveredPriorAttempt,
    directoryDurability,
  };
}

/** The name the catalog registers for the durable tree-promotion record. */
export const PROMOTION_EXECUTED = 'promotion.executed';

/**
 * One emission, on success only. No intent event, because the promoter already writes an on-disk journal before the commit rename and reads it for recovery.
 * No failure terminal, because a failed promotion rolls back to the previous complete tree. No partial outcome exists to describe.
 */
const PROMOTION_EMISSIONS = records({ event: PROMOTION_EXECUTED, when: 'on-success' });

/**
 * The fact that a completed promotion records: the target, the tree digest, the owner, and whether the run recovered an earlier attempt.
 * It copies the fields of the catalog `PromotionExecutedData`. This module is below the event layer, so it does not infer the type from the Zod schema.
 */
export interface PromotionExecutedRecord {
  readonly target: string;
  readonly treeDigest: string;
  readonly owner: string;
  readonly recoveredPriorAttempt: boolean;
}

/**
 * Where a promotion's record lands — the caller's business, not this module's.
 *
 * The promoter owns the PAYLOAD (it is the only thing that knows the digest it
 * verified the stage against) and the caller owns the DESTINATION. Awaited, so
 * a recorder backed by a durable store gates the promotion's return on the
 * append actually completing.
 */
export type PromotionRecorder = (record: PromotionExecutedRecord) => void | Promise<void>;

/** The typed {@link EffectPlan} a tree promotion executes (or withholds in dry-run). */
export function promotionPlan(owner: string, target: string): EffectPlan {
  return {
    effectClass: 'install',
    owner,
    description: `atomically promote a staged tree into ${target}`,
    idempotent: true,
    compensation: 'roll back to the previous complete tree via the promotion journal',
    emits: PROMOTION_EMISSIONS,
  };
}

/**
 * Promote a tree through the typed effect carrier. In `dry-run` mode, {@link runEffect} returns the {@link EffectPlan} and calls neither the engine nor the `recorder`.
 * In `live` mode, a thrown {@link PromotionError} becomes an `error` carrier.
 * A live call without a `recorder` function throws a `TypeError` before any IO. The carrier sees a wrapper, so its own check fires only after the promotion.
 *
 * The carrier does not give the report to its sink. Thus the engine result goes to the sink through a local variable.
 * The success carrier returns only after the recorder completes, so its record is already committed.
 * The sink throws when no report exists, because a sink that returns still mints a receipt for a record that nobody wrote.
 */
export async function promoteTree(
  request: TreePromotionRequest,
  mode: EffectMode = LIVE,
  io: PromotionIo = defaultPromotionIo(),
  recorder: PromotionRecorder,
): Promise<EffectOutcome<PromotionReport>> {
  if (mode.kind === 'live' && typeof recorder !== 'function') {
    throw new TypeError(
      'promoteTree requires a recorder in live mode: the plan declares a promotion ' +
        'record, and a promotion that cannot be recorded must not run at all.',
    );
  }

  const owner = request.owner ?? 'install/atomic-promotion';
  const plan = promotionPlan(owner, request.target);

  let report: PromotionReport | undefined;
  const promoted = (): Promise<PromotionReport> => {
    report = promoteTreeSync(request, io);
    return Promise.resolve(report);
  };

  const ledger = emissionRecorder(async () => {
    if (report === undefined) {
      throw new Error(
        `promotion of ${request.target} reached its success terminal with no report to record`,
      );
    }
    await recorder({
      target: report.target,
      treeDigest: report.treeDigest,
      owner,
      recoveredPriorAttempt: report.recoveredPriorAttempt,
    });
  });

  return runEffect(mode, plan, promoted, ledger);
}

/**
 * Atomically copy the tree at `src` into `dest`. It is a drop-in for the `copyDir(src, dest)` seam of `installSkills` in `install-skills.ts`.
 * The default there is `fs.cpSync` after the caller removes `dest`, so a failed copy can leave `dest` half full.
 * With {@link promoteTreeSync}, `dest` is absent or the complete new tree, and a re-run converges. The source must be UTF-8 text.
 */
export function atomicCopyTreeSync(
  src: string,
  dest: string,
  io: PromotionIo = defaultPromotionIo(),
): void {
  const entries: DigestEntry[] = io.listTree(src).map((rel) => ({
    path: rel,
    content: io.readFile(path.join(src, ...rel.split('/'))).toString('utf8'),
  }));
  promoteTreeSync({ target: dest, entries, owner: 'install/atomic-promotion:copyDir' }, io);
}
