/**
 * Per-runtime binding + lifecycle-hook renderer (#1485, evolved from #1476 T8).
 *
 * A sibling to `buildAllSkills`. Renders two things from a single source of
 * truth each:
 *
 *  1. **Binding block** (universal, runtime-neutral — DR-5) — the orientation
 *     directive (`binding-src/binding.md`) is now placeholder-free logical
 *     prose (`exarchos:exarchos_*`), so it collapses to ONE block that serves
 *     every harness's always-loaded instructions surface. Output lands at a
 *     single `<bindingOutDir>/standard/block.md` (no per-runtime fork); consumer
 *     writers place it into `CLAUDE.md` (Claude) / `AGENTS.md` (everyone else).
 *
 *  2. **Active hook artifact** — post-shrink (DR-7) the ONE active artifact is
 *     the Claude plugin bundle's `hooks.json`; the launcher's `launch.*` events
 *     are now the session-lifecycle authority, so `SessionEnd`, the codex hooks
 *     artifact, and the opencode lifecycle plugin are all retired. Dispatch is
 *     keyed on the declared `capabilities.hooks.profile` (INV-4), with a single
 *     documented harness fact — the Claude plugin bundle is the sole consumer of
 *     the well-known `<outDir>/hooks.json` autoload path:
 *       - `claude-json` + `claude` → `hooks.json` (`SubagentStop` token-
 *                             attribution seam + the auto-loaded `SessionStart`
 *                             on-ramp carrying the neutral binding `--directive`).
 *                             No `SessionEnd`.
 *       - `claude-json` + non-Claude (Codex) → a `HOOKS.md` note (its native hook
 *                             artifact is retired; the launcher owns lifecycle).
 *       - `opencode-plugin` (opencode) → a `HOOKS.md` note (lifecycle plugin
 *                             retired; the launcher owns lifecycle).
 *       - `cursor-json` / `copilot-json` → a `HOOKS.md` note (renderer deferred;
 *                             the AGENTS.md binding is active now).
 *       - `none`            → a `HOOKS.md` note (no hook system; AGENTS.md only).
 *
 * ADR: docs/adrs/2026-05-24-hook-layer-observe-only.md (observe-only, fail-open);
 * DR-7 (docs/specs/2026-07-04-harness-conform-and-shrink.md) — hook shrink.
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
import { render, STANDARD_TREE_NAME } from './build-skills.js';
import { renderBindingBlock, BINDING_SOURCE_FILE } from './binding.js';
import { resolveMainDeps, type MainDeps } from './cli-helpers.js';

/** The Claude-schema hooks.json template filename (profile `claude-json`). */
export const HOOKS_SOURCE_FILE = 'hooks.json';

/**
 * Byte cap on the baked SessionStart `--directive` payload (DR-7: "≤ 4 KiB").
 * The neutral binding block is ~0.5 KiB today; the guard fails the build loudly
 * if a future edit to `binding-src/binding.md` blows past the on-ramp budget
 * rather than silently shipping an oversized hook command.
 */
export const MAX_DIRECTIVE_BYTES = 4096;

/** Counts returned so callers (CLI, tests, guard) can report without rescanning. */
export interface HooksBuildReport {
  /**
   * Runtime-neutral binding blocks written. Post-collapse (DR-5) this is
   * always 1 — a single `binding/standard/block.md` serves every harness.
   */
  bindingBlocksWritten: number;
  /**
   * Runtimes that emitted an executable `hooks.json`. Post-shrink (DR-7) this
   * is the Claude plugin bundle only — always 1.
   */
  hooksJsonWritten: number;
  /** Runtimes that emitted a `HOOKS.md` note (deferred / retired / `none`). */
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

  const writtenHooks = new Set<string>();
  const writtenBinding = new Set<string>();
  const report: HooksBuildReport = {
    bindingBlocksWritten: 0,
    hooksJsonWritten: 0,
    notesWritten: 0,
  };

  // The binding directive is runtime-neutral (DR-5): one block, one directive,
  // rendered ONCE from placeholder-free logical prose and shared by every
  // harness. `render(directiveBody, {})` (via the neutral helpers) guards
  // against a stray `{{TOKEN}}` reintroduction — it throws rather than shipping
  // a literal token in either surface. This is the same content source as
  // `binding/standard/block.md` (one source, two delivery mechanisms — DR-6),
  // baked into the Claude on-ramp's `--directive` payload below.
  const directiveOneLine = oneLineDirective(render(directiveBody, {}));

  // DR-7 cap: the baked on-ramp directive must be ≤ 4 KiB. Fail the build loudly
  // rather than ship an oversized hook command.
  const directiveBytes = Buffer.byteLength(directiveOneLine, 'utf8');
  if (directiveBytes > MAX_DIRECTIVE_BYTES) {
    throw new Error(
      `buildAllHooks: SessionStart --directive payload is ${directiveBytes} bytes, ` +
        `exceeding the ${MAX_DIRECTIVE_BYTES}-byte (4 KiB) cap — shrink binding-src/binding.md.`,
    );
  }

  // ── Universal binding block (written once) ──────────────────────────────────
  // Post-collapse there is no per-runtime fork: a single `binding/standard/block.md`
  // serves every harness's always-loaded instructions surface.
  writeArtifact(
    join(opts.bindingOutDir, STANDARD_TREE_NAME, 'block.md'),
    renderBindingBlock(directiveBody),
    writtenBinding,
  );
  report.bindingBlocksWritten = 1;

  // Active-artifact strategy map keyed on the declared `hooks.profile` (INV-4).
  // Typing it `Record<HooksProfile, …>` gives compile-time exhaustiveness: adding
  // a profile to the union is a build error until a renderer is wired, instead of
  // silently falling into the note branch. The `claude-json` renderer carries the
  // single documented harness-fact carve-out (the Claude plugin bundle) — see its
  // comment; every other branch stays profile-driven.
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
      // Post-shrink (DR-7) the only active hook artifact is the CLAUDE plugin
      // bundle's `hooks.json`. This is the one documented harness fact the hook
      // renderer keys on: the Claude plugin bundle is the sole consumer of the
      // well-known `<outDir>/hooks.json` autoload path (mirrors the existing
      // name-literals in `hooksJsonPathFor` / `instructionsFileFor`). Codex also
      // declares `claude-json`, but its native hooks artifact is retired — the
      // launcher's `launch.*` events own its lifecycle now — so it falls through
      // to the deferred HOOKS.md note instead of emitting a stale hooks.json.
      if (rt.name !== 'claude') {
        emitNote(rt);
        return;
      }
      const json = renderClaudePluginHooks(hooksTemplate, directiveOneLine);
      writeArtifact(hooksJsonPathFor(opts.outDir, rt.name), json, writtenHooks);
      report.hooksJsonWritten++;
    },
    // Lifecycle plugin retired (DR-7): the launcher owns opencode's lifecycle;
    // opencode's binding rides AGENTS.md → deferred HOOKS.md note.
    'opencode-plugin': emitNote,
    // Renderers deferred → AGENTS.md binding + an accurate HOOKS.md note.
    'cursor-json': emitNote,
    'copilot-json': emitNote,
    'none': emitNote,
  };

  for (const rt of runtimes) {
    // Active hook artifact (dispatch on declared profile). The binding block is
    // no longer per-runtime — it was written once above.
    renderers[rt.capabilities.hooks?.profile ?? 'none'](rt);
  }

  cleanStaleArtifacts(opts.outDir, opts.bindingOutDir, runtimes, writtenHooks, writtenBinding);
  return report;
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
 * Build the Claude plugin bundle's `hooks.json` (DR-7) — the single active hook
 * artifact post-shrink. The source template (`hooks-src/hooks.json`) already
 * carries exactly what the bundle ships: the `SubagentStop` token-attribution
 * seam and the auto-loaded `SessionStart` on-ramp; `SessionEnd` was dropped from
 * the source because the launcher's `launch.*` events are now the session-
 * lifecycle authority. The one transform here is baking the runtime-neutral
 * binding directive into the SessionStart command as `--directive`.
 *
 * This is **claude-template-hardcoded**: there is NO `canInjectContext` capability
 * lookup (that consumption is retired — the field is deprecated in
 * `runtimes/types.ts`). Only the Claude runtime reaches this renderer, and the
 * Claude plugin's SessionStart hook can always return orientation context, so the
 * directive is baked unconditionally.
 *
 * Binary resolution — DECISION: the hook command invokes **bare `exarchos`**
 * (PATH resolution). Exarchos installs its single-file CLI globally (the
 * documented install path: `scripts/get-exarchos.{sh,ps1}`), so `exarchos`
 * resolves in the plugin-hook shell without knowing the plugin's on-disk layout.
 * The `${CLAUDE_PLUGIN_ROOT}`-relative form
 * (`"${CLAUDE_PLUGIN_ROOT}/<bin>/exarchos session-start"`) was evaluated as the
 * more robust alternative for bundle-only installs where the binary ships INSIDE
 * the plugin and is absent from PATH; it is deferred (a tracked follow-up)
 * because it couples the hook command to the plugin's internal directory layout,
 * whereas the current install contract already guarantees a PATH binary.
 */
function renderClaudePluginHooks(template: string, directiveOneLine: string): string {
  const base = JSON.parse(template) as {
    hooks: Record<string, Array<{ hooks: Array<{ command?: string }> }>>;
  };

  for (const group of base.hooks.SessionStart ?? []) {
    for (const h of group.hooks) {
      if (typeof h.command === 'string' && h.command.includes('session-start')) {
        h.command = `${h.command} --directive '${directiveOneLine}'`;
      }
    }
  }

  return JSON.stringify(base, null, 2) + '\n';
}

/** The `HOOKS.md` note for deferred (`cursor-json`/`copilot-json`) and `none` profiles. */
function hooksNote(rt: RuntimeMap, profile: string): string {
  if (profile === 'none') {
    return `# Hooks — ${rt.name}

This runtime has no lifecycle-hook system. The Exarchos binding is carried by the
**AGENTS.md** orientation block (the universal always-loaded floor) — the
runtime-neutral block source is \`binding/standard/block.md\`. No executable hook
artifact is generated.

Regenerated by \`npm run build:hooks\`; do not hand-edit.
`;
  }
  return `# Hooks — ${rt.name}

This runtime **supports lifecycle hooks** (profile \`${profile}\`); Exarchos will
render its native hook format in a future release (tracked follow-up). The
Exarchos binding is already active via the **AGENTS.md** orientation block (the
runtime-neutral block source is \`binding/standard/block.md\`).

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
 * the now-legacy per-runtime binding blocks — never unrelated files under the
 * roots. Post-collapse (DR-5) no per-runtime binding block is written, so the
 * `binding/<rt>/AGENTS.md`/`CLAUDE.md` sweep here deletes the stale committed
 * forks; the single `binding/standard/block.md` is in `keepBinding` and is
 * never a cleanup candidate.
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
      `${report.hooksJsonWritten} hooks.json, ${report.notesWritten} note(s)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
