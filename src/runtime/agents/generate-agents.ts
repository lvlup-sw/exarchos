/**
 * The composition root for per-runtime agent generation. `generateAgents` lowers each `AgentSpec` through
 * each `RuntimeAdapter`, writes the agent files, and keeps the `agents` list of the Claude `plugin.json` in
 * sync. The other runtimes have no manifest.
 *
 * - Validation runs before any file write, so a mismatch never writes half of the files.
 * - Validation collects each failure across all spec and runtime pairs into `GenerateAgentsError.failures`.
 * - Adapters run in `RUNTIMES` order and specs in declaration order, so a second run gives the same files.
 * - A file-write error names the failing path.
 *
 * `npm run generate:agents` runs this file with `tsx`. The output root is `process.argv[2]`, then
 * `EXARCHOS_OUTPUT_ROOT`, then `process.cwd()`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Capability } from './capabilities.js';
import {
  ALL_AGENT_SPECS,
  IMPLEMENTER,
  FIXER,
  REVIEWER,
  SCAFFOLDER,
} from './definitions.js';
import { resolveCapabilities } from '../../workflow/capabilities/posture-mapping.js';
import type { AgentSpec, AgentSpecId } from './types.js';
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { OpenCodeAdapter } from './adapters/opencode.js';
import { CursorAdapter } from './adapters/cursor.js';
import { CopilotAdapter } from './adapters/copilot.js';
import {
  RUNTIMES,
  type Runtime,
  type RuntimeAdapter,
} from './adapters/types.js';
import { readPluginManifest, writePluginManifest } from './plugin-manifest.js';

/**
 * Canonical adapter registry. Iteration follows `RUNTIMES` order so
 * fan-out is deterministic regardless of how callers pass adapters in.
 */
export const ADAPTERS: Readonly<Record<Runtime, RuntimeAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  opencode: OpenCodeAdapter,
  cursor: CursorAdapter,
  copilot: new CopilotAdapter(),
};

const DEFAULT_ADAPTERS: readonly RuntimeAdapter[] = RUNTIMES.map(
  (r) => ADAPTERS[r],
);

const DEFAULT_SPECS: readonly AgentSpec[] = ALL_AGENT_SPECS;

export interface GenerateAgentsOptions {
  /** Repo root (or sandbox root). Defaults to `process.cwd()`. */
  outputRoot?: string;
  /** Specs to lower. Defaults to the canonical `ALL_AGENT_SPECS` set. */
  specs?: readonly AgentSpec[];
  /** Runtime adapters to fan out across. Defaults to all five tier-1 adapters. */
  adapters?: readonly RuntimeAdapter[];
  /** Path to the Claude plugin manifest. Defaults to `<outputRoot>/.claude-plugin/plugin.json`. */
  pluginJsonPath?: string;
}

export interface GenerateAgentsResult {
  /** Absolute paths of every per-runtime agent file written. */
  filesWritten: string[];
  /** True when the Claude plugin manifest was rewritten. */
  pluginJsonUpdated: boolean;
}

/**
 * Failure record for one rejected spec and runtime pair. `GenerateAgentsError.failures` holds the full set,
 * so an operator sees each offending pair at once.
 */
export interface GenerateAgentsFailure {
  readonly runtime: Runtime | 'missing-adapter';
  readonly specId: AgentSpecId | '<all>';
  readonly capability: Capability | '<n/a>';
  readonly reason: string;
  readonly fixHint: string;
}

/** The error that `generateAgents` throws. It carries each failure, not only the first, so one fault cannot hide another. */
export class GenerateAgentsError extends Error {
  readonly failures: readonly GenerateAgentsFailure[];

  constructor(failures: readonly GenerateAgentsFailure[]) {
    super(GenerateAgentsError.formatMessage(failures));
    this.name = 'GenerateAgentsError';
    this.failures = failures;
  }

  private static formatMessage(
    failures: readonly GenerateAgentsFailure[],
  ): string {
    if (failures.length === 0) {
      return 'generateAgents failed (no failures recorded)';
    }
    const lines: string[] = [
      `generateAgents validation failed (${failures.length} ${
        failures.length === 1 ? 'failure' : 'failures'
      }):`,
    ];
    for (const f of failures) {
      lines.push(
        `  • [${f.runtime}] spec '${f.specId}' capability '${f.capability}': ${f.reason}`,
      );
      lines.push(`      fix: ${f.fixHint}`);
    }
    return lines.join('\n');
  }
}

/**
 * Sorts adapters into `RUNTIMES` order, so iteration is deterministic. Adapters for other runtimes follow
 * the canonical block in their input order.
 */
function canonicaliseAdapters(
  adapters: readonly RuntimeAdapter[],
): readonly RuntimeAdapter[] {
  const byRuntime = new Map<string, RuntimeAdapter>();
  for (const a of adapters) {
    byRuntime.set(a.runtime, a);
  }
  const ordered: RuntimeAdapter[] = [];
  for (const r of RUNTIMES) {
    const a = byRuntime.get(r);
    if (a) ordered.push(a);
  }
  const seen = new Set(RUNTIMES as readonly string[]);
  for (const a of adapters) {
    if (!seen.has(a.runtime)) ordered.push(a);
  }
  return ordered;
}

/** The tier-1 runtimes in `RUNTIMES` that have no adapter. */
function missingTier1Runtimes(
  adapters: readonly RuntimeAdapter[],
): readonly Runtime[] {
  const present = new Set(adapters.map((a) => a.runtime));
  return RUNTIMES.filter((r) => !present.has(r));
}

/**
 * Runs `validateSupport` for each adapter and spec pair and collects the failures. An adapter returns one
 * result per spec, so this function repeats the support-level lookup to name each unsupported capability.
 * It records one failure per such capability. A rejection with no unsupported capability keeps the reason
 * of the adapter, with the `<n/a>` capability.
 */
function validateAllPairs(
  specs: readonly AgentSpec[],
  adapters: readonly RuntimeAdapter[],
): readonly GenerateAgentsFailure[] {
  const failures: GenerateAgentsFailure[] = [];
  for (const adapter of adapters) {
    for (const spec of specs) {
      const res = adapter.validateSupport(spec);
      if (res.ok) continue;
      const resolvedCaps = resolveCapabilities(spec.posture, spec.id);
      const offending: Capability[] = [...resolvedCaps].filter(
        (cap) => adapter.supportLevels[cap] === 'unsupported',
      );
      if (offending.length === 0) {
        failures.push({
          runtime: adapter.runtime,
          specId: spec.id,
          capability: '<n/a>',
          reason: res.reason,
          fixHint: res.fixHint,
        });
        continue;
      }
      for (const cap of offending) {
        failures.push({
          runtime: adapter.runtime,
          specId: spec.id,
          capability: cap,
          reason: res.reason,
          fixHint: res.fixHint,
        });
      }
    }
  }
  return failures;
}

/**
 * Checks that the Claude plugin manifest exists and parses before any artifact write, so a bad manifest
 * aborts the run with no partial tree. A missing file throws `GenerateAgentsError`. `readPluginManifest`
 * throws a plain `Error` for a syntax or schema fault.
 */
function preflightPluginJson(pluginJsonPath: string): void {
  if (!fs.existsSync(pluginJsonPath)) {
    throw new GenerateAgentsError([
      {
        runtime: 'claude',
        specId: '<all>',
        capability: '<n/a>',
        reason: `plugin manifest not found at ${pluginJsonPath}`,
        fixHint:
          'Create `.claude-plugin/plugin.json` with at minimum `{ "name": "exarchos", "agents": [] }`, or pass an explicit pluginJsonPath option.',
      },
    ]);
  }
  readPluginManifest(pluginJsonPath);
}

/**
 * Sets the `agents` field of `plugin.json` to the Claude agent paths. Only Claude has a plugin manifest.
 * Other runtimes find agents by directory convention, such as `.codex/agents/` and `.opencode/agents/`.
 * It reads the manifest again in case it changed after the preflight. `writePluginManifest` writes
 * atomically, so a concurrent reader never sees a partial file.
 */
function updatePluginJson(
  pluginJsonPath: string,
  specs: readonly AgentSpec[],
): void {
  const manifest = readPluginManifest(pluginJsonPath);
  manifest.agents = specs.map((s) => `./rendered/agents/${s.id}.md`);
  writePluginManifest(pluginJsonPath, manifest);
}

/**
 * Lowers each spec through each adapter, writes the files, and refreshes the Claude plugin manifest. It
 * throws `GenerateAgentsError` when a tier-1 runtime has no adapter or when any pair fails validation. It
 * checks the manifest before the first write.
 *
 * Each adapter path must resolve inside `outputRoot`, so an adapter cannot write outside it. If the manifest
 * write fails, it removes the files that this run created and keeps the files that existed before. Then it
 * throws an error with the original cause and the rollback count.
 */
export function generateAgents(
  options: GenerateAgentsOptions = {},
): GenerateAgentsResult {
  const outputRoot = options.outputRoot ?? process.cwd();
  const specs = options.specs ?? DEFAULT_SPECS;
  const adapters = canonicaliseAdapters(options.adapters ?? DEFAULT_ADAPTERS);
  const pluginJsonPath =
    options.pluginJsonPath ??
    path.join(outputRoot, '.claude-plugin', 'plugin.json');

  const missing = missingTier1Runtimes(adapters);
  if (missing.length > 0) {
    const failures: GenerateAgentsFailure[] = missing.map((runtime) => ({
      runtime,
      specId: '<all>',
      capability: '<n/a>',
      reason: `no adapter registered for tier-1 runtime '${runtime}'`,
      fixHint: `Pass the ${runtime} adapter via options.adapters, or rely on the default registry.`,
    }));
    throw new GenerateAgentsError(failures);
  }

  const failures = validateAllPairs(specs, adapters);
  if (failures.length > 0) {
    throw new GenerateAgentsError(failures);
  }

  preflightPluginJson(pluginJsonPath);

  const resolvedRoot = path.resolve(outputRoot);
  const filesWritten: string[] = [];
  const newlyCreatedArtifacts: string[] = [];
  for (const adapter of adapters) {
    for (const spec of specs) {
      const lowered = adapter.lowerSpec(spec);
      const absPath = path.resolve(outputRoot, lowered.path);
      const rel = path.relative(resolvedRoot, absPath);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(
          `generateAgents: adapter '${adapter.runtime}' produced path '${lowered.path}' that escapes outputRoot ('${resolvedRoot}')`,
        );
      }
      const dir = path.dirname(absPath);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        throw new Error(
          `generateAgents: failed to create directory ${dir} for runtime '${
            adapter.runtime
          }' spec '${spec.id}': ${(err as Error).message}`,
        );
      }
      const preExisted =
        fs.statSync(absPath, { throwIfNoEntry: false }) !== undefined;
      try {
        fs.writeFileSync(absPath, lowered.contents, 'utf-8');
      } catch (err) {
        throw new Error(
          `generateAgents: failed to write ${absPath} for runtime '${
            adapter.runtime
          }' spec '${spec.id}': ${(err as Error).message}`,
        );
      }
      filesWritten.push(absPath);
      if (!preExisted) {
        newlyCreatedArtifacts.push(absPath);
      }
    }
  }

  try {
    updatePluginJson(pluginJsonPath, specs);
  } catch (e) {
    rollbackArtifacts(newlyCreatedArtifacts);
    throw new Error(
      `generate-agents: manifest write failed; rolled back ${newlyCreatedArtifacts.length} new artifacts. Original error: ${
        (e as Error).message
      }`,
    );
  }

  return {
    filesWritten,
    pluginJsonUpdated: true,
  };
}

/** Removes each path in `paths` and ignores each per-file error, so a partial cleanup never hides the original failure. */
function rollbackArtifacts(paths: readonly string[]): void {
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
    } catch {
    }
  }
}

export { IMPLEMENTER, FIXER, REVIEWER, SCAFFOLDER };

/** True when `process.argv[1]` resolves to this module. It compares real paths, not a filename suffix. */
function isCliInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliInvocation()) {
  const outputRoot =
    process.argv[2] ?? process.env.EXARCHOS_OUTPUT_ROOT ?? process.cwd();
  try {
    const result = generateAgents({ outputRoot });
    process.stderr.write(
      `Generated ${result.filesWritten.length} agent files under ${outputRoot}\n`,
    );
    if (result.pluginJsonUpdated) {
      process.stderr.write(`Updated ${path.join(outputRoot, '.claude-plugin', 'plugin.json')}\n`);
    }
  } catch (err) {
    if (err instanceof GenerateAgentsError) {
      process.stderr.write(`${err.message}\n`);
    } else {
      process.stderr.write(`generate-agents failed: ${(err as Error).message}\n`);
    }
    process.exit(1);
  }
}
