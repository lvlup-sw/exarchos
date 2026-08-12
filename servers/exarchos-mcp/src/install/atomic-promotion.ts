/**
 * atomic-promotion — staged, atomic, rollback-proof multi-file TREE promotion.
 * (P04-04; EFF-009, EFF-012)
 *
 * EFF-008 (`../utils/atomic-write.ts`) solved the single-file case: temp + fsync
 * + rename gives a reader either the old bytes or the new bytes, never a torn
 * write. This module is the MULTI-FILE analogue that EFF-008 does not cover:
 * promoting a whole *tree* — the rendered `skills/<runtime>/` set, an installer
 * payload, an onboarding scaffold — where a failure partway through leaves some
 * files new and some old, a torn state no single-file rename protects against.
 *
 * ## The stage → verify → promote pattern
 *
 *   1. STAGE — every file of the new tree is written into a fresh sibling
 *      staging directory (`.<name>.exarchos-stage`), each file fsync'd. The live
 *      `target` is never touched during staging, so a mid-stage failure leaves
 *      the old tree fully intact.
 *   2. VERIFY — the staged tree is re-read and its content-addressed
 *      {@link digestTree} (the P05-04 install-identity digest, byte-identical to
 *      P03-07's `digestTree` — see `install-identity.ts`) is compared against the
 *      digest of the requested entries. An incomplete or corrupted stage is
 *      rejected here, *before* anything is promoted.
 *   3. PROMOTE — a bounded sequence of atomic same-volume renames swaps the tree
 *      into place: `rename(target → backup)` then `rename(staging → target)`.
 *      Each rename is atomic, and a small on-disk JOURNAL records the three paths
 *      so that any interruption is deterministically recoverable.
 *
 * ## Durable ordering (DR-16)
 *
 * Steps 1–3 above are a SEQUENCE, and a sequence of renames is only ordered on
 * disk if each rename's directory entry is durable before the next one is made.
 * `rename(2)` is atomic for observers but leaves the new name in the parent
 * directory's unflushed metadata, so "journal, then backup, then tree" without a
 * parent-directory fsync between the steps is a property of this source file and
 * not of the filesystem. {@link renameDurable} and {@link DurabilityBarrier} are
 * how that ordering is CONSTRUCTED here: each step returns a barrier, and the
 * step that must not begin until it is durable takes that barrier as an
 * argument. See `../utils/atomic-write.ts` for the underlying primitive and the
 * full explanation.
 *
 * ## Rollback and recovery (EFF-009)
 *
 * The promotion is atomic at the `rename(staging → target)` step: before it the
 * tree on disk is fully OLD, after it fully NEW. The only window is between the
 * two renames, where `target` is briefly absent while `backup` holds the old
 * tree. {@link recoverFromJournal} closes that window: driven only by whether
 * `target` exists, it either finalizes NEW (target present → discard scaffolding)
 * or restores OLD (target absent → `rename(backup → target)`). So after ANY
 * single interruption the destination is either the complete old tree or the
 * complete new tree — never a mix.
 *
 * ## Refusing an orphan backup (DR-17)
 *
 * Recovery is driven by the journal, so a journal that is missing or corrupt
 * leaves the `backup` directory with no owner. When `target` is ALSO absent that
 * orphan is the only surviving copy of the old tree, and both ways of continuing
 * — discarding it as stale scaffolding, or staging a new tree over it — destroy
 * it irrecoverably. {@link assertNoOrphanBackup} refuses that state with a typed
 * `ORPHAN_BACKUP` error naming the orphan, rather than proceeding destructively.
 *
 * ## Idempotent retry across runtimes (EFF-012)
 *
 * {@link promoteTreeSync} first recovers any journal left by a previous
 * interrupted attempt, then re-stages and re-promotes. A second run after a
 * failed first run therefore converges to the correct final state without
 * duplicating or corrupting — the property onboarding install needs to be safely
 * re-runnable per runtime.
 *
 * ## Injectable IO seam
 *
 * Every filesystem touch goes through {@link PromotionIo}, following the
 * P04-03 `ContentAddressedStoreIo` pattern: tests inject an IO that throws at a
 * chosen operation on a chosen path to force a failure at each distinct stage
 * (mid-stage, after-stage, mid-promote, and a double-fault "hard crash") and
 * assert the destination is never torn. The journal write reuses the EFF-008
 * `atomicWriteFile` primitive.
 *
 * ## Effect carrier + dry-run (P04-01)
 *
 * {@link promoteTree} wraps the sync engine in the typed effect carrier: a
 * `dry-run` mode is structurally incapable of touching the filesystem (it returns
 * the {@link EffectPlan} without invoking the engine), so a caller can prove a
 * dry-run promoted nothing.
 *
 * This module assumes UTF-8 text trees (skills / command-aliases / onboarding
 * scaffolds are `.md` / `.yaml` / `.json` / `.jsonl` / `.sh`). Byte content is
 * preserved by an exact UTF-8 round-trip; genuinely binary payloads are out of
 * scope (they belong in the content-addressed artifact store, P04-03).
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
  runEffect,
  type EffectMode,
  type EffectOutcome,
  type EffectPlan,
} from '../dispatch/core/effect-carrier.js';

// ─── Errors ───────────────────────────────────────────────────────────────────

export type PromotionErrorCode =
  | 'STAGE_INCOMPLETE'
  | 'PROMOTE_FAILED'
  | 'RECOVERY_FAILED'
  /**
   * DR-17: `target` is absent and the backup directory holds the only surviving
   * copy of the previous tree, but no consumable journal says how to finish. The
   * promotion REFUSES rather than discarding or overwriting it — see
   * {@link assertNoOrphanBackup}.
   */
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

// ─── IO seam ──────────────────────────────────────────────────────────────────

/**
 * Filesystem seam for the promotion engine. Every path handed to these functions
 * is derived from a caller-supplied `target` under its own parent directory, so
 * an implementation never needs to re-validate containment. Injectable so tests
 * can force a mid-stage / mid-promote failure without mocking `node:fs` wholesale
 * (the P04-03 `ContentAddressedStoreIo` pattern).
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
   * fsync `directory` ITSELF, so directory entries created by a preceding
   * {@link rename} reach stable storage (DR-16 — see `renameDurable` and
   * `../utils/atomic-write.ts`).
   *
   * Optional, and the omission is NOT a silent opt-out: an IO that does not
   * supply one falls back to the real {@link fsyncDirSync}, so a test seam that
   * only wants to fault a rename never quietly downgrades the durability of the
   * promotion it is testing. Supply it to OBSERVE or fault the durability step.
   */
  syncDirectory?(directory: string): DirectorySyncOutcome;
}

/** The default IO, backed by synchronous `node:fs`. */
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
      // Reuse the EFF-008 sync publish, which absorbs Windows' transient
      // EPERM/EACCES directory-rename race with a bounded, jittered retry — a
      // bare `renameSync` flakes on NTFS when an indexer/AV briefly holds a
      // just-written tree open. Same-volume, so the rename stays atomic.
      publishTempFileSync(from, to, { syncDirectory });
    },
    removeTree: (target) => {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
    syncDirectory,
  };
}

// ─── Durable ordering (DR-16) ────────────────────────────────────────────────

/**
 * Rename, then make the resulting directory ENTRY durable, and hand back the
 * proof.
 *
 * Why a returned token instead of two statements: the promotion's correctness
 * rests on journal-before-backup-before-tree, and a bare statement sequence
 * asserts that ordering only in the source text. `renameDurable` gives each step
 * a {@link DurabilityBarrier}, and the next step takes the previous step's
 * barrier as a PARAMETER (see {@link afterDurable}) — so the dependency is
 * enforced by the compiler, checked at runtime, and visible to a reader, rather
 * than being an accident of which line came first. That is the whole of DR-16.
 *
 * The fsync is unconditional even though {@link defaultPromotionIo}'s `rename`
 * already syncs (it routes through `publishTempFileSync`): on the default path
 * this is a second, near-free fsync of an already-clean directory, and it is the
 * only way the barrier means the same thing for an INJECTED rename that syncs
 * nothing.
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
 * Consume a barrier: the caller is about to write into `directory` and asserts
 * the step the barrier names is already durable there.
 *
 * Deliberately not a no-op parameter. A token that is merely *accepted* is a
 * comment wearing a type; checking that it actually covers the directory the
 * next step touches makes the precondition load-bearing at runtime too, so a
 * refactor that threads the wrong barrier through fails loudly instead of
 * type-checking into silence.
 *
 * EXPORTED so the precondition can be pinned directly. This is the one link in
 * the DR-16 chain the compiler CANNOT check: every step's barrier has the same
 * type, so threading the wrong one — a barrier from another promotion, or one
 * whose fsync went somewhere else — type-checks perfectly and can only fail
 * here. A guard against a mistake the type system cannot see is precisely the
 * kind that rots unnoticed if nothing exercises it.
 *
 * Both halves are checked, and they are not redundant. `published` says where
 * the rename LANDED; `directory.directory` says where the fsync ACTUALLY WENT.
 * A seam that renames into one directory and fsyncs another satisfies the first
 * and violates the second, and that combination is durability theatre — a
 * barrier that reports success while proving nothing about the entry it names.
 *
 * Note on reachability: within one {@link StagePlan} the journal, backup and
 * target all live in the same parent by construction, so the `published` half
 * cannot be violated through {@link promoteTreeSync} today. It is checked (and
 * tested directly) because that invariant is a property of `stagePlanFor`, not
 * of this function's contract, and a future caller that breaks it should hit an
 * error rather than a silently mis-ordered promotion.
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

// ─── Staging plan + journal ─────────────────────────────────────────────────

/** The three scaffolding paths a promotion of `target` uses. */
interface StagePlan {
  readonly target: string;
  readonly stagingDir: string;
  readonly backupDir: string;
  readonly journalPath: string;
}

/**
 * Derive the deterministic scaffolding paths for `target`. Deterministic (no
 * random suffix) so a retry can FIND a journal left by an interrupted attempt;
 * safe because each `target` has a single owning writer (INV — the same
 * assumption `atomic-write.ts` documents). All three live in `target`'s parent
 * directory, guaranteeing same-volume (atomic) renames.
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

function writeJournal(plan: StagePlan, io: PromotionIo): DurabilityBarrier {
  const journal: PromotionJournal = {
    target: plan.target,
    stagingDir: plan.stagingDir,
    backupDir: plan.backupDir,
    journalPath: plan.journalPath,
  };
  // Journal writes reuse the EFF-008 single-file atomic writer directly (not the
  // IO seam) — a torn journal would be as bad as a torn promotion, and the IO
  // seam's fault-injection is aimed at the tree, not its own recovery record.
  //
  // DR-16: `atomicWriteFile` is tmp → fsync(file) → rename → fsync(parent dir),
  // and returns the barrier proving both halves. Its directory fsync is routed
  // through the promotion seam so the journal's durability step is observable
  // (and faultable) at exactly the same seam the tree renames use — the journal
  // must not be the one step whose durability nobody can see.
  return atomicWriteFile(plan.journalPath, JSON.stringify(journal), {
    syncDirectory: (directory) => syncDirectoryVia(io, directory),
  });
}

/**
 * The three DISTINGUISHABLE dispositions of the on-disk journal (DR-17).
 *
 * `readJournal` used to collapse all of them into `undefined`, which is what let
 * the orphan-backup bug hide: "no journal was ever written" (a clean first
 * install) and "the journal is garbage / truncated / the wrong shape" (a torn
 * crash whose backup may be the last copy of the old tree) looked identical to
 * every caller, so the only safe branch — refuse — had nothing to branch on.
 * Recovery still consumes ONLY `present`; the split exists so a refusal can name
 * which of the two unrecoverable states it actually found.
 */
type JournalRead =
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable'; readonly reason: string }
  | { readonly status: 'present'; readonly journal: PromotionJournal };

function readJournal(plan: StagePlan, io: PromotionIo): JournalRead {
  if (!io.exists(plan.journalPath)) return { status: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(io.readFile(plan.journalPath).toString('utf8'));
  } catch (err) {
    // Unreadable, not absent: the bytes exist and we could not turn them into a
    // recovery plan. A read that fails (EACCES, a directory where a file should
    // be) lands here too — same conclusion, different cause.
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

/** One-line diagnosis of why a journal could not drive recovery. */
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

// ─── Recovery ─────────────────────────────────────────────────────────────────

/**
 * Bring a possibly-interrupted promotion to a COMPLETE state, driven solely by
 * whether `target` exists:
 *
 *   - `target` present  → the tree in place is authoritative (it is either the
 *     untouched OLD tree, if we never renamed it away, or the freshly promoted
 *     NEW tree). Discard the backup + staging scaffolding.
 *   - `target` absent    → we interrupted between `rename(target → backup)` and
 *     `rename(staging → target)`; restore the OLD tree with
 *     `rename(backup → target)` so the destination is complete again.
 *
 * The `rename(backup → target)` restore is the one step that is NOT best-effort:
 * if it throws (e.g. a fault-injecting IO) the journal is deliberately left in
 * place so a later {@link promoteTreeSync} retry re-runs recovery. Everything
 * else is best-effort cleanup that never masks a restore failure.
 */
function recoverFromJournal(journal: PromotionJournal, io: PromotionIo): void {
  if (io.exists(journal.target)) {
    safeRemove(journal.backupDir, io);
    safeRemove(journal.stagingDir, io);
  } else if (io.exists(journal.backupDir)) {
    // Restore OLD — may throw (double-fault). Durable like every other tree
    // rename: a restore whose directory entry is not on stable storage can be
    // lost by a second crash, putting the destination back in the window this
    // function exists to close.
    renameDurable(journal.backupDir, journal.target, io);
    safeRemove(journal.stagingDir, io);
  } else {
    // Neither target nor backup: nothing to restore (target was newly created and
    // never had an old tree). Drop the orphan staging dir.
    safeRemove(journal.stagingDir, io);
  }
  safeRemove(journal.journalPath, io);
}

/** Best-effort recursive remove — never throws, never masks a real failure. */
function safeRemove(target: string, io: PromotionIo): void {
  try {
    if (io.exists(target)) io.removeTree(target);
  } catch {
    /* best-effort */
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
 * DR-17 — REFUSE to proceed when the backup directory is the only surviving copy
 * of the previous tree.
 *
 * Called at the start of every {@link promoteTreeSync}, AFTER
 * {@link recoverInterruptedPromotion} has had its chance to consume a journal.
 * At that point exactly one state is unrecoverable:
 *
 *   `target` ABSENT + `backup` PRESENT
 *
 * There is no live tree, so the backup holds the only bytes of the old tree that
 * still exist, and recovery did not (or could not) restore it. Both of the ways
 * a promotion could continue from here are destructive and unrecoverable
 * (INV-14): removing the backup as "stale scaffolding" deletes the last copy,
 * and staging + committing a new tree over it leaves `rename(target → backup)`
 * colliding with — or the post-commit cleanup discarding — that same last copy.
 * So this refuses instead, naming the orphan and what an operator can do with it.
 *
 * The decision is driven by DISK STATE, not by whether recovery reported a
 * journal: a journal read is used only to diagnose *why* the state is stuck. The
 * two admitted states pass straight through, and they are the only ones a healthy
 * install ever reaches —
 *
 *   - `target` PRESENT: the destination is a complete tree, so any surviving
 *     backup is a redundant second copy (a post-commit cleanup that was
 *     interrupted) and is genuinely discardable.
 *   - `backup` ABSENT: a first install, or a converged one. Nothing to lose.
 *
 * EXPORTED so the refusal can be pinned directly, and so a caller that wants to
 * check before building a promotion request can ask the same question this does.
 *
 * Note on reachability: through {@link promoteTreeSync} the diagnosis is always
 * `absent` or `unreadable`, because a journal that IS consumable was consumed by
 * the recovery one line earlier (which either restores `target` or throws). The
 * third diagnosis — a valid journal that outlived recovery — is reported anyway,
 * for the same reason {@link afterDurable} checks an invariant its only caller
 * cannot violate: it is a property of the call site, not of this function's
 * contract, and a future caller that reaches this state deserves an accurate
 * message rather than a confident lie about a missing journal.
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

// ─── The engine ───────────────────────────────────────────────────────────────

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
   * How the DR-16 parent-directory fsync fared for the COMMIT rename.
   * `'synced'` on POSIX; `'unsupported'` (carrying the refusing errno) on hosts
   * where fsync of a directory handle is not a thing — win32 reports `EPERM`.
   *
   * Reported rather than swallowed so a caller can tell "durably promoted" from
   * "atomically promoted, durability unproven by the platform". A blanket
   * `catch {}` here would recreate the exact defect DR-16 exists to remove.
   */
  readonly directoryDurability: DirectorySyncOutcome;
}

function stageEntries(plan: StagePlan, entries: readonly DigestEntry[], io: PromotionIo): void {
  io.mkdirp(plan.stagingDir);
  for (const entry of entries) {
    const rel = entry.path.replace(/\\/g, '/');
    // Containment: a DigestEntry path is caller-supplied data, and a `..`
    // segment (or an absolute / drive-qualified path) in a bare
    // `path.join(stagingDir, ...)` would write OUTSIDE the staging dir.
    // `resolveContainedArtifactPath` validates every component structurally
    // AND re-proves the joined result stays under the staging root; a
    // violation fails typed BEFORE any byte is written.
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
 * The atomic swap. Records the journal, moves any existing `target` aside to
 * `backup`, then renames the verified staging tree into place. On any failure it
 * runs {@link recoverFromJournal} in line (restoring OLD); if that recovery also
 * fails (a double fault — a simulated hard crash), the journal is left for a
 * subsequent retry to recover, and the original error is rethrown.
 *
 * The three steps are chained through {@link DurabilityBarrier}s rather than
 * merely written in order — see {@link renameDurable}. `backupExistingTarget`
 * cannot be called without the journal's barrier, and `promoteStagedTree` cannot
 * be called without the backup's, so the disk-level ordering the recovery
 * algorithm depends on is a compile-time fact here, not a convention.
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
      /* recovery itself failed — leave the journal so a retry recovers */
    }
    throw new PromotionError(
      'PROMOTE_FAILED',
      `failed to promote staged tree into ${plan.target}`,
      { cause: err },
    );
  }
  // Committed: NEW is in place. Finalize is best-effort and must never throw to
  // the caller — a leftover backup after commit is still a FULLY-NEW destination,
  // and a later recovery/retry cleans it.
  safeRemove(plan.backupDir, io);
  safeRemove(plan.journalPath, io);
  return committed.directory;
}

/**
 * Move any existing OLD tree aside. Takes the journal's barrier because it must
 * not run until the journal's directory entry is durable: the journal is the
 * ONLY record of where the old tree went, so a backup rename that reaches stable
 * storage before the journal does leaves a crash with a vanished `target` and no
 * instructions.
 *
 * Returns `undefined` when there was no old tree (first install) — there is then
 * no backup entry to order the commit against.
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
 * Stage, verify, and atomically promote a complete tree into `request.target`.
 * Synchronous and throwing (the throwing core the carrier wraps).
 *
 * The sequence, and what each failure leaves behind:
 *   0. RECOVER any journal from a prior interrupted attempt (idempotent retry),
 *      then REFUSE (`ORPHAN_BACKUP`) if that left an unowned backup holding the
 *      only surviving copy of the old tree — see {@link assertNoOrphanBackup}.
 *   1. STAGE every entry into a fresh sibling staging dir — a failure here leaves
 *      the target fully OLD and drops the partial stage.
 *   2. VERIFY the staged tree digests to the requested tree — a mismatch throws
 *      `STAGE_INCOMPLETE` with the target still fully OLD.
 *   3. PROMOTE with atomic renames — a failure rolls back to fully OLD (or, on a
 *      double fault, leaves a recoverable journal); success leaves fully NEW.
 */
export function promoteTreeSync(
  request: TreePromotionRequest,
  io: PromotionIo = defaultPromotionIo(),
): PromotionReport {
  const plan = stagePlanFor(request.target);
  const recoveredPriorAttempt = recoverInterruptedPromotion(request.target, io);
  // DR-17. Recovery has had its chance; if the destination is still absent while
  // a backup survives, that backup is the last copy of the old tree and NOTHING
  // below may run — staging and the removal beneath it would both destroy it.
  assertNoOrphanBackup(request.target, io);

  const expected = digestTree(request.entries);

  // 1–2. Stage + verify. A failure here must leave the target untouched.
  try {
    // Clear any orphan scaffolding a prior run left behind. Reaching this line
    // means `assertNoOrphanBackup` above admitted the state, i.e. either the
    // `target` is PRESENT — so a surviving backup is a redundant second copy,
    // stale garbage from a promotion whose best-effort cleanup was interrupted
    // after commit — or there is no backup at all. That is the ONLY reason the
    // removal below is safe. It is emphatically NOT safe because
    // `recoverInterruptedPromotion` ran: recovery consumes a journal only when
    // one is readable, and with an absent or corrupt journal it consumes
    // nothing and reports `false` (DR-17 — this removal used to fire anyway and
    // delete the last surviving OLD tree).
    // The removal must still happen before `commitPromotion` renames
    // `target → backup`, or that rename collides with the pre-existing
    // directory (a persistent EPERM on Windows, ENOTEMPTY/EEXIST elsewhere).
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

  // 3. Promote.
  const directoryDurability = commitPromotion(plan, io);

  return {
    target: request.target,
    treeDigest: expected,
    promoted: true,
    recoveredPriorAttempt,
    directoryDurability,
  };
}

/** The typed {@link EffectPlan} a tree promotion executes (or withholds in dry-run). */
export function promotionPlan(owner: string, target: string): EffectPlan {
  return {
    effectClass: 'install',
    owner,
    description: `atomically promote a staged tree into ${target}`,
    idempotent: true,
    compensation: 'roll back to the previous complete tree via the promotion journal',
  };
}

/**
 * Promote a tree through the typed effect carrier (P04-01). In `dry-run` mode the
 * engine is NEVER invoked — {@link runEffect} returns the {@link EffectPlan}
 * without touching the filesystem — so a dry-run provably promotes nothing. In
 * `live` mode a thrown {@link PromotionError} is captured into an `error`
 * carrier rather than propagating.
 */
export async function promoteTree(
  request: TreePromotionRequest,
  mode: EffectMode = LIVE,
  io: PromotionIo = defaultPromotionIo(),
): Promise<EffectOutcome<PromotionReport>> {
  const owner = request.owner ?? 'install/atomic-promotion';
  const plan = promotionPlan(owner, request.target);
  return runEffect(mode, plan, () => Promise.resolve(promoteTreeSync(request, io)));
}

// ─── Directory-copy adapter (production `copyDir` seam) ───────────────────────

/**
 * Atomically copy the tree at `src` into `dest`, replacing `dest`'s contents.
 *
 * This is the drop-in for the `copyDir(src, dest)` seam the skills installer uses
 * (`installSkills` in the repo-root `src/install-skills.ts`, reached via the
 * onboard install step). The stock default is a bare `fs.cpSync(src, dest,
 * { recursive: true })`, which — because the caller `rmSync`s `dest` first — can
 * leave `dest` half-populated if the copy fails partway (the exact EFF-009 torn
 * state). Routing through {@link promoteTreeSync} makes the copy atomic: `dest`
 * is either absent or the complete new tree, and a re-run converges.
 *
 * Reads UTF-8 text (skills / command-alias trees). The source is read into
 * content entries, then staged + verified + promoted into `dest`.
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
