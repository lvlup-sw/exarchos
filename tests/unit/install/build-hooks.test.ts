/**
 * Tests for the binding + lifecycle-hook renderer (#1485; hook shrink DR-7).
 *
 * The renderer emits (1) a single runtime-neutral binding block and (2) exactly
 * one active hook artifact — the Claude plugin bundle's `hooks.json` (SubagentStop
 * token-attribution seam + the auto-loaded SessionStart on-ramp, no SessionEnd).
 * Every other runtime's active artifact is retired in favour of the launcher's
 * `launch.*` lifecycle, so codex (`claude-json`) and opencode (`opencode-plugin`)
 * fall through to a deferred HOOKS.md note. Tested against the REAL content/harness/runtimes/ topology.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildAllHooks, oneLineDirective, MAX_DIRECTIVE_BYTES } from '../../../src/install/build-hooks.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const HOOKS_SRC = join(REPO_ROOT, 'content/harness/hooks');
const BINDING_SRC = join(REPO_ROOT, 'content/harness/binding');
const RUNTIMES = join(REPO_ROOT, 'content/harness/runtimes');

const tempDirs: string[] = [];
function freshOut(): { outDir: string; bindingOutDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'binding-build-'));
  tempDirs.push(base);
  return { outDir: join(base, 'hooks'), bindingOutDir: join(base, 'binding') };
}
function build() {
  const { outDir, bindingOutDir } = freshOut();
  const report = buildAllHooks({
    srcDir: HOOKS_SRC,
    bindingSrcDir: BINDING_SRC,
    outDir,
    bindingOutDir,
    runtimesDir: RUNTIMES,
  });
  return { outDir, bindingOutDir, report };
}

/** Extract the single-quoted `--directive '…'` payload from a hook command. */
function directiveOf(command: string): string {
  const marker = "--directive '";
  const start = command.indexOf(marker);
  expect(start, 'directive present in command').toBeGreaterThanOrEqual(0);
  // The payload has no unescaped single quotes (the binding carries none), so
  // the closing quote is the final character of the command.
  return command.slice(start + marker.length, -1);
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('content/harness/hooks/hooks.json source (#1485 T5; shrink DR-7)', () => {
  it('HooksSource_ContainsSessionStartAndSubagentStop_NoSessionEnd', () => {
    // DR-7: SessionEnd is retired (the launcher owns session lifecycle). The
    // source template ships only the SessionStart on-ramp + the SubagentStop
    // token-telemetry seam.
    const src = JSON.parse(readFileSync(join(HOOKS_SRC, 'hooks.json'), 'utf8'));
    const events = Object.keys(src.hooks);
    expect(events).toContain('SessionStart');
    expect(events).toContain('SubagentStop');
    expect(events).not.toContain('SessionEnd');
    expect(src.hooks.SessionStart[0].hooks[0].command).toContain('session-start');
    expect(src.hooks.SubagentStop[0].hooks[0].command).toContain('subagent-stop');
  });
});

describe('oneLineDirective — shell-escape (#1485)', () => {
  it('OneLineDirective_CollapsesWhitespace_SingleLine', () => {
    expect(oneLineDirective('a\n  b\t c')).toBe('a b c');
  });

  it('OneLineDirective_EscapesSingleQuotes_PosixSafe', () => {
    // A directive containing ' must become the '\'' idiom so the caller can wrap
    // the whole value in single quotes without breaking out of the arg.
    expect(oneLineDirective("don't improvise")).toBe("don'\\''t improvise");
  });
});

describe('buildAllHooks — binding block (#1485 T4; neutralized DR-5)', () => {
  it('BuildBinding_EmitsSingleNeutralBlock', () => {
    // Post-collapse: ONE runtime-neutral block at `binding/standard/block.md`,
    // not a per-runtime fork. The report reflects the single write.
    const { bindingOutDir, report } = build();
    expect(report.bindingBlocksWritten).toBe(1);

    const block = join(bindingOutDir, 'standard', 'block.md');
    expect(existsSync(block), 'standard binding block').toBe(true);
    const body = readFileSync(block, 'utf8');
    expect(body).toContain('<!-- exarchos:binding:start -->');
    expect(body).toContain('<!-- exarchos:binding:end -->');
    expect(body).toContain('Exarchos');

    // No per-runtime binding files are emitted anymore.
    for (const [rt, file] of [
      ['claude', 'CLAUDE.md'],
      ['codex', 'AGENTS.md'],
      ['generic', 'AGENTS.md'],
    ] as const) {
      expect(existsSync(join(bindingOutDir, rt, file)), `${rt} legacy binding`).toBe(
        false,
      );
    }
  });

  it('bindingStandardBlock_SameContentForAllRuntimes', () => {
    // The single block is runtime-neutral: it carries the logical
    // `exarchos:exarchos_*` `Server:tool` form and NONE of the per-harness MCP
    // wire prefixes (`mcp__plugin_exarchos_exarchos__`, `mcp__exarchos__`) that
    // the old per-runtime forks baked in — so the same bytes serve every harness.
    const { bindingOutDir } = build();
    const block = readFileSync(
      join(bindingOutDir, 'standard', 'block.md'),
      'utf8',
    );
    expect(block).toContain('exarchos:exarchos_');
    expect(block).not.toContain('mcp__');
    expect(block).not.toContain('{{');
  });
});

describe('buildAllHooks — Claude plugin hooks.json (shrink DR-7)', () => {
  it('buildAllHooks_ClaudePlugin_EmitsSubagentStopAndSpecifiedSessionStart_NoSessionEnd', () => {
    const { outDir, report } = build();
    // The Claude plugin bundle's hooks.json is the sole active hook artifact.
    expect(report.hooksJsonWritten).toBe(1);

    const json = JSON.parse(readFileSync(join(outDir, 'hooks.json'), 'utf8'));
    const events = Object.keys(json.hooks);
    // Retained: SubagentStop token-attribution seam + the SessionStart on-ramp.
    expect(events).toContain('SubagentStop');
    expect(events).toContain('SessionStart');
    expect(json.hooks.SubagentStop[0].hooks[0].command).toContain('subagent-stop');
    // Retired: SessionEnd (launcher owns lifecycle).
    expect(events).not.toContain('SessionEnd');

    // The specified on-ramp bakes the neutral binding directive unconditionally
    // (claude-template-hardcoded — no canInjectContext gate).
    const cmd = json.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain('exarchos session-start');
    expect(cmd).toContain('--directive');
    // Binary resolution DECISION (DR-7): bare `exarchos` on PATH, not the
    // ${CLAUDE_PLUGIN_ROOT}-relative form.
    expect(cmd.startsWith('exarchos session-start')).toBe(true);
    expect(cmd).not.toContain('CLAUDE_PLUGIN_ROOT');
  });

  it('buildAllHooks_SessionStartDirective_IsNeutralBlockUnder4KiB', () => {
    const { outDir, bindingOutDir } = build();
    const cmd = JSON.parse(readFileSync(join(outDir, 'hooks.json'), 'utf8')).hooks
      .SessionStart[0].hooks[0].command;
    const directive = directiveOf(cmd);

    // The baked payload carries the neutral logical form, never a per-harness
    // `mcp__` wire prefix or a stray unrendered token.
    expect(directive).toContain('exarchos:exarchos_');
    expect(directive).not.toContain('mcp__');
    expect(directive).not.toContain('{{');

    // ≤ 4 KiB cap (DR-7).
    expect(MAX_DIRECTIVE_BYTES).toBe(4096);
    expect(Buffer.byteLength(directive, 'utf8')).toBeLessThanOrEqual(MAX_DIRECTIVE_BYTES);

    // The payload IS the runtime-neutral `binding/standard/block.md` content
    // (markers stripped, whitespace collapsed) — one content source, DR-6.
    const block = readFileSync(join(bindingOutDir, 'standard', 'block.md'), 'utf8');
    const blockProse = block
      .replace('<!-- exarchos:binding:start -->', '')
      .replace('<!-- exarchos:binding:end -->', '');
    expect(directive).toBe(oneLineDirective(blockProse));
  });
});

describe('buildAllHooks — retired lifecycle artifacts (shrink DR-7)', () => {
  it('buildAllHooks_CodexAndOpencodeLifecycleArtifacts_NotEmitted', () => {
    const { outDir } = build();
    // Codex's `claude-json` hooks.json is retired — codex is NOT the Claude
    // plugin bundle, and the launcher owns its lifecycle.
    expect(existsSync(join(outDir, 'codex', 'hooks.json'))).toBe(false);
    // The opencode lifecycle plugin is retired (its source template is deleted).
    expect(existsSync(join(outDir, 'opencode', 'plugin', 'exarchos-lifecycle.ts'))).toBe(
      false,
    );
    // No hooks.json lands under a per-runtime subtree anymore; the only one is
    // the top-level Claude plugin artifact.
    for (const rt of ['codex', 'opencode', 'cursor', 'copilot', 'generic']) {
      expect(existsSync(join(outDir, rt, 'hooks.json')), `${rt} hooks.json`).toBe(false);
    }
  });
});

describe('buildAllHooks — deferred + none notes (#1485 T8; shrink DR-7)', () => {
  it('BuildBinding_DeferredProfile_EmitsAccurateNote', () => {
    const { outDir } = build();
    // cursor/copilot renderers are deferred; codex/opencode active artifacts are
    // retired — all four fall through to the "supports lifecycle hooks" note.
    for (const rt of ['cursor', 'copilot', 'codex', 'opencode']) {
      const note = readFileSync(join(outDir, rt, 'HOOKS.md'), 'utf8');
      expect(note, `${rt} note`).toContain('supports lifecycle hooks');
      expect(note, `${rt} note`).not.toContain('does not');
    }
  });

  it('BuildBinding_NoneProfile_GenericNoteReferencesAgentsMd', () => {
    const { outDir } = build();
    const note = readFileSync(join(outDir, 'generic', 'HOOKS.md'), 'utf8');
    expect(note).toContain('AGENTS.md');
    expect(note).toContain('no lifecycle-hook system');
  });
});
