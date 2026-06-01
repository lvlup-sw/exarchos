/**
 * Per-runtime binding + lifecycle-hook renderer (#1485, evolved from #1476 T8).
 *
 * A sibling to `buildAllSkills`. Renders two things per runtime from a single
 * source of truth each:
 *
 *  1. **Binding block** (universal) — the orientation directive
 *     (`binding-src/binding.md`) rendered into every runtime's always-loaded
 *     instructions surface as a marker-fenced block: `CLAUDE.md` for Claude,
 *     `AGENTS.md` for everyone else (including Copilot/opencode/generic, whose
 *     hooks cannot inject context — AGENTS.md is the only universal binding
 *     surface). Output lands under `<bindingOutDir>/<runtime>/`.
 *
 *  2. **Active hook artifact** (where supported) — dispatched on the declared
 *     `capabilities.hooks.profile`, NEVER a runtime-name literal (INV-4):
 *       - `claude-json`     → `hooks.json` (Claude + Codex). Claude lands at the
 *                             well-known plugin path `<outDir>/hooks.json`; other
 *                             runtimes at `<outDir>/<runtime>/hooks.json`. The
 *                             SessionStart command carries the binding directive
 *                             as `--directive` for injection-capable hosts; the
 *                             SessionEnd block is emitted ONLY when the runtime's
 *                             `sessionEndEvent` is literally `SessionEnd` (Codex's
 *                             end is `Stop`, deferred — so Codex gets SessionStart
 *                             only).
 *       - `opencode-plugin` → a TS plugin (`session.created` telemetry).
 *       - `cursor-json` / `copilot-json` → a `HOOKS.md` note (renderer deferred;
 *                             the AGENTS.md binding is active now).
 *       - `none`            → a `HOOKS.md` note (no hook system; AGENTS.md only).
 *
 * ADR: docs/adrs/2026-05-24-hook-layer-observe-only.md (observe-only, fail-open).
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
import type { RuntimeMap, HooksProfile } from './runtimes/types.js';
import { render } from './build-skills.js';
import { renderBindingBlock, BINDING_SOURCE_FILE } from './binding.js';
import { resolveMainDeps, type MainDeps } from './cli-helpers.js';

/** The Claude-schema hooks.json template filename (profile `claude-json`). */
export const HOOKS_SOURCE_FILE = 'hooks.json';

/** The opencode TS plugin template filename (profile `opencode-plugin`). */
export const OPENCODE_PLUGIN_SOURCE_FILE = 'opencode-plugin.ts.tmpl';

/** Counts returned so callers (CLI, tests, guard) can report without rescanning. */
export interface HooksBuildReport {
  /** Runtimes that received an AGENTS.md/CLAUDE.md binding block (all of them). */
  bindingBlocksWritten: number;
  /** Runtimes that emitted an executable `hooks.json` (`claude-json` profile). */
  hooksJsonWritten: number;
  /** Runtimes that emitted a TS lifecycle plugin (`opencode-plugin` profile). */
  pluginsWritten: number;
  /** Runtimes that emitted a `HOOKS.md` note (deferred renderer / `none`). */
  notesWritten: number;
}

/**
 * Render binding blocks + active hook artifacts for every runtime.
 *
 * @param opts.srcDir        Hook templates root (`hooks-src/`).
 * @param opts.bindingSrcDir Binding directive root (`binding-src/`).
 * @param opts.outDir        Hook artifact output root (`hooks/`).
 * @param opts.bindingOutDir Binding block output root (`binding/`).
 * @param opts.runtimesDir   Directory of runtime YAML files.
 */
export function buildAllHooks(opts: {
  srcDir: string;
  bindingSrcDir: string;
  outDir: string;
  bindingOutDir: string;
  runtimesDir: string;
}): HooksBuildReport {
  const hooksTemplatePath = join(opts.srcDir, HOOKS_SOURCE_FILE);
  const pluginTemplatePath = join(opts.srcDir, OPENCODE_PLUGIN_SOURCE_FILE);
  const bindingSourcePath = join(opts.bindingSrcDir, BINDING_SOURCE_FILE);

  for (const [label, p] of [
    ['hooks template', hooksTemplatePath],
    ['binding directive', bindingSourcePath],
  ] as const) {
    if (!existsSync(p)) {
      throw new Error(`buildAllHooks: missing ${label} at ${p} — refusing to produce an empty build.`);
    }
  }

  const runtimes = loadAllRuntimes(opts.runtimesDir);
  const hooksTemplate = readFileSync(hooksTemplatePath, 'utf8');
  const directiveBody = readFileSync(bindingSourcePath, 'utf8');
  // The opencode plugin template is read lazily — only `opencode-plugin` runtimes
  // need it, so a minimal project without one still builds the rest.
  const readPluginTemplate = (): string => {
    if (!existsSync(pluginTemplatePath)) {
      throw new Error(`buildAllHooks: missing opencode plugin template at ${pluginTemplatePath}`);
    }
    return readFileSync(pluginTemplatePath, 'utf8');
  };

  const writtenHooks = new Set<string>();
  const writtenBinding = new Set<string>();
  const report: HooksBuildReport = {
    bindingBlocksWritten: 0,
    hooksJsonWritten: 0,
    pluginsWritten: 0,
    notesWritten: 0,
  };

  // Active-artifact strategy map keyed on the declared `hooks.profile` — never a
  // runtime-name literal (INV-4). Typing it `Record<HooksProfile, …>` gives
  // compile-time exhaustiveness: adding a profile to the union is a build error
  // until a renderer is wired, instead of silently falling into the note branch.
  const emitNote = (rt: RuntimeMap): void => {
    writeArtifact(
      join(opts.outDir, rt.name, 'HOOKS.md'),
      hooksNote(rt, rt.capabilities.hooks?.profile ?? 'none'),
      writtenHooks,
    );
    report.notesWritten++;
  };
  const renderers: Record<HooksProfile, (rt: RuntimeMap) => void> = {
    'claude-json': (rt) => {
      const directiveOneLine = oneLineDirective(
        render(directiveBody, rt.placeholders, { sourcePath: bindingSourcePath, runtimeName: rt.name }),
      );
      const json = renderClaudeJsonHooks(rt, hooksTemplate, directiveOneLine);
      writeArtifact(hooksJsonPathFor(opts.outDir, rt.name), json, writtenHooks);
      report.hooksJsonWritten++;
    },
    'opencode-plugin': (rt) => {
      const plugin = render(readPluginTemplate(), rt.placeholders, {
        sourcePath: pluginTemplatePath,
        runtimeName: rt.name,
      });
      writeArtifact(join(opts.outDir, rt.name, 'plugin', 'exarchos-lifecycle.ts'), plugin, writtenHooks);
      report.pluginsWritten++;
    },
    // Renderers deferred → AGENTS.md binding + an accurate HOOKS.md note.
    'cursor-json': emitNote,
    'copilot-json': emitNote,
    'none': emitNote,
  };

  for (const rt of runtimes) {
    // ── 1. Universal binding block ────────────────────────────────────────────
    const bindingBlock = renderBindingBlock(directiveBody, rt.placeholders, {
      sourcePath: bindingSourcePath,
      runtimeName: rt.name,
    });
    writeArtifact(join(opts.bindingOutDir, rt.name, instructionsFileFor(rt)), bindingBlock, writtenBinding);
    report.bindingBlocksWritten++;

    // ── 2. Active hook artifact (dispatch on declared profile) ────────────────
    renderers[rt.capabilities.hooks?.profile ?? 'none'](rt);
  }

  cleanStaleArtifacts(opts.outDir, opts.bindingOutDir, runtimes, writtenHooks, writtenBinding);
  return report;
}

/** The always-loaded instructions filename for a runtime's binding block. */
function instructionsFileFor(rt: RuntimeMap): string {
  // CLAUDE.md is Claude Code's always-loaded file; every other harness reads the
  // cross-agent AGENTS.md standard. This is the one documented harness fact the
  // renderer keys on; everything else dispatches on declared capabilities.
  return rt.name === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
}

/** Where a `claude-json` runtime's hooks.json lands (Claude → plugin path). */
function hooksJsonPathFor(outDir: string, runtimeName: string): string {
  return runtimeName === 'claude'
    ? join(outDir, 'hooks.json')
    : join(outDir, runtimeName, 'hooks.json');
}

/**
 * Collapse the multi-line directive to a single shell-safe `--directive` arg.
 * Applies the canonical POSIX single-quote escape (`'` → `'\''`) so the caller
 * can wrap the whole value in single quotes without injection. Exported for the
 * escape regression test.
 */
export function oneLineDirective(rendered: string): string {
  return rendered.replace(/\s+/g, ' ').trim().replace(/'/g, "'\\''");
}

/**
 * Build a `claude-json` hooks.json: inject the binding directive into the
 * SessionStart command for injection-capable hosts, and drop the SessionEnd
 * block unless the runtime's end event is literally `SessionEnd` (Codex's is
 * `Stop`, deferred — Codex therefore gets SessionStart only).
 */
function renderClaudeJsonHooks(rt: RuntimeMap, template: string, directiveOneLine: string): string {
  const base = JSON.parse(template) as {
    hooks: Record<string, Array<{ hooks: Array<{ command?: string }> }>>;
  };
  const canInject = rt.capabilities.hooks?.canInjectContext ?? false;

  if (canInject && base.hooks.SessionStart) {
    for (const group of base.hooks.SessionStart) {
      for (const h of group.hooks) {
        if (typeof h.command === 'string' && h.command.includes('session-start')) {
          h.command = `${h.command} --directive '${directiveOneLine}'`;
        }
      }
    }
  }

  if (rt.capabilities.hooks?.sessionEndEvent !== 'SessionEnd') {
    delete base.hooks.SessionEnd;
  }

  return JSON.stringify(base, null, 2) + '\n';
}

/** The `HOOKS.md` note for deferred (`cursor-json`/`copilot-json`) and `none` profiles. */
function hooksNote(rt: RuntimeMap, profile: string): string {
  if (profile === 'none') {
    return `# Hooks — ${rt.name}

This runtime has no lifecycle-hook system. The Exarchos binding is carried by the
**AGENTS.md** orientation block (the universal always-loaded floor) — see
\`binding/${rt.name}/AGENTS.md\`. No executable hook artifact is generated.

Regenerated by \`npm run build:hooks\`; do not hand-edit.
`;
  }
  return `# Hooks — ${rt.name}

This runtime **supports lifecycle hooks** (profile \`${profile}\`); Exarchos will
render its native hook format in a future release (tracked follow-up). The
Exarchos binding is already active via the **AGENTS.md** orientation block (see
\`binding/${rt.name}/AGENTS.md\`).

To wire lifecycle telemetry manually in the meantime, invoke the
\`exarchos session-start\` / \`exarchos session-end\` observer subcommands from
your harness's session hooks.

Regenerated by \`npm run build:hooks\`; do not hand-edit.
`;
}

/** Write an artifact, creating parent dirs and recording the path for cleanup. */
function writeArtifact(path: string, content: string, written: Set<string>): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  written.add(path);
}

/**
 * Remove artifacts not written this run. Scope is narrow: the top-level Claude
 * hooks.json, per-runtime hook subtrees (hooks.json / HOOKS.md / plugin), and
 * per-runtime binding blocks — never unrelated files under the roots.
 */
function cleanStaleArtifacts(
  outDir: string,
  bindingOutDir: string,
  runtimes: RuntimeMap[],
  keepHooks: Set<string>,
  keepBinding: Set<string>,
): void {
  const topLevel = join(outDir, 'hooks.json');
  if (existsSync(topLevel) && !keepHooks.has(topLevel)) rmSync(topLevel, { force: true });

  for (const rt of runtimes) {
    for (const candidate of [
      join(outDir, rt.name, 'hooks.json'),
      join(outDir, rt.name, 'HOOKS.md'),
      join(outDir, rt.name, 'plugin', 'exarchos-lifecycle.ts'),
    ]) {
      if (existsSync(candidate) && !keepHooks.has(candidate)) rmSync(candidate, { force: true });
    }
    for (const candidate of [
      join(bindingOutDir, rt.name, 'AGENTS.md'),
      join(bindingOutDir, rt.name, 'CLAUDE.md'),
    ]) {
      if (existsSync(candidate) && !keepBinding.has(candidate)) rmSync(candidate, { force: true });
    }
  }
}

// -----------------------------------------------------------------------------
// CLI entry (`npm run build:hooks`)
// -----------------------------------------------------------------------------

export type { MainDeps } from './cli-helpers.js';

export function main(_argv: string[], deps: MainDeps = {}): void {
  const { cwd, exit, log, errLog } = resolveMainDeps(deps);
  const root = cwd();

  let report: HooksBuildReport;
  try {
    report = buildAllHooks({
      srcDir: join(root, 'hooks-src'),
      bindingSrcDir: join(root, 'binding-src'),
      outDir: join(root, 'hooks'),
      bindingOutDir: join(root, 'binding'),
      runtimesDir: join(root, 'runtimes'),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errLog(`[build:hooks] error: ${msg}`);
    exit(1);
    return;
  }

  log(
    `[build:hooks] ${report.bindingBlocksWritten} binding block(s), ` +
      `${report.hooksJsonWritten} hooks.json, ${report.pluginsWritten} plugin(s), ` +
      `${report.notesWritten} note(s)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
