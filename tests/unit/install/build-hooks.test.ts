/**
 * Tests for the renderer of the binding block and the lifecycle hooks. The renderer writes one
 * runtime-neutral binding block and one active hook artifact: the `hooks.json` of the Claude
 * plugin bundle. Each other runtime gets a `HOOKS.md` note. The tests read the real
 * `content/harness/runtimes` maps.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildAllHooks, oneLineDirective, MAX_DIRECTIVE_BYTES } from '../../../src/install/build-hooks.js';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

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

/**
 * Extract the single-quoted `--directive '…'` payload from a hook command. The renderer
 * appends the argument, so the closing quote is the last character of the command.
 */
function directiveOf(command: string): string {
  const marker = "--directive '";
  const start = command.indexOf(marker);
  expect(start, 'directive present in command').toBeGreaterThanOrEqual(0);
  return command.slice(start + marker.length, -1);
}

afterEach(() => {
  while (tempDirs.length) rmrf(tempDirs.pop()!);
});

describe('content/harness/hooks/hooks.json source (#1485 T5; shrink DR-7)', () => {
  /**
   * The source template holds the `SessionStart` on-ramp and the `SubagentStop` token-telemetry
   * hook. It holds no `SessionEnd`, because the launcher owns the session lifecycle.
   */
  it('HooksSource_ContainsSessionStartAndSubagentStop_NoSessionEnd', () => {
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

  /** A `'` becomes `'\''`, so the caller can put the full value in single quotes. */
  it('OneLineDirective_EscapesSingleQuotes_PosixSafe', () => {
    expect(oneLineDirective("don't improvise")).toBe("don'\\''t improvise");
  });
});

describe('buildAllHooks — binding block (#1485 T4; neutralized DR-5)', () => {
  /**
   * The build writes one block at `binding/standard/block.md` and reports one write. It writes
   * no per-runtime binding file.
   */
  it('BuildBinding_EmitsSingleNeutralBlock', () => {
    const { bindingOutDir, report } = build();
    expect(report.bindingBlocksWritten).toBe(1);

    const block = join(bindingOutDir, 'standard', 'block.md');
    expect(existsSync(block), 'standard binding block').toBe(true);
    const body = readFileSync(block, 'utf8');
    expect(body).toContain('<!-- exarchos:binding:start -->');
    expect(body).toContain('<!-- exarchos:binding:end -->');
    expect(body).toContain('Exarchos');

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

  /**
   * The block holds the logical `exarchos:exarchos_*` form and no per-harness `mcp__` prefix,
   * so the same bytes serve each harness.
   */
  it('bindingStandardBlock_SameContentForAllRuntimes', () => {
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
  /**
   * The top-level `hooks.json` is the one active hook artifact. It holds `SubagentStop` and
   * `SessionStart`, and no `SessionEnd`. The `SessionStart` command always holds the binding
   * directive. It starts with bare `exarchos` from PATH and does not use `CLAUDE_PLUGIN_ROOT`.
   */
  it('buildAllHooks_ClaudePlugin_EmitsSubagentStopAndSpecifiedSessionStart_NoSessionEnd', () => {
    const { outDir, report } = build();
    expect(report.hooksJsonWritten).toBe(1);

    const json = JSON.parse(readFileSync(join(outDir, 'hooks.json'), 'utf8'));
    const events = Object.keys(json.hooks);
    expect(events).toContain('SubagentStop');
    expect(events).toContain('SessionStart');
    expect(json.hooks.SubagentStop[0].hooks[0].command).toContain('subagent-stop');
    expect(events).not.toContain('SessionEnd');

    const cmd = json.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain('exarchos session-start');
    expect(cmd).toContain('--directive');
    expect(cmd.startsWith('exarchos session-start')).toBe(true);
    expect(cmd).not.toContain('CLAUDE_PLUGIN_ROOT');
  });

  /**
   * The payload holds the logical form, no `mcp__` prefix and no unrendered token. Its size is
   * at most 4 KiB. It equals `oneLineDirective` of the `binding/standard/block.md` text
   * without the markers.
   */
  it('buildAllHooks_SessionStartDirective_IsNeutralBlockUnder4KiB', () => {
    const { outDir, bindingOutDir } = build();
    const cmd = JSON.parse(readFileSync(join(outDir, 'hooks.json'), 'utf8')).hooks
      .SessionStart[0].hooks[0].command;
    const directive = directiveOf(cmd);

    expect(directive).toContain('exarchos:exarchos_');
    expect(directive).not.toContain('mcp__');
    expect(directive).not.toContain('{{');

    expect(MAX_DIRECTIVE_BYTES).toBe(4096);
    expect(Buffer.byteLength(directive, 'utf8')).toBeLessThanOrEqual(MAX_DIRECTIVE_BYTES);

    const block = readFileSync(join(bindingOutDir, 'standard', 'block.md'), 'utf8');
    const blockProse = block
      .replace('<!-- exarchos:binding:start -->', '')
      .replace('<!-- exarchos:binding:end -->', '');
    expect(directive).toBe(oneLineDirective(blockProse));
  });
});

describe('buildAllHooks — retired lifecycle artifacts (shrink DR-7)', () => {
  /**
   * The build writes no `codex/hooks.json` and no opencode lifecycle plugin, because the
   * launcher owns those lifecycles. No per-runtime directory holds a `hooks.json`.
   */
  it('buildAllHooks_CodexAndOpencodeLifecycleArtifacts_NotEmitted', () => {
    const { outDir } = build();
    expect(existsSync(join(outDir, 'codex', 'hooks.json'))).toBe(false);
    expect(existsSync(join(outDir, 'opencode', 'plugin', 'exarchos-lifecycle.ts'))).toBe(
      false,
    );
    for (const rt of ['codex', 'opencode', 'cursor', 'copilot', 'generic']) {
      expect(existsSync(join(outDir, rt, 'hooks.json')), `${rt} hooks.json`).toBe(false);
    }
  });
});

describe('buildAllHooks — deferred + none notes (#1485 T8; shrink DR-7)', () => {
  /** Cursor, copilot, codex and opencode each get the note that says the runtime supports lifecycle hooks. */
  it('BuildBinding_DeferredProfile_EmitsAccurateNote', () => {
    const { outDir } = build();
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
