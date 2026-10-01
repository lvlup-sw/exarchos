/**
 * Renders the binding block and the lifecycle-hook artifacts for each runtime. It is a sibling of `buildAllSkills`.
 * The binding directive `content/harness/binding/binding.md` has no placeholders.
 * Thus one block at `<bindingOutDir>/standard/block.md` serves the always-loaded instructions file of each harness.
 *
 * The one active hook artifact is the `hooks.json` of the Claude plugin bundle. The `launch.*` events of the launcher own the session lifecycle.
 * Dispatch uses the declared `capabilities.hooks.profile`, not a runtime name.
 * The one exception is a harness fact: only the Claude plugin bundle reads `<outDir>/hooks.json`. Each other runtime gets a `HOOKS.md` note.
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
 * Byte cap on the baked SessionStart `--directive` payload.
 * When an edit to `content/harness/binding/binding.md` goes over the cap, the build fails. It does not ship an oversized hook command.
 */
export const MAX_DIRECTIVE_BYTES = 4096;

/** Counts returned so callers (CLI, tests, guard) can report without rescanning. */
export interface HooksBuildReport {
  /** Runtime-neutral binding blocks written. It is always 1, because one `binding/standard/block.md` serves every harness. */
  bindingBlocksWritten: number;
  /** Runtimes that emitted an executable `hooks.json`. Only the Claude runtime does, so the count is 1 when it is loaded. */
  hooksJsonWritten: number;
  /** Runtimes that emitted a `HOOKS.md` note (deferred / retired / `none`). */
  notesWritten: number;
}

/**
 * Render the binding block and the active hook artifacts for every runtime.
 * `render(directiveBody, {})` throws on a stray `{{TOKEN}}`, so no literal token ships.
 * The same directive goes into `binding/standard/block.md` and into the `--directive` payload of the Claude on-ramp.
 * The profile map is a `Record<HooksProfile, ...>`, so a new profile is a build error until it has a renderer.
 * Codex also declares `claude-json`, but it gets a `HOOKS.md` note, because the launcher owns its lifecycle.
 *
 * @param opts.srcDir        Hook templates root (`content/harness/hooks/`).
 * @param opts.bindingSrcDir Binding directive root (`content/harness/binding/`).
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

  const directiveOneLine = oneLineDirective(render(directiveBody, {}));

  const directiveBytes = Buffer.byteLength(directiveOneLine, 'utf8');
  if (directiveBytes > MAX_DIRECTIVE_BYTES) {
    throw new Error(
      `buildAllHooks: SessionStart --directive payload is ${directiveBytes} bytes, ` +
        `exceeding the ${MAX_DIRECTIVE_BYTES}-byte (4 KiB) cap — shrink content/harness/binding/binding.md.`,
    );
  }

  writeArtifact(
    join(opts.bindingOutDir, STANDARD_TREE_NAME, 'block.md'),
    renderBindingBlock(directiveBody),
    writtenBinding,
  );
  report.bindingBlocksWritten = 1;

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
      if (rt.name !== 'claude') {
        emitNote(rt);
        return;
      }
      const json = renderClaudePluginHooks(hooksTemplate, directiveOneLine);
      writeArtifact(hooksJsonPathFor(opts.outDir, rt.name), json, writtenHooks);
      report.hooksJsonWritten++;
    },
    'opencode-plugin': emitNote,
    'cursor-json': emitNote,
    'copilot-json': emitNote,
    'none': emitNote,
  };

  for (const rt of runtimes) {
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
 * Build the `hooks.json` of the Claude plugin bundle from `content/harness/hooks/hooks.json`.
 * The template holds the `SubagentStop` token-attribution hook and the `SessionStart` on-ramp. The only change bakes the directive into the SessionStart command as `--directive`.
 * The function reads no `canInjectContext` capability. Only the Claude runtime reaches it, and its SessionStart hook can always return context.
 *
 * The command calls bare `exarchos` from PATH, because the installer puts the single-file CLI on PATH.
 * A `${CLAUDE_PLUGIN_ROOT}`-relative path couples the command to the internal layout of the plugin.
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

/** The `HOOKS.md` note for each runtime that gets no `hooks.json`. The `none` profile has its own text. */
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
 * Remove the artifacts that this run did not write. The scope is the top-level `hooks.json`, the known files of each runtime hook subtree, and the per-runtime binding blocks.
 * No per-runtime binding block is written, so the `binding/<rt>/AGENTS.md` and `CLAUDE.md` sweep removes old forks. Other files under the roots stay.
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

export type { MainDeps } from './cli-helpers.js';

export function main(_argv: string[], deps: MainDeps = {}): void {
  const { cwd, exit, log, errLog } = resolveMainDeps(deps);
  const root = cwd();

  let report: HooksBuildReport;
  try {
    report = buildAllHooks({
      srcDir: join(root, 'content/harness/hooks'),
      bindingSrcDir: join(root, 'content/harness/binding'),
      outDir: join(root, 'hooks'),
      bindingOutDir: join(root, 'binding'),
      runtimesDir: join(root, 'content/harness/runtimes'),
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
