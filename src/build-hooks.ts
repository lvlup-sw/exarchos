/**
 * Per-runtime hooks renderer + build CLI (#1476 T8).
 *
 * A sibling to `buildAllSkills` (`src/build-skills.ts`). Where the skills
 * renderer turns one skill source into one rendered variant per runtime,
 * `buildAllHooks` renders the observer-only `hooks-src/` source tree into a
 * per-runtime hook artifact — but only for runtimes that declare
 * `capabilities.hasHooks: true` (per `src/runtimes/types.ts`, only `claude`
 * today).
 *
 * Design (ADR docs/adrs/2026-05-24-hook-layer-observe-only.md):
 *   - The hook layer is observe-only; enforcement lives in the MCP tools.
 *   - `hasHooks` runtimes get a generated `hooks.json`. Claude's artifact
 *     lands at the well-known plugin path `<outDir>/hooks.json` (NOT under a
 *     per-runtime subdirectory) so the Claude Code plugin format auto-loads
 *     it. Other future `hasHooks` runtimes would land under
 *     `<outDir>/<runtime>/hooks.json`.
 *   - Non-`hasHooks` runtimes emit no executable artifact, only a documented
 *     manual-steps note at `<outDir>/<runtime>/HOOKS.md`.
 *
 * The source tree is a single `hooks-src/hooks.json` template carrying
 * `{{TOKEN}}` placeholders (notably `{{MCP_PREFIX}}`) substituted via the
 * shared `render()` helper from `build-skills.ts`.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { loadAllRuntimes } from './runtimes/load.js';
import type { RuntimeMap } from './runtimes/types.js';
import { render } from './build-skills.js';
import { resolveMainDeps, type MainDeps } from './cli-helpers.js';

/**
 * Summary returned by `buildAllHooks` so callers (the CLI, tests, the
 * `hooks:guard` check) can report on what happened without re-scanning the
 * output tree.
 */
export interface HooksBuildReport {
  /** Number of runtimes that emitted an executable `hooks.json`. */
  hooksWritten: number;
  /** Number of non-`hasHooks` runtimes that emitted a manual-steps note. */
  manualNotesWritten: number;
}

/**
 * The source template filename. A single observer-only `hooks.json` template
 * lives under `hooks-src/`. Kept as a const so the CLI, the guard, and the
 * tests reference the same name.
 */
export const HOOKS_SOURCE_FILE = 'hooks.json';

/**
 * Render the observer-only hooks source per runtime.
 *
 * For each loaded runtime:
 *   - `hasHooks: true`  → render `hooks-src/hooks.json` with the runtime's
 *     placeholders and write the result. Claude lands at `<outDir>/hooks.json`
 *     (plugin auto-load path); any other `hasHooks` runtime lands at
 *     `<outDir>/<runtime>/hooks.json`.
 *   - `hasHooks: false` → write a documented manual-steps note at
 *     `<outDir>/<runtime>/HOOKS.md`. No executable artifact.
 *
 * Throws if the hooks source file is missing — refusing to silently produce
 * an empty build (mirrors `buildAllSkills`).
 *
 * @param opts.srcDir - Hooks source root (e.g. `hooks-src/`).
 * @param opts.outDir - Output root (e.g. `hooks/`).
 * @param opts.runtimesDir - Directory of runtime YAML files for
 *   `loadAllRuntimes`.
 */
export function buildAllHooks(opts: {
  srcDir: string;
  outDir: string;
  runtimesDir: string;
}): HooksBuildReport {
  const sourcePath = join(opts.srcDir, HOOKS_SOURCE_FILE);
  if (!existsSync(sourcePath)) {
    throw new Error(
      `buildAllHooks: no ${HOOKS_SOURCE_FILE} found under ${opts.srcDir} — refusing to produce an empty build.`,
    );
  }

  const runtimes: RuntimeMap[] = loadAllRuntimes(opts.runtimesDir);
  const body = readFileSync(sourcePath, 'utf8');

  // Track every path produced this run so the stale-cleanup pass below only
  // removes orphans, never fresh output.
  const written = new Set<string>();
  let hooksWritten = 0;
  let manualNotesWritten = 0;

  for (const rt of runtimes) {
    if (rt.capabilities.hasHooks) {
      const rendered = render(body, rt.placeholders, {
        sourcePath,
        runtimeName: rt.name,
      });
      const outPath = hookArtifactPath(opts.outDir, rt.name);
      mkdirSync(join(outPath, '..'), { recursive: true });
      writeFileSync(outPath, rendered);
      written.add(outPath);
      hooksWritten++;
    } else {
      const notePath = join(opts.outDir, rt.name, 'HOOKS.md');
      mkdirSync(join(opts.outDir, rt.name), { recursive: true });
      writeFileSync(notePath, manualStepsNote(rt.name));
      written.add(notePath);
      manualNotesWritten++;
    }
  }

  // Stale cleanup: any per-runtime subtree file we did not write this run is
  // removed. The well-known top-level `<outDir>/hooks.json` (Claude) is
  // preserved by membership in `written`. We intentionally do NOT delete
  // arbitrary files at the `outDir` root — only the artifacts this builder
  // owns (per-runtime subdirs + the top-level hooks.json).
  cleanStaleHookArtifacts(opts.outDir, runtimes, written);

  return { hooksWritten, manualNotesWritten };
}

/**
 * Resolve where a `hasHooks` runtime's rendered `hooks.json` lands. Claude is
 * special-cased to the well-known plugin auto-load path `<outDir>/hooks.json`;
 * any other `hasHooks` runtime gets `<outDir>/<runtime>/hooks.json`.
 */
function hookArtifactPath(outDir: string, runtimeName: string): string {
  if (runtimeName === 'claude') {
    return join(outDir, 'hooks.json');
  }
  return join(outDir, runtimeName, 'hooks.json');
}

/**
 * The documented manual-steps note written for non-`hasHooks` runtimes. The
 * note explains why no executable artifact exists and what (if anything) a
 * user can do manually.
 */
function manualStepsNote(runtimeName: string): string {
  return `# Hooks — manual steps for ${runtimeName}

This runtime does not declare \`hasHooks: true\`, so Exarchos does not generate
an executable hook configuration for it. Hooks are a Claude Code plugin artifact
today (auto-loaded from \`hooks/hooks.json\`).

Per the ADR \`docs/adrs/2026-05-24-hook-layer-observe-only.md\`, the hook layer is
**observe-only** — all enforcement lives inside the MCP tools, which are
runtime-agnostic. So nothing is lost on this runtime: the MCP tools still
self-validate phase and role on every action.

If you want lifecycle-observer telemetry on \`${runtimeName}\`, wire the
\`exarchos session-end\` / \`exarchos subagent-stop\` observer subcommands into
your harness's lifecycle hooks manually. This file is regenerated by
\`npm run build:hooks\`; do not hand-edit it.
`;
}

/**
 * Remove hook artifacts under `outDir` that were not produced this run.
 *
 * Scope is deliberately narrow: we only touch the per-runtime subdirectories
 * and the top-level `hooks.json` — the exact paths this builder owns — so we
 * can never delete unrelated files that happen to live under `outDir`.
 */
function cleanStaleHookArtifacts(
  outDir: string,
  runtimes: RuntimeMap[],
  keep: Set<string>,
): void {
  // Top-level Claude artifact: drop only if no `hasHooks` claude runtime
  // wrote it this run.
  const topLevel = join(outDir, 'hooks.json');
  if (existsSync(topLevel) && !keep.has(topLevel)) {
    rmSync(topLevel, { force: true });
  }

  for (const rt of runtimes) {
    const runtimeDir = join(outDir, rt.name);
    if (!existsSync(runtimeDir)) continue;
    for (const candidate of [join(runtimeDir, 'hooks.json'), join(runtimeDir, 'HOOKS.md')]) {
      if (existsSync(candidate) && !keep.has(candidate)) {
        rmSync(candidate, { force: true });
      }
    }
  }
}

// -----------------------------------------------------------------------------
// CLI entry (`npm run build:hooks`)
// -----------------------------------------------------------------------------

export type { MainDeps } from './cli-helpers.js';

/**
 * `npm run build:hooks` entry point. Resolves default paths relative to
 * `deps.cwd()`, runs `buildAllHooks`, prints a one-line summary on success,
 * and exits with code 1 on any error (printed to stderr).
 */
export function main(_argv: string[], deps: MainDeps = {}): void {
  const { cwd, exit, log, errLog } = resolveMainDeps(deps);

  const root = cwd();
  const srcDir = join(root, 'hooks-src');
  const outDir = join(root, 'hooks');
  const runtimesDir = join(root, 'runtimes');

  let report: HooksBuildReport;
  try {
    report = buildAllHooks({ srcDir, outDir, runtimesDir });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errLog(`[build:hooks] error: ${msg}`);
    exit(1);
    return; // unreachable in production; in tests exit throws
  }

  log(
    `[build:hooks] wrote ${report.hooksWritten} hook artifact(s) + ${report.manualNotesWritten} manual note(s)`,
  );
}

// Self-invocation guard: only run `main()` when this file is executed
// directly (e.g. `node dist/build-hooks.js`). Importing it from a test must
// NOT trigger a build.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
