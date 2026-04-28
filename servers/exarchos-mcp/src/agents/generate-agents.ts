// ─── Unified composition root for per-runtime agent generation ─────────────
//
// `generateAgents` is the singular entry point that fans an `AgentSpec`
// out across every `RuntimeAdapter` (Claude, Codex, OpenCode, Cursor,
// Copilot), validates each (spec, runtime) pair, and writes the
// per-runtime agent definition files. It also keeps the Claude
// plugin.json `agents` manifest in sync (other runtimes have no
// equivalent manifest yet).
//
// Operability contract (DIM-2 observability):
//   • Validation runs as a single pre-pass before any file write — a
//     spec/runtime mismatch never half-emits.
//   • Validation aggregates EVERY failure across (spec × runtime) pairs
//     and surfaces them through `GenerateAgentsError.failures` plus a
//     human-readable aggregated message. A first-failure short-circuit
//     would hide config bugs and is a DIM-2 violation.
//   • Iteration order is deterministic: adapters are resorted into the
//     canonical `RUNTIMES` tuple and specs are kept in declaration
//     order. Reruns are idempotent.
//   • File-write failures propagate with the failing path included.
//
// See docs/designs/2026-04-25-delegation-runtime-parity.md §5 and Task 5
// in docs/plans/2026-04-25-delegation-runtime-parity.md.
//
// Out of scope (owned by later tasks):
//   • Task 6 wires `npm run generate:agents` to call this entry point.
//   • Task 7a–7e populate `runtimes/<name>.yaml` from adapter shapes.
// ────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Capability } from './capabilities.js';
import { ALL_AGENT_SPECS, IMPLEMENTER, FIXER, REVIEWER, SCAFFOLDER } from './definitions.js';
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

// ─── Default registry ──────────────────────────────────────────────────────

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

// ─── Public types ──────────────────────────────────────────────────────────

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
 * Structured failure record for one rejected (spec, runtime) pair.
 * The full set is surfaced through `GenerateAgentsError.failures` so
 * operators can see every offending tuple at once (DIM-2).
 */
export interface GenerateAgentsFailure {
  readonly runtime: Runtime | 'missing-adapter';
  readonly specId: AgentSpecId | '<all>';
  readonly capability: Capability | '<n/a>';
  readonly reason: string;
  readonly fixHint: string;
}

/**
 * Aggregated error thrown by `generateAgents`. Carries the full set of
 * failures rather than the first one — short-circuiting on the first
 * rejection would hide concurrent config bugs.
 */
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

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Sort caller-provided adapters into canonical `RUNTIMES` order so
 * downstream iteration is deterministic. Unknown runtimes (e.g. a
 * future tier-2 adapter someone passes in early) keep a stable order
 * after the canonical block.
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
  // Append any non-tier-1 adapters in declaration order so caller
  // input is preserved without reordering surprises.
  const seen = new Set(RUNTIMES as readonly string[]);
  for (const a of adapters) {
    if (!seen.has(a.runtime)) ordered.push(a);
  }
  return ordered;
}

/** Are all five canonical tier-1 runtimes present? */
function missingTier1Runtimes(
  adapters: readonly RuntimeAdapter[],
): readonly Runtime[] {
  const present = new Set(adapters.map((a) => a.runtime));
  return RUNTIMES.filter((r) => !present.has(r));
}

/**
 * Run `validateSupport` for every (spec, adapter) pair, accumulating
 * structured failures. Adapters return a single `ValidationResult` per
 * spec; we infer the offending capability by re-running the
 * support-level lookup so the failure record can name it explicitly.
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
      // Identify which capability (or capabilities) tripped the
      // adapter's `unsupported` check. We emit one failure entry per
      // offending capability so the aggregated report names every
      // problem, not just the first.
      const offending = spec.capabilities.filter(
        (cap) => adapter.supportLevels[cap] === 'unsupported',
      );
      if (offending.length === 0) {
        // Adapter rejected for a non-capability reason; preserve the
        // adapter's reason/fixHint verbatim with a sentinel capability.
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
 * Validate that the Claude plugin manifest exists and is well-formed
 * JSON before any artifact writes. Called early in `generateAgents` so
 * a missing/invalid manifest aborts the run cleanly rather than leaving
 * a partially regenerated tree.
 */
function preflightPluginJson(pluginJsonPath: string): void {
  // Preserve the structured GenerateAgentsError on missing-file so callers
  // (and tests) keep the same operator-facing failure shape; everything
  // else (JSON syntax, schema violations) is delegated to
  // readPluginManifest which throws a descriptive plain Error.
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
 * Update plugin.json's `agents` field with the four Claude agent paths.
 * Only Claude has a plugin manifest today — other runtimes load agents
 * via filesystem conventions (`.codex/agents/`, `.opencode/agents/`,
 * etc.) without an equivalent allowlist file.
 *
 * Existence + JSON validity have already been verified by
 * `preflightPluginJson`, so this function only needs to round-trip the
 * manifest with the updated `agents` field.
 */
function updatePluginJson(
  pluginJsonPath: string,
  specs: readonly AgentSpec[],
): void {
  // Re-read defensively in case the manifest changed between preflight
  // and write (rare but possible during concurrent runs). The write goes
  // through atomicWriteFile (temp + fsync + rename) via writePluginManifest
  // so concurrent readers never observe a partial write.
  const manifest = readPluginManifest(pluginJsonPath);
  manifest.agents = specs.map((s) => `./agents/${s.id}.md`);
  writePluginManifest(pluginJsonPath, manifest);
}

// ─── Entry point ───────────────────────────────────────────────────────────

/**
 * Fan out every spec across every adapter, write the lowered files,
 * and refresh the Claude plugin manifest. Idempotent, deterministic,
 * and aggregates all validation failures into a single
 * `GenerateAgentsError`.
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

  // 0. Tier-1 coverage check. An empty or partial registry is a
  //    configuration error — silent zero-file emission would be a
  //    DIM-2 violation. Surface every missing runtime by name.
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

  // 1. Validation pass. Accumulate every failure before failing — never
  //    short-circuit on the first error.
  const failures = validateAllPairs(specs, adapters);
  if (failures.length > 0) {
    throw new GenerateAgentsError(failures);
  }

  // 1b. Plugin manifest preflight. The Claude plugin manifest update
  //     happens after artifact writes today, but discovering a missing
  //     or invalid manifest at that point leaves the tree partially
  //     updated (20 runtime files written, plugin.json untouched). Check
  //     readability + JSON validity now, before any writes, so a missing
  //     manifest is a clean abort with no side effects.
  preflightPluginJson(pluginJsonPath);

  // 2. Lowering and writing pass. Iterate adapters in canonical
  //    runtime order, specs in caller-declaration order.
  //
  // Path-traversal guard (DIM-7): adapter-provided `lowered.path` is
  // resolved against `outputRoot`, then validated to ensure the result
  // stays inside the root. A malicious or buggy adapter that returns
  // `../../../etc/passwd` or an absolute path must be rejected before
  // any directory creation or file write touches the filesystem.
  const resolvedRoot = path.resolve(outputRoot);
  const filesWritten: string[] = [];
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
    }
  }

  // 3. Plugin.json update. Only Claude has a manifest today; the other
  //    runtimes load agents via filesystem convention.
  updatePluginJson(pluginJsonPath, specs);

  return {
    filesWritten,
    pluginJsonUpdated: true,
  };
}

// ─── Re-exports for convenience ────────────────────────────────────────────

export { IMPLEMENTER, FIXER, REVIEWER, SCAFFOLDER };

// ─── CLI entry point ───────────────────────────────────────────────────────
//
// `npm run generate:agents` (Task 6) invokes this file directly via tsx.
// We gate on `process.argv[1]` rather than an `import.meta.url`-equality
// check because tsx loaders rewrite the script URL in ways that vary by
// version; the argv path is stable across `tsx`, `node --import tsx`,
// and `bun run`.
//
// Two hooks:
//   • `EXARCHOS_OUTPUT_ROOT` (env) — redirect writes to a sandbox. Used
//     by build-pipeline.test.ts to verify the wiring without touching
//     the real repo.
//   • `process.argv[2]` — same purpose, takes precedence over the env
//     var. Convenient for ad-hoc operator invocations.
//
// Default behaviour: write into `process.cwd()` (which the npm script
// resolves to the repo root).

const isCliInvocation =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('generate-agents.ts') ||
    process.argv[1].endsWith('generate-agents.js'));

if (isCliInvocation) {
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
