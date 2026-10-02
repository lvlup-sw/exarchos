/**
 * The Claude Code runtime config writer. It deploys the exarchos MCP server config, the commands, and the skills to `~/.claude/`.
 * First it recovers an interrupted config promotion. Then it runs four phases:
 *   1. MCP config: a read-modify-write of `~/.claude.json` with merge semantics, through {@link promoteConfigFile}.
 *   2. Commands: a copy of the project `commands/` to `~/.claude/commands/`.
 *   3. Skills: a copy of the project `skills/claude-code/` to `~/.claude/skills/`.
 *   4. On-ramp: the `AGENTS.md` block and the `CLAUDE.md` shim in the project.
 *
 * A skipped MCP config does not block the content phases.
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

/**
 * Writes JSON to `${path}.tmp` and renames it to `${path}`.
 * {@link promoteConfigFile} supersedes it, because a bare tmp+rename has no verify, journal, backup, or recovery.
 * `deployMcpConfig` does not call it. Only `claude-code.test.ts` pins it, and it must go together with the two `AtomicWriteJson_*` tests.
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

/**
 * The path of the Claude Code CLI config. One derivation, used by the writer,
 * by the recovery entry point, and by tests.
 */
export function claudeConfigPath(home: string): string {
  return toPosix(join(home, '.claude.json'));
}

/**
 * Builds the {@link ConfigPromotionFs} that promotes `~/.claude.json`.
 * The bytes go through the writer's own `deps.fs` seam, which callers and tests use to steer this writer.
 * `WriterFs` cannot express an fsync or a delete, so this function adds the three durability capabilities from `node:fs`.
 *
 * It adds them only when the parent directory of the config exists on the host.
 * An injected in-memory `WriterFs` writes to paths the host does not have. An fsync there throws ENOENT, and a delete can hit an unrelated host file.
 * Without the capabilities, the write is still atomic, and durability reports `not-applicable`. In production the parent is `$HOME`, so they are present.
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
 * Fsyncs a file that the seam just wrote, to make its bytes durable.
 * A file that is not on the host came from an injected in-memory fs, so the step is not applicable and returns. Other errors propagate.
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

/** Copies the files of `srcDir` into `destDir` recursively, and creates `destDir` when needed. A missing `srcDir` copies nothing. */
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
      await fs.mkdir(dirname(destPath), { recursive: true });
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Merges the exarchos entry into `~/.claude.json` and promotes the result: stage, verify, journal, backup, and commit.
 * An existing entry stays unless `forceOverwrite` is set.
 *
 * `stagePath` pins the staged copy at `<target>.tmp`, because `claude-code.test.ts` asserts that path.
 * The verify comes before the publish. So a concurrent writer that clobbers the staged copy makes the verify refuse.
 * The live config is then old-complete or new-complete in every interleaving. The only loss is the guarantee that both writers succeed.
 */
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

async function deploySkills(
  deps: WriterDeps,
  options: WriteOptions,
): Promise<boolean> {
  const srcDir = toPosix(join(options.projectRoot, 'skills', 'claude-code'));
  if (!(await dirExists(deps.fs, srcDir))) return false;

  const destDir = toPosix(join(deps.home(), '.claude', 'skills'));
  await copyDirRecursive(deps.fs, srcDir, destDir);
  return true;
}

/**
 * The on-ramp seam. It writes the runtime-neutral `AGENTS.md` block and the `CLAUDE.md` `@AGENTS.md` shim into the consumer project.
 * Tests inject it to steer or stub it. The default writes real files.
 */
export interface OnrampSeam {
  (projectRoot: string): {
    readonly wrote: boolean;
    /**
     * True when an on-ramp surface is not in place: a write error on the `AGENTS.md` block or the shim, or a missing canonical source.
     * A valid no-op (`wrote: false`, `failed: false`, for example an absent project root) is different.
     * The writer copies it to `onrampFailed`, so the onboard gate keeps the retired hooks in place.
     */
    readonly failed: boolean;
    readonly warnings: readonly string[];
  };
}

/**
 * The production on-ramp seam. It writes only into a project directory that exists, because the on-ramp files belong to the consumer project.
 * An absent or synthetic `projectRoot` is a valid no-op, not a failure, so it does not gate the removal of retired hooks.
 * The block content comes from `binding/standard/block.md`. A missing asset writes nothing and returns `failed: true` with a warning.
 */
export const defaultOnrampSeam: OnrampSeam = (projectRoot) => {
  if (!projectRoot || !fsExistsSync(projectRoot)) {
    return { wrote: false, failed: false, warnings: [] };
  }
  return deployOnrampBlocks({ projectRoot });
};

/**
 * Runs the recovery and the four phases, and reports the components it wrote.
 * Recovery of an interrupted promotion runs first. An interruption can leave `~/.claude.json` absent with the old config in the backup.
 * A read-modify-write of that state merges into an empty base, and turns a recoverable interruption into data loss.
 * Recovery also runs before the already-registered skip, which returns before any write.
 *
 * On-ramp warnings never fail the overall write. A failed on-ramp sets `onrampFailed`, so the onboard gate keeps the retired hooks in place.
 */
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

  const recovery = recoverInterruptedConfigPromotions([configPath], promotionIo);
  warnings.push(...recovery.failures.map((f) => f.error));

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

  const commandsDeployed = await deployCommands(deps, options);
  if (commandsDeployed) {
    componentsWritten.push('commands');
  }

  const skillsDeployed = await deploySkills(deps, options);
  if (skillsDeployed) {
    componentsWritten.push('skills');
  }

  const onrampResult = onramp(options.projectRoot);
  if (onrampResult.wrote) {
    componentsWritten.push('onramp');
  }
  warnings.push(...onrampResult.warnings);
  const onrampFailedField = onrampResult.failed ? { onrampFailed: true as const } : {};

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
 * Class wrapper that `getAllWriters` builds. It delegates to `writeClaudeCode`.
 * Tests can inject the `onramp` seam and the `promotionIo` seam. Production uses {@link defaultOnrampSeam} and the real filesystem.
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
