/**
 * Claude Code RuntimeConfigWriter — deploys exarchos MCP server config,
 * commands, and skills to ~/.claude/.
 *
 * Three deployment phases:
 *   1. MCP config — read-modify-write ~/.claude.json with merge semantics
 *   2. Commands — copy project commands/ to ~/.claude/commands/
 *   3. Skills — copy project skills/claude-code/ to ~/.claude/skills/
 *
 * Each phase is independent; a skipped MCP config does not block content
 * deployment. Atomic writes via tmp+rename prevent partial writes on crash.
 */

import { join, dirname } from 'node:path';
import { existsSync as fsExistsSync, promises as nodeFs } from 'node:fs';
import { toPosix } from '../../../utils/paths.js';
import type { WriterDeps, WriterFs } from '../probes.js';
import type { ConfigWriteResult } from '../schema.js';
import type { RuntimeConfigWriter, WriteOptions } from './writer.js';
import { deployOnrampBlocks } from './onramp-block.js';
import { fsyncDir, publishTempFile } from '../../../utils/atomic-write.js';
import type { PromotionIo } from '../../../install/atomic-promotion.js';
import {
  promoteConfigFile,
  recoverInterruptedConfigPromotions,
  type ConfigPromotionFs,
} from './mcp-json-writer.js';

/** MCP server entry shape in ~/.claude.json */
interface McpServerEntry {
  readonly type: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

interface ClaudeConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

// ─── Atomic write helper ──────────────────────────────────────────────────

/**
 * Write JSON to disk atomically: serialize → write to `${path}.tmp` →
 * rename to `${path}`.
 *
 * SUPERSEDED by {@link promoteConfigFile} (DR-18) — a bare tmp+rename has no
 * stage/verify, no journal, no backup and no recovery, which is the whole of the
 * defect DR-18 exists to remove. `deployMcpConfig` no longer calls it. It is
 * retained ONLY because `claude-code.test.ts` pins it directly, and that file is
 * outside this change's declared scope; it should be deleted together with the
 * two `AtomicWriteJson_*` tests.
 */
export async function atomicWriteJson(
  deps: WriterDeps,
  path: string,
  data: unknown,
): Promise<void> {
  const tmp = `${path}.tmp`;
  const serialized = JSON.stringify(data, null, 2);
  await deps.fs.writeFile(tmp, serialized);
  await publishTempFile(tmp, path, { rename: (from, to) => deps.fs.rename(from, to) });
}

// ─── The DR-18 promotion seam for ~/.claude.json ──────────────────────────

/**
 * The path of the Claude Code CLI config. One derivation, used by the writer,
 * by the recovery entry point, and by tests.
 */
export function claudeConfigPath(home: string): string {
  return toPosix(join(home, '.claude.json'));
}

/**
 * Build the {@link ConfigPromotionFs} `~/.claude.json` is promoted through.
 *
 * The bytes go through the writer's own `deps.fs` seam, unchanged — that seam is
 * how every existing caller (and every existing test) steers this writer, and
 * routing the write around it would make the injected fs a lie.
 *
 * `WriterFs` (declared in `../probes.js`, shared by every writer and outside this
 * change's scope) cannot express an fsync or a delete. T-23 recorded exactly this
 * gap. The three durability capabilities are therefore supplied HERE, from
 * `node:fs`, and only when the config's parent directory actually exists on the
 * HOST. That condition is not a test-detection hack, it is the precondition the
 * capabilities need to mean anything: an injected in-memory `WriterFs` writes to
 * paths the host has never heard of, so fsyncing them would throw ENOENT and
 * deleting them would either no-op or — worse — hit an unrelated host file.
 * Absent capabilities degrade exactly as `utils/atomic-write.ts` documents:
 * still atomic, durability reported as `not-applicable` rather than assumed.
 *
 * In production the parent is `$HOME`, so the capabilities are always present.
 */
function claudeConfigPromotionFs(deps: WriterDeps, configPath: string): ConfigPromotionFs {
  const parent = dirname(configPath);
  const hostBacked = fsExistsSync(parent);
  return {
    readFile: (p) => deps.fs.readFile(p),
    writeFile: (p, data) => deps.fs.writeFile(p, data),
    rename: (from, to) => deps.fs.rename(from, to),
    mkdir: (p, opts) => deps.fs.mkdir(p, opts),
    ...(hostBacked
      ? {
          fsyncFile: fsyncHostFile,
          remove: (p: string) =>
            nodeFs.rm(p, { force: true, maxRetries: 10, retryDelay: 50 }),
          syncDirectory: (d: string) => fsyncDir(d),
        }
      : {}),
  };
}

/**
 * fsync a file the seam just wrote, publishing its BYTES.
 *
 * A file that is not on the host was written into an injected in-memory fs;
 * there are no bytes for the kernel to flush, so the step is not applicable
 * rather than failed. Everything else propagates.
 */
async function fsyncHostFile(p: string): Promise<void> {
  if (!fsExistsSync(p)) return;
  const handle = await nodeFs.open(p, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function isMissingPathError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code?: string }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function readExistingConfig(
  deps: WriterDeps,
  configPath: string,
): Promise<{ config: ClaudeConfig | null; error?: string }> {
  let raw: string;
  try {
    raw = await deps.fs.readFile(configPath);
  } catch (err: unknown) {
    if (isMissingPathError(err)) {
      return { config: {} };
    }
    return { config: null, error: `Failed to read ${configPath}: ${String(err)}` };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return { config: null, error: `${configPath} does not contain a JSON object` };
    }
    return { config: parsed as ClaudeConfig };
  } catch {
    return {
      config: null,
      error: `Failed to parse JSON in ${configPath}`,
    };
  }
}

function buildExarchosEntry(home: string): McpServerEntry {
  return {
    type: 'stdio',
    command: 'node',
    args: [toPosix(join(home, '.claude', 'mcp-servers', 'exarchos-mcp.js'))],
    env: {
      WORKFLOW_STATE_DIR: toPosix(join(home, '.claude', 'workflow-state')),
    },
  };
}

/** Check if a directory exists at the given path. */
async function dirExists(fs: WriterFs, p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch (err: unknown) {
    if (isMissingPathError(err)) return false;
    throw err;
  }
}

/**
 * Copy all files from `srcDir` to `destDir`, creating `destDir` if
 * needed. Non-recursive: copies only top-level files. For skills the
 * layout is deeper, so we use `copyDirRecursive`.
 */
async function copyDirRecursive(
  fs: WriterFs,
  srcDir: string,
  destDir: string,
): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  let entries: string[];
  try {
    entries = await fs.readdir(srcDir);
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const srcPath = toPosix(join(srcDir, entry));
    const destPath = toPosix(join(destDir, entry));
    let isDir = false;
    try {
      const s = await fs.stat(srcPath);
      isDir = s.isDirectory();
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT') continue;
      throw err;
    }
    if (isDir) {
      await copyDirRecursive(fs, srcPath, destPath);
    } else {
      // Ensure parent dir exists for nested structures
      await fs.mkdir(dirname(destPath), { recursive: true });
      await fs.copyFile(srcPath, destPath);
    }
  }
}

// ─── Phase: MCP config ───────────────────────────────────────────────────

async function deployMcpConfig(
  deps: WriterDeps,
  options: WriteOptions,
  promotionIo?: PromotionIo,
): Promise<{ wrote: boolean; error?: string }> {
  const home = deps.home();
  const configPath = claudeConfigPath(home);

  const { config, error } = await readExistingConfig(deps, configPath);
  if (config === null) {
    return { wrote: false, error: error ?? 'Unknown error reading config' };
  }

  const rawServers = config.mcpServers;
  const existingServers = typeof rawServers === 'object' && rawServers !== null && !Array.isArray(rawServers)
    ? rawServers as Record<string, unknown>
    : {};
  const alreadyRegistered = 'exarchos' in existingServers;

  if (alreadyRegistered && !options.forceOverwrite) {
    return { wrote: false };
  }

  const mergedConfig: ClaudeConfig = {
    ...config,
    mcpServers: {
      ...existingServers,
      exarchos: buildExarchosEntry(home),
    },
  };

  // DR-18: stage → verify → journal → backup → commit, replacing the former
  // fixed-name tmp write + bare rename. The merge semantics above and the exact
  // serialization below are unchanged — an atomic writer that atomically writes
  // the wrong content is worse than the bug it fixes.
  //
  // `stagePath` pins the staged copy at the legacy `<target>.tmp` rather than the
  // unique-per-attempt default. `claude-code.test.ts` asserts that exact path and
  // is outside this change's declared files. The stage→VERIFY→publish sequence
  // demotes the shared name from a SAFETY defect to a LIVENESS one: a concurrent
  // writer can only clobber the staged copy BEFORE the verify, which then refuses
  // to publish, so the live config is still old-complete or new-complete under
  // every interleaving — what is lost is the guarantee that both writers succeed.
  // `.vscode/mcp.json` and `.cursor/mcp.json` have nothing pinning their staged
  // copy and use the unique default.
  await promoteConfigFile(
    configPath,
    JSON.stringify(mergedConfig, null, 2),
    claudeConfigPromotionFs(deps, configPath),
    {
      stagePath: `${configPath}.tmp`,
      ...(promotionIo ? { io: promotionIo } : {}),
    },
  );

  return { wrote: true };
}

// ─── Phase: Commands ─────────────────────────────────────────────────────

async function deployCommands(
  deps: WriterDeps,
  options: WriteOptions,
): Promise<boolean> {
  const srcDir = toPosix(join(options.projectRoot, 'commands'));
  if (!(await dirExists(deps.fs, srcDir))) return false;

  const destDir = toPosix(join(deps.home(), '.claude', 'commands'));
  await copyDirRecursive(deps.fs, srcDir, destDir);
  return true;
}

// ─── Phase: Skills ───────────────────────────────────────────────────────

async function deploySkills(
  deps: WriterDeps,
  options: WriteOptions,
): Promise<boolean> {
  // Claude Code skills live under skills/claude-code/ in the project
  const srcDir = toPosix(join(options.projectRoot, 'skills', 'claude-code'));
  if (!(await dirExists(deps.fs, srcDir))) return false;

  const destDir = toPosix(join(deps.home(), '.claude', 'skills'));
  await copyDirRecursive(deps.fs, srcDir, destDir);
  return true;
}

// ─── Phase: on-ramp block (DR-5) ───────────────────────────────────────────

/**
 * The DR-5 on-ramp seam: write the runtime-neutral `AGENTS.md` block plus the
 * `CLAUDE.md` `@AGENTS.md` shim into the consumer project. Injected so tests can
 * steer or stub it; the default writes real files (via `insertManagedBlock`).
 */
export interface OnrampSeam {
  (projectRoot: string): {
    readonly wrote: boolean;
    /**
     * DR-7: the AGENTS.md on-ramp block was NOT put in place (a write error or a
     * missing canonical source) — distinct from a legitimate no-op (`wrote:false,
     * failed:false`, e.g. a synthetic/absent project root). Propagated to the
     * writer's `onrampFailed` so the onboard gate keeps retired hooks in place.
     */
    readonly failed: boolean;
    readonly warnings: readonly string[];
  };
}

/**
 * The production on-ramp seam. Only writes into a project directory that
 * actually exists — the on-ramp files are consumer-owned project files, so a
 * synthetic/absent `projectRoot` (as unit tests use) no-ops rather than
 * attempting a doomed write. The canonical block content is loaded from
 * `binding/standard/block.md`; a missing asset fails open (advisory only).
 */
export const defaultOnrampSeam: OnrampSeam = (projectRoot) => {
  // Absent/synthetic project root → a legitimate no-op, NOT a failure: there is no
  // consumer file to strand, so retired-hook removal (if any) is not gated by it.
  if (!projectRoot || !fsExistsSync(projectRoot)) {
    return { wrote: false, failed: false, warnings: [] };
  }
  return deployOnrampBlocks({ projectRoot });
};

// ─── Compositor ──────────────────────────────────────────────────────────

export async function writeClaudeCode(
  deps: WriterDeps,
  options: WriteOptions,
  onramp: OnrampSeam = defaultOnrampSeam,
  promotionIo?: PromotionIo,
): Promise<ConfigWriteResult> {
  const home = deps.home();
  const configPath = claudeConfigPath(home);
  const componentsWritten: string[] = [];
  const warnings: string[] = [];

  // Phase 0: DR-18 startup/doctor recovery. FIRST, before phase 1 reads the
  // existing config: an interrupted promotion can leave `~/.claude.json` absent
  // with the previous config held in the backup, and a read-modify-write that
  // reads that state merges into an empty base and then publishes it — silently
  // converting a recoverable interruption into permanent data loss. It also has
  // to run ahead of the already-registered SKIP below, which returns before any
  // write happens at all and would otherwise leave the interruption unrepaired.
  //
  // Reached by `onboard`'s GENERATE stage and by `doctor --fix`, both of which
  // drive this writer through `getAllWriters()`.
  const recovery = recoverInterruptedConfigPromotions([configPath], promotionIo);
  warnings.push(...recovery.failures.map((f) => f.error));

  // Phase 1: MCP config
  const mcpResult = await deployMcpConfig(deps, options, promotionIo);
  if (mcpResult.error) {
    return {
      runtime: 'claude-code',
      path: configPath,
      status: 'failed',
      componentsWritten: [],
      error: mcpResult.error,
    };
  }
  if (mcpResult.wrote) {
    componentsWritten.push('mcp-config');
  } else {
    warnings.push('exarchos MCP server already registered; use forceOverwrite to update');
  }

  // Phase 2: Commands
  const commandsDeployed = await deployCommands(deps, options);
  if (commandsDeployed) {
    componentsWritten.push('commands');
  }

  // Phase 3: Skills
  const skillsDeployed = await deploySkills(deps, options);
  if (skillsDeployed) {
    componentsWritten.push('skills');
  }

  // Phase 4: On-ramp block (DR-5) — the runtime-neutral AGENTS.md block plus
  // the CLAUDE.md @AGENTS.md shim. Advisory-only warnings never fail the OVERALL
  // write (MCP/commands/skills stand on their own), but a failed AGENTS.md write
  // is surfaced via `onrampFailed` so the onboard gate (DR-7) keeps retired hooks
  // in place — a written-but-onramp-failed result must not read as full success.
  const onrampResult = onramp(options.projectRoot);
  if (onrampResult.wrote) {
    componentsWritten.push('onramp');
  }
  warnings.push(...onrampResult.warnings);
  const onrampFailedField = onrampResult.failed ? { onrampFailed: true as const } : {};

  // Determine overall status
  if (componentsWritten.length === 0) {
    return {
      runtime: 'claude-code',
      path: configPath,
      status: 'skipped',
      componentsWritten: [],
      ...onrampFailedField,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  return {
    runtime: 'claude-code',
    path: configPath,
    status: 'written',
    componentsWritten,
    ...onrampFailedField,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export const claudeCodeWriter: RuntimeConfigWriter = {
  runtime: 'claude-code',
  write: writeClaudeCode,
};

/**
 * Class wrapper used by init compositor — `new ClaudeCodeWriter()`.
 * Delegates to the same `writeClaudeCode` implementation. The optional
 * `onramp` seam is injectable for tests; production uses {@link defaultOnrampSeam}.
 * `promotionIo` is the DR-18 recovery/promotion filesystem seam; production uses
 * the real filesystem (`defaultPromotionIo()`).
 */
export class ClaudeCodeWriter implements RuntimeConfigWriter {
  readonly runtime = 'claude-code' as const;
  private readonly onramp: OnrampSeam;
  private readonly promotionIo: PromotionIo | undefined;
  constructor(onramp: OnrampSeam = defaultOnrampSeam, promotionIo?: PromotionIo) {
    this.onramp = onramp;
    this.promotionIo = promotionIo;
  }
  write(deps: WriterDeps, options: WriteOptions): Promise<ConfigWriteResult> {
    return writeClaudeCode(deps, options, this.onramp, this.promotionIo);
  }
}
