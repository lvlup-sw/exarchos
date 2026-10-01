/**
 * Shared MCP JSON config writer, a read-modify-write for runtimes that keep MCP server config in a JSON file.
 * Examples are `.vscode/mcp.json` and `.cursor/mcp.json`. Each concrete writer sets only its directory and runtime name.
 *
 * The module also owns {@link promoteConfigFile}, the single-file promotion for config files.
 * `claude-code.ts` publishes `~/.claude.json` through the same function, so the three config files share one implementation.
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

/**
 * Narrow fs surface for tests.
 * The optional members add temp-file cleanup and the directory fsync to a publish.
 * An injected fs without them still gets an atomic rename, without those two steps. {@link DEFAULT_FS} supplies all members.
 */
export interface McpJsonWriterFs {
  readFile(p: string, enc: BufferEncoding): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
  rename(src: string, dst: string): Promise<void>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  /** Delete a file. Enables temp/journal/backup cleanup. Optional. */
  remove?(p: string): Promise<void>;
  /** fsync the parent directory, so the entry from a rename is durable. Optional. */
  syncDirectory?(dir: string): Promise<DirectorySyncOutcome>;
}

export interface McpJsonWriterDeps {
  readonly fs?: McpJsonWriterFs;
  /**
   * Filesystem seam for {@link recoverInterruptedConfigPromotions}.
   * It defaults to the real filesystem, because an interrupted promotion is a fact about the host.
   */
  readonly promotionIo?: PromotionIo;
}

const EXARCHOS_MCP_ENTRY = {
  command: 'npx',
  args: ['-y', '@anthropic-ai/claude-code', '--mcp-server-name=exarchos'],
  type: 'stdio',
} as const;

const DEFAULT_FS: McpJsonWriterFs = {
  readFile: (p, enc) => nodeFs.readFile(p, enc),
  /**
   * Writes and fsyncs the file, because a promotion must not verify and publish bytes that are only in the page cache.
   * `fs.promises.writeFile` does not fsync, so the function opens the handle itself.
   */
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

/**
 * Scaffolding paths for a single-file config promotion.
 * `journalPath` and `backupPath` must equal what the private `stagePlanFor` in `install/atomic-promotion.ts` derives.
 * The real `recoverInterruptedPromotion` reads this journal, and a test pins the coupling.
 *
 * `stagePath` is unique per attempt (`<pid>.<random>`). With a fixed name, two writers of the same config collide on the staged copy.
 * The paths use POSIX joins, so `dirname` of each path equals `parent` exactly. {@link afterDurable} compares those strings.
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
 * The async filesystem seam for a config promotion. The optional members are durability capabilities.
 * A seam without them, such as an in-memory test fs, gets the same algorithm without the fsyncs.
 * The result is atomic, but its durability is unproven, and the report says `not-applicable`.
 */
export interface ConfigPromotionFs {
  /** Read a file as UTF-8. Rejects with an ENOENT-shaped error when absent. */
  readFile(p: string): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  /** fsync a just-written FILE, publishing its BYTES. Optional. */
  fsyncFile?(p: string): Promise<void>;
  /** fsync a directory, which makes the name from a rename durable. Optional. */
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
 * The outcome of the parent-directory fsync, or `not-applicable` when the seam cannot do one.
 * `not-applicable` is a separate state from `unsupported`, which means that the host declined a real fsync.
 * Win32 declines with `EPERM`. A missing capability thus stays distinct from a degraded platform.
 */
export type ConfigDurability = DirectorySyncOutcome | DurabilityNotApplicable;

/** A completed publish step, with the durability that it proved. */
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
  /** Outcome of the parent-directory fsync after the commit rename. */
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
 * Promotes one config file. It reuses {@link publishTempFile}, and the journal format and recovery engine of `install/atomic-promotion.ts`.
 * 1. Stage: write the new content to a unique sibling file and fsync it. A failure here leaves the live config unchanged.
 * 2. Verify: read the staged copy back and compare it, so a short or torn write never goes live.
 * 3. Journal: record the paths, so the real recovery engine can finish an interrupted promotion.
 * 4. Backup: copy the old config aside. A rename leaves a moment with no config file, so the function copies it.
 * 5. Commit: rename the staged copy onto the target in one atomic step, then fsync the parent directory.
 * Each step waits for the durability of the previous step through {@link afterDurable}.
 * On a failure after the stage, journal-driven recovery restores a complete file. A failed recovery leaves the journal for the next run.
 * The function does not repair an earlier interruption. Callers run {@link recoverInterruptedConfigPromotions} before they read the config.
 */
export async function promoteConfigFile(
  target: string,
  content: string,
  fs: ConfigPromotionFs,
  options: ConfigPromotionOptions = {},
): Promise<ConfigPromotionReport> {
  const paths = configPromotionPaths(target, options.stagePath);
  await fs.mkdir(paths.parent, { recursive: true });

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
    try {
      recoverInterruptedConfigPromotions([paths.target], options.io);
    } catch {
    }
    await bestEffortRemove(fs, paths.stagePath);
    throw new PromotionError(
      'PROMOTE_FAILED',
      `failed to promote ${paths.target}`,
      { cause: err },
    );
  }

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
 * Publishes through {@link publishTempFile}, with the `unlink` and `syncDirectory` capabilities of the seam when it has them.
 * It returns the observed directory-fsync outcome, or `not-applicable`.
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
 * Checks the durability of a step before the next step starts, through the exported {@link afterDurable}.
 * It skips the check when the seam proved nothing, because a passing check without proof is false.
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

/** Removes a file when the seam can. A failure here never hides the real failure. */
async function bestEffortRemove(fs: ConfigPromotionFs, p: string): Promise<void> {
  if (!fs.remove) return;
  try {
    await fs.remove(p);
  } catch {
  }
}

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
 * Startup and doctor entry point for `recoverInterruptedPromotion` on the config files.
 * The writers of these files call it before they read the existing config, also on a path that then skips the write.
 * When nothing was interrupted, it costs one `exists()` on the journal path, so it is safe as an unconditional first step.
 *
 * `io` defaults to the real filesystem, also when the fs of the writer is in memory. An interrupted promotion is a fact about the host.
 * For a path that does not exist on the host, the journal cannot exist, so the call does nothing.
 * It never throws. It reports each failure in {@link ConfigRecoveryReport.failures} and leaves the journal for the next run.
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

/**
 * Base config writer for runtimes that use a JSON file containing
 * `{ mcpServers: { ... } }`. Subclasses set `runtime` and `configDir`
 * (relative to project root).
 */
export abstract class McpJsonWriter implements RuntimeConfigWriter {
  abstract readonly runtime: AgentRuntimeName;
  /** Directory relative to the project root, such as `.vscode` or `.cursor`. */
  protected abstract readonly configDir: string;

  protected readonly fs: McpJsonWriterFs;
  protected readonly promotionIo: PromotionIo | undefined;

  constructor(deps?: McpJsonWriterDeps) {
    this.fs = deps?.fs ?? DEFAULT_FS;
    this.promotionIo = deps?.promotionIo;
  }

  /**
   * Recovers an interrupted promotion before it reads the existing config, because a merge over an interrupted state uses the wrong base.
   * It then sets the `exarchos` entry in `mcpServers` and publishes through {@link promoteConfigFile}.
   */
  async write(_deps: WriterDeps, options: WriteOptions): Promise<ConfigWriteResult> {
    const dirPath = toPosix(join(options.projectRoot, this.configDir));
    const configPath = toPosix(join(dirPath, 'mcp.json'));

    const recovery = recoverInterruptedConfigPromotions(
      [configPath],
      this.promotionIo,
    );

    await this.fs.mkdir(dirPath, { recursive: true });

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

    const mcpServers =
      typeof existing.mcpServers === 'object' && existing.mcpServers !== null
        ? { ...(existing.mcpServers as Record<string, unknown>) }
        : {};
    mcpServers.exarchos = { ...EXARCHOS_MCP_ENTRY };

    const merged = { ...existing, mcpServers };
    const content = JSON.stringify(merged, null, 2) + '\n';

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

export function isMissingPathError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code?: string }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
