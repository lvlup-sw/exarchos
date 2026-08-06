/**
 * Shared MCP JSON config writer — read-modify-write pattern for runtimes
 * that store MCP server config in a JSON file (e.g. `.vscode/mcp.json`,
 * `.cursor/mcp.json`).
 *
 * Extracted to eliminate duplication between CopilotWriter and CursorWriter.
 * Each concrete writer specifies only its target directory and runtime name.
 *
 * This module also owns the SINGLE-FILE config promotion the spec-named config
 * files share (DR-18) — see the section docstring on {@link promoteConfigFile}.
 * `claude-code.ts` publishes `~/.claude.json` through the same primitive, so the
 * three spec-named config files (`~/.claude.json`, `.vscode/mcp.json`,
 * `.cursor/mcp.json`) have ONE promotion implementation between them rather than
 * three tmp+rename open-codings.
 */

import { basename, dirname, join } from 'node:path';
import * as crypto from 'node:crypto';
import { promises as nodeFs } from 'node:fs';
import { toPosix } from '../../../utils/paths.js';
import type { ConfigWriteResult } from '../schema.js';
import type { AgentRuntimeName } from '../../../runtime/agent-environment-detector.js';
import type { RuntimeConfigWriter, WriteOptions } from './writer.js';
import type { WriterDeps } from '../probes.js';
import {
  fsyncDir,
  publishTempFile,
  type DirectorySyncOutcome,
  type PublishIo,
} from '../../../utils/atomic-write.js';
import {
  afterDurable,
  defaultPromotionIo,
  recoverInterruptedPromotion,
  PromotionError,
  type PromotionIo,
} from '../../../install/atomic-promotion.js';

// ─── Shared types ───────────────────────────────────────────────────────────

/**
 * Narrow fs surface for testability.
 *
 * The four required members are the original seam. The optional members are the
 * DR-16/DR-18 widening T-23 could not reach from `utils/atomic-write.ts`: this
 * writer injected `{ rename }` and nothing else, so its publish got an atomic
 * rename whose directory entry was never forced and whose failed temp file was
 * never cleaned up. An injected fs that cannot express those steps simply omits
 * them and gets exactly the guarantee it had before (see the `PublishIo`
 * docstring in `utils/atomic-write.ts`); {@link DEFAULT_FS} — the production
 * seam — supplies all of them.
 */
export interface McpJsonWriterFs {
  readFile(p: string, enc: BufferEncoding): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
  rename(src: string, dst: string): Promise<void>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  /** Delete a file. Enables temp/journal/backup cleanup. Optional. */
  remove?(p: string): Promise<void>;
  /** fsync the parent DIRECTORY so a rename's entry is durable (DR-16). Optional. */
  syncDirectory?(dir: string): Promise<DirectorySyncOutcome>;
}

export interface McpJsonWriterDeps {
  readonly fs?: McpJsonWriterFs;
  /**
   * Filesystem seam for the DR-18 recovery entry point
   * ({@link recoverInterruptedConfigPromotions}). Defaults to the real
   * filesystem, because an interrupted promotion is a fact about the HOST — see
   * that function's docstring.
   */
  readonly promotionIo?: PromotionIo;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const EXARCHOS_MCP_ENTRY = {
  command: 'npx',
  args: ['-y', '@anthropic-ai/claude-code', '--mcp-server-name=exarchos'],
  type: 'stdio',
} as const;

const DEFAULT_FS: McpJsonWriterFs = {
  readFile: (p, enc) => nodeFs.readFile(p, enc),
  // Durable by construction: a staged copy whose bytes are still only in the page
  // cache is not something a promotion may verify and then publish.
  // `fs.promises.writeFile` does not fsync, so the handle is opened explicitly.
  writeFile: async (p, data) => {
    const handle = await nodeFs.open(p, 'w');
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: (src, dst) => nodeFs.rename(src, dst),
  mkdir: (p, opts) => nodeFs.mkdir(p, opts).then(() => undefined),
  remove: (p) => nodeFs.rm(p, { force: true, maxRetries: 10, retryDelay: 50 }),
  syncDirectory: (dir) => fsyncDir(dir),
};

// ─── Config-file promotion (DR-18) ──────────────────────────────────────────

/**
 * Scaffolding paths for a single-file config promotion.
 *
 * `journalPath` and `backupPath` are byte-identical to what
 * `install/atomic-promotion.ts`'s (private) `stagePlanFor` derives, because the
 * journal written here is consumed by the REAL `recoverInterruptedPromotion`
 * rather than by a re-implementation. That coupling is a genuine risk — the
 * derivation is private over there — so it is pinned by a test that drives the
 * real recovery function against a journal this module wrote.
 *
 * `stagePath` is UNIQUE PER ATTEMPT (`<pid>.<random>`). A fixed staged-copy name
 * is a bug, not a detail: two writers publishing the same config collide on it,
 * and the loser either publishes the winner's bytes or fails a publish whose
 * source another process already consumed.
 *
 * Built with POSIX joins rather than `path.join` so `path.dirname(x)` round-trips
 * to `parent` exactly — {@link afterDurable} compares those strings, and on
 * Windows `path.join` normalizes to backslashes while `dirname` of a
 * forward-slash path does not.
 */
export interface ConfigPromotionPaths {
  readonly target: string;
  readonly parent: string;
  /** The staged copy. Unique per attempt unless the caller overrides it. */
  readonly stagePath: string;
  readonly backupPath: string;
  readonly journalPath: string;
}

/** Derive the scaffolding paths for a single-file promotion of `target`. */
export function configPromotionPaths(
  target: string,
  stagePath?: string,
): ConfigPromotionPaths {
  const normalized = toPosix(target);
  const parent = dirname(normalized);
  const base = basename(normalized);
  return {
    target: normalized,
    parent,
    stagePath:
      stagePath === undefined
        ? `${parent}/.${base}.exarchos-stage.${uniqueSuffix()}`
        : toPosix(stagePath),
    backupPath: `${parent}/.${base}.exarchos-backup`,
    journalPath: `${parent}/.${base}.exarchos-promote.json`,
  };
}

function uniqueSuffix(): string {
  return `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * The async filesystem seam a config promotion runs on.
 *
 * Required members are what every writer's injected fs already has. The optional
 * members are DURABILITY CAPABILITIES: a seam that cannot express them (an
 * in-memory test fs, or `WriterFs` from `../probes.js`, which this module may not
 * widen) omits them and gets the same algorithm minus the fsyncs — atomic, but
 * with durability unproven. That is the pattern `utils/atomic-write.ts` already
 * documents for `PublishIo.syncDirectory`, and it is not a silent downgrade: the
 * report says `not-applicable`, so the absence is visible to the caller.
 */
export interface ConfigPromotionFs {
  /** Read a file as UTF-8. Rejects with an ENOENT-shaped error when absent. */
  readFile(p: string): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  /** fsync a just-written FILE, publishing its BYTES. Optional. */
  fsyncFile?(p: string): Promise<void>;
  /** fsync a DIRECTORY, publishing a rename's NAME (DR-16). Optional. */
  syncDirectory?(dir: string): Promise<DirectorySyncOutcome>;
  /** Delete a file — temp/journal/backup cleanup. Optional. */
  remove?(p: string): Promise<void>;
}

/** "This seam has no way to prove the directory entry is on stable storage." */
export interface DurabilityNotApplicable {
  readonly directory: string;
  readonly status: 'not-applicable';
}

/**
 * How the parent-directory fsync fared, or that the seam has no way to do one.
 *
 * `not-applicable` is deliberately a THIRD state rather than being folded into
 * `unsupported`: `unsupported` means the HOST declined a real fsync (win32
 * reports `EPERM`), and reporting "the injected fs has no syncDirectory" as
 * `unsupported` would make a missing capability indistinguishable from a
 * degraded platform.
 */
export type ConfigDurability = DirectorySyncOutcome | DurabilityNotApplicable;

/** A completed publish step plus the durability it could prove. */
interface ConfigPublishStep {
  readonly published: string;
  readonly durability: ConfigDurability;
}

export interface ConfigPromotionReport {
  readonly target: string;
  /** The staged copy this attempt used — unique per attempt by default. */
  readonly stagePath: string;
  /** True once the NEW content is in place. */
  readonly promoted: boolean;
  /** True when an existing config was copied aside before the commit. */
  readonly backedUp: boolean;
  /** DR-16 outcome for the COMMIT rename's parent-directory fsync. */
  readonly directoryDurability: ConfigDurability;
}

export interface ConfigPromotionOptions {
  /**
   * Override the staged copy's path. Exists for `~/.claude.json`, whose staged
   * copy must stay at `<target>.tmp` — see `claude-code.ts`.
   */
  readonly stagePath?: string;
  /** Seam for the in-line recovery a failed commit runs. Defaults to the real fs. */
  readonly io?: PromotionIo;
}

/**
 * THE SINGLE-FILE ANALOGUE OF `install/atomic-promotion.ts`.
 *
 * `promoteTreeSync` promotes a DIRECTORY: it stages into a sibling staging
 * *directory* and commits with `rename(stagingDir → target)`. Pointing it at
 * `~/.claude.json` would replace the user's config FILE with a DIRECTORY, so it
 * is not the reuse this case wants. What the config writers reuse instead is the
 * layer underneath — `utils/atomic-write.ts`'s {@link publishTempFile} — plus the
 * promotion module's JOURNAL FORMAT and its {@link recoverInterruptedPromotion}
 * recovery engine, which are file/tree agnostic (`exists`, `rename`, `removeTree`
 * all work on a plain file).
 *
 * The sequence, and what each failure leaves behind:
 *
 *   1. STAGE   — the new content is written to a sibling staged copy and fsync'd.
 *                The live config is untouched, so any failure here leaves it OLD.
 *   2. VERIFY  — the staged copy is read back and compared to the requested bytes.
 *                A short write (ENOSPC), a torn write, or a concurrent writer that
 *                clobbered the staged copy is caught HERE, before anything is
 *                published. This is the step the old writers had no analogue of:
 *                they wrote and renamed, so a truncated temp file became the live
 *                config.
 *   3. JOURNAL — the scaffolding paths are recorded, in the format and at the path
 *                `install/atomic-promotion.ts` derives, so an interruption is
 *                recoverable by the REAL recovery engine (see
 *                {@link recoverInterruptedConfigPromotions}).
 *   4. BACKUP  — the old config is COPIED aside (not renamed away). This is the one
 *                deliberate divergence from the tree engine, and it is load-bearing:
 *                `rename(target → backup)` would open a window where the user has NO
 *                config at all, which a single-file publish does not otherwise have.
 *                Copying keeps "the config file always exists" true at every instant
 *                while still leaving a complete previous version to recover from.
 *   5. COMMIT  — one atomic `rename(staged → target)`, retried through
 *                {@link publishTempFile} for Windows' concurrent-replace race, then
 *                the parent directory is fsync'd so the new NAME is durable too.
 *
 * Every step is ordered against the previous one's directory fsync via the
 * exported {@link afterDurable} guard (DR-16), not merely by statement order.
 *
 * RECOVERY IS NOT DONE HERE. The writers call
 * {@link recoverInterruptedConfigPromotions} before they read the existing config,
 * because a read-modify-write that reads BEFORE recovery merges into the wrong
 * base and then publishes it — the recovered file would be immediately
 * overwritten by a config built from the interrupted state.
 */
export async function promoteConfigFile(
  target: string,
  content: string,
  fs: ConfigPromotionFs,
  options: ConfigPromotionOptions = {},
): Promise<ConfigPromotionReport> {
  const paths = configPromotionPaths(target, options.stagePath);
  await fs.mkdir(paths.parent, { recursive: true });

  // 1–2. STAGE + VERIFY. A failure here must leave the live config untouched.
  try {
    await writeDurable(fs, paths.stagePath, content);
    const staged = await fs.readFile(paths.stagePath);
    if (staged !== content) {
      throw new PromotionError(
        'STAGE_INCOMPLETE',
        `staged copy of ${paths.target} does not match the requested content`,
      );
    }
  } catch (err) {
    await bestEffortRemove(fs, paths.stagePath);
    if (err instanceof PromotionError) throw err;
    throw new PromotionError(
      'STAGE_INCOMPLETE',
      `failed to stage ${paths.target}`,
      { cause: err },
    );
  }

  // 3–5. JOURNAL → BACKUP → COMMIT, each ordered against the previous step's
  // durable directory entry rather than against its line number.
  let directoryDurability: ConfigDurability = notApplicable(paths.parent);
  let backedUp = false;
  try {
    const journal = await publishConfigStep(
      fs,
      paths.journalPath,
      JSON.stringify(journalRecord(paths)),
    );
    afterDurableConfig(journal, paths.parent);

    const existing = await readIfPresent(fs, paths.target);
    if (existing !== undefined) {
      const backup = await publishConfigStep(fs, paths.backupPath, existing);
      afterDurableConfig(backup, paths.parent);
      backedUp = true;
    }

    directoryDurability = await publishStaged(fs, paths.stagePath, paths.target);
  } catch (err) {
    // Bring the destination back to a complete state. Driven by the journal, so
    // it restores the backup when the commit lost the target and finalizes
    // otherwise. A recovery that itself fails deliberately leaves the journal in
    // place for the next startup entry point to consume.
    try {
      recoverInterruptedConfigPromotions([paths.target], options.io);
    } catch {
      /* leave the journal for a retry — never mask the original failure */
    }
    await bestEffortRemove(fs, paths.stagePath);
    throw new PromotionError(
      'PROMOTE_FAILED',
      `failed to promote ${paths.target}`,
      { cause: err },
    );
  }

  // Committed: the destination is fully NEW. Finalize is best-effort and must
  // never throw — a leftover backup is still a complete destination.
  await bestEffortRemove(fs, paths.backupPath);
  await bestEffortRemove(fs, paths.journalPath);

  return {
    target: paths.target,
    stagePath: paths.stagePath,
    promoted: true,
    backedUp,
    directoryDurability,
  };
}

/** The journal record — exactly the shape `install/atomic-promotion.ts` reads. */
function journalRecord(paths: ConfigPromotionPaths): Record<string, string> {
  return {
    target: paths.target,
    stagingDir: paths.stagePath,
    backupDir: paths.backupPath,
    journalPath: paths.journalPath,
  };
}

/** Write `content` to a unique temp file, then publish it atomically onto `target`. */
async function publishConfigStep(
  fs: ConfigPromotionFs,
  target: string,
  content: string,
): Promise<ConfigPublishStep> {
  const tmp = `${target}.${uniqueSuffix()}.tmp`;
  await writeDurable(fs, tmp, content);
  return { published: target, durability: await publishStaged(fs, tmp, target) };
}

/**
 * The publish itself — `utils/atomic-write.ts`'s {@link publishTempFile}, now
 * injected with the `unlink` and `syncDirectory` capabilities T-23 recorded as
 * missing from these writers, instead of a bare `{ rename }`.
 */
async function publishStaged(
  fs: ConfigPromotionFs,
  from: string,
  to: string,
): Promise<ConfigDurability> {
  const remove = fs.remove;
  const syncDirectory = fs.syncDirectory;
  let observed: ConfigDurability = notApplicable(dirname(to));
  const io: PublishIo = {
    rename: (f, t) => fs.rename(f, t),
    ...(remove ? { unlink: (p: string) => remove(p) } : {}),
    ...(syncDirectory
      ? {
          syncDirectory: async (d: string): Promise<DirectorySyncOutcome> => {
            const outcome = await syncDirectory(d);
            observed = outcome;
            return outcome;
          },
        }
      : {}),
  };
  await publishTempFile(from, to, io);
  return observed;
}

/**
 * Consume a step's durability before starting the next one — the async analogue
 * of the tree engine's barrier threading, delegating the actual check to the
 * exported {@link afterDurable} so there is ONE implementation of "this rename's
 * entry is durable in the directory I am about to write into".
 *
 * Skipped when the seam could not prove anything: there is nothing to check, and
 * inventing a passing barrier would be durability theatre.
 */
function afterDurableConfig(step: ConfigPublishStep, directory: string): void {
  if (step.durability.status === 'not-applicable') return;
  afterDurable({ published: step.published, directory: step.durability }, directory);
}

function notApplicable(directory: string): DurabilityNotApplicable {
  return { directory, status: 'not-applicable' };
}

async function writeDurable(
  fs: ConfigPromotionFs,
  p: string,
  content: string,
): Promise<void> {
  await fs.writeFile(p, content);
  if (fs.fsyncFile) await fs.fsyncFile(p);
}

async function readIfPresent(
  fs: ConfigPromotionFs,
  p: string,
): Promise<string | undefined> {
  try {
    return await fs.readFile(p);
  } catch (err: unknown) {
    if (isMissingPathError(err)) return undefined;
    throw err;
  }
}

async function bestEffortRemove(fs: ConfigPromotionFs, p: string): Promise<void> {
  if (!fs.remove) return;
  try {
    await fs.remove(p);
  } catch {
    /* best-effort — never mask a real failure */
  }
}

// ─── The startup / doctor recovery entry point (DR-18) ──────────────────────

export interface ConfigRecoveryFailure {
  readonly target: string;
  readonly error: string;
}

export interface ConfigRecoveryReport {
  readonly checked: readonly string[];
  /** Targets that had a journal from an interrupted promotion and were repaired. */
  readonly recovered: readonly string[];
  /** Targets whose repair itself failed — the journal is left for a later run. */
  readonly failures: readonly ConfigRecoveryFailure[];
}

/**
 * THE STARTUP/DOCTOR ENTRY POINT for `recoverInterruptedPromotion` on the
 * spec-named config files (DR-18's second acceptance criterion).
 *
 * Called at the head of every config writer — before the existing config is read
 * — so it runs on every path that reaches `getAllWriters()`: `onboard`'s GENERATE
 * stage and `doctor --fix`. It runs even when the write itself will be SKIPPED
 * (`~/.claude.json` with exarchos already registered), which is exactly the case
 * a recovery call buried inside the write path would miss.
 *
 * It is a no-op — one `exists()` on the journal path — when nothing was
 * interrupted, which is why it is safe as an unconditional first step.
 *
 * `io` defaults to the REAL filesystem even when the writer's own fs seam is an
 * injected in-memory one: an interrupted promotion is a fact about the host, and
 * there is no meaningful recovery of a machine other than the one running. For a
 * synthetic path (no such directory on the host) the journal cannot exist, so the
 * call is inert.
 *
 * Never throws. A startup repair that aborts onboarding is worse than one that
 * reports; failures are surfaced in {@link ConfigRecoveryReport.failures} and
 * propagated to the writer's `warnings`, and the journal survives so the next run
 * retries.
 */
export function recoverInterruptedConfigPromotions(
  targets: readonly string[],
  io: PromotionIo = defaultPromotionIo(),
): ConfigRecoveryReport {
  const checked: string[] = [];
  const recovered: string[] = [];
  const failures: ConfigRecoveryFailure[] = [];
  for (const target of targets) {
    const normalized = toPosix(target);
    checked.push(normalized);
    try {
      if (recoverInterruptedPromotion(normalized, io)) recovered.push(normalized);
    } catch (err: unknown) {
      failures.push({
        target: normalized,
        error:
          `Failed to recover an interrupted config promotion for ${normalized}: ` +
          String(err),
      });
    }
  }
  return { checked, recovered, failures };
}

// ─── Base class ─────────────────────────────────────────────────────────────

/**
 * Base config writer for runtimes that use a JSON file containing
 * `{ mcpServers: { ... } }`. Subclasses set `runtime` and `configDir`
 * (relative to project root).
 */
export abstract class McpJsonWriter implements RuntimeConfigWriter {
  abstract readonly runtime: AgentRuntimeName;
  /** Directory relative to project root (e.g. '.vscode', '.cursor'). */
  protected abstract readonly configDir: string;

  protected readonly fs: McpJsonWriterFs;
  protected readonly promotionIo: PromotionIo | undefined;

  constructor(deps?: McpJsonWriterDeps) {
    this.fs = deps?.fs ?? DEFAULT_FS;
    this.promotionIo = deps?.promotionIo;
  }

  async write(_deps: WriterDeps, options: WriteOptions): Promise<ConfigWriteResult> {
    const dirPath = toPosix(join(options.projectRoot, this.configDir));
    const configPath = toPosix(join(dirPath, 'mcp.json'));

    // DR-18: recover any interrupted promotion BEFORE reading the existing
    // config — a read-modify-write over an interrupted state merges the wrong
    // base and publishes it. See `recoverInterruptedConfigPromotions`.
    const recovery = recoverInterruptedConfigPromotions(
      [configPath],
      this.promotionIo,
    );

    // Ensure target directory exists
    await this.fs.mkdir(dirPath, { recursive: true });

    // Read existing config or start fresh
    let existing: Record<string, unknown> = {};
    try {
      const raw = await this.fs.readFile(configPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        existing = parsed as Record<string, unknown>;
      }
    } catch (err: unknown) {
      if (!isMissingPathError(err)) throw err;
    }

    // Merge exarchos MCP entry
    const mcpServers =
      typeof existing.mcpServers === 'object' && existing.mcpServers !== null
        ? { ...(existing.mcpServers as Record<string, unknown>) }
        : {};
    mcpServers.exarchos = { ...EXARCHOS_MCP_ENTRY };

    const merged = { ...existing, mcpServers };
    const content = JSON.stringify(merged, null, 2) + '\n';

    // DR-18: stage → verify → journal → backup → commit, in place of the former
    // fixed-name tmp write + bare rename.
    await promoteConfigFile(configPath, content, adaptWriterFs(this.fs), {
      ...(this.promotionIo ? { io: this.promotionIo } : {}),
    });

    const warnings = recovery.failures.map((f) => f.error);
    return {
      runtime: this.runtime,
      status: 'written',
      componentsWritten: ['mcp-config'],
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}

/** Adapt the writer's own fs seam to the promotion seam (capabilities carried through). */
function adaptWriterFs(fs: McpJsonWriterFs): ConfigPromotionFs {
  const remove = fs.remove;
  const syncDirectory = fs.syncDirectory;
  return {
    readFile: (p) => fs.readFile(p, 'utf8'),
    writeFile: (p, data) => fs.writeFile(p, data),
    rename: (from, to) => fs.rename(from, to),
    mkdir: (p, opts) => fs.mkdir(p, opts),
    ...(remove ? { remove: (p: string) => remove(p) } : {}),
    ...(syncDirectory
      ? { syncDirectory: (d: string) => syncDirectory(d) }
      : {}),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function isMissingPathError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code?: string }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
