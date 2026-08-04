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

import { atomicWriteFile, publishTempFileSync } from '../utils/atomic-write.js';
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
} from '../core/effect-carrier.js';

// ─── Errors ───────────────────────────────────────────────────────────────────

export type PromotionErrorCode =
  | 'STAGE_INCOMPLETE'
  | 'PROMOTE_FAILED'
  | 'RECOVERY_FAILED';

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
}

/** The default IO, backed by synchronous `node:fs`. */
export function defaultPromotionIo(): PromotionIo {
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
      publishTempFileSync(from, to);
    },
    removeTree: (target) => {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
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

function writeJournal(plan: StagePlan): void {
  const journal: PromotionJournal = {
    target: plan.target,
    stagingDir: plan.stagingDir,
    backupDir: plan.backupDir,
    journalPath: plan.journalPath,
  };
  // Journal writes reuse the EFF-008 single-file atomic writer directly (not the
  // IO seam) — a torn journal would be as bad as a torn promotion, and the IO
  // seam's fault-injection is aimed at the tree, not its own recovery record.
  atomicWriteFile(plan.journalPath, JSON.stringify(journal));
}

function readJournal(plan: StagePlan, io: PromotionIo): PromotionJournal | undefined {
  if (!io.exists(plan.journalPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(io.readFile(plan.journalPath).toString('utf8'));
  } catch {
    return undefined;
  }
  return isPromotionJournal(parsed) ? parsed : undefined;
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
    io.rename(journal.backupDir, journal.target); // restore OLD — may throw (double-fault)
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
  const journal = readJournal(plan, io);
  if (journal === undefined) return false;
  recoverFromJournal(journal, io);
  return true;
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
}

function stageEntries(plan: StagePlan, entries: readonly DigestEntry[], io: PromotionIo): void {
  io.mkdirp(plan.stagingDir);
  for (const entry of entries) {
    const rel = entry.path.replace(/\\/g, '/');
    const full = path.join(plan.stagingDir, ...rel.split('/'));
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
 */
function commitPromotion(plan: StagePlan, io: PromotionIo): void {
  try {
    writeJournal(plan);
    if (io.exists(plan.target)) {
      io.rename(plan.target, plan.backupDir);
    }
    io.rename(plan.stagingDir, plan.target); // COMMIT POINT — atomic
  } catch (err) {
    try {
      recoverFromJournal(readJournal(plan, io) ?? journalFromPlan(plan), io);
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
 *   0. RECOVER any journal from a prior interrupted attempt (idempotent retry).
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

  const expected = digestTree(request.entries);

  // 1–2. Stage + verify. A failure here must leave the target untouched.
  try {
    // Clear any orphan scaffolding a prior run left behind. `recoverInterrupted-
    // Promotion` above already consumed any journal-tracked backup (restoring or
    // finalizing the target), so a backup dir remaining HERE is stale garbage
    // from a promotion whose best-effort cleanup was interrupted after commit.
    // It must go before `commitPromotion` renames `target → backup`, or that
    // rename collides with the pre-existing directory (a persistent EPERM on
    // Windows, ENOTEMPTY/EEXIST elsewhere).
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
  commitPromotion(plan, io);

  return {
    target: request.target,
    treeDigest: expected,
    promoted: true,
    recoveredPriorAttempt,
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
