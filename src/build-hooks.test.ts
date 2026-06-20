/**
 * Tests for the per-runtime binding + lifecycle-hook renderer (#1485).
 *
 * The renderer emits (1) a universal AGENTS.md/CLAUDE.md binding block for every
 * runtime and (2) an active hook artifact dispatched on `capabilities.hooks.profile`
 * (claude-json → hooks.json; opencode-plugin → TS plugin; cursor/copilot/none →
 * a HOOKS.md note). Tested against the REAL runtimes/ topology.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildAllHooks, oneLineDirective } from './build-hooks.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const HOOKS_SRC = join(REPO_ROOT, 'hooks-src');
const BINDING_SRC = join(REPO_ROOT, 'binding-src');
const RUNTIMES = join(REPO_ROOT, 'runtimes');

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

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('hooks-src/hooks.json source (#1485 T5)', () => {
  it('HooksSource_ContainsSessionStartEndAndSubagentStop', () => {
    // #1525 W2 Half 1: subagent-stop restored as a token-telemetry observer.
    const src = JSON.parse(readFileSync(join(HOOKS_SRC, 'hooks.json'), 'utf8'));
    const events = Object.keys(src.hooks);
    expect(events).toContain('SessionStart');
    expect(events).toContain('SessionEnd');
    expect(events).toContain('SubagentStop');
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

describe('buildAllHooks — binding blocks (#1485 T4)', () => {
  it('BuildBinding_EveryRuntime_EmitsBindingBlock', () => {
    const { bindingOutDir, report } = build();
    expect(report.bindingBlocksWritten).toBe(6);
    for (const [rt, file] of [
      ['claude', 'CLAUDE.md'],
      ['codex', 'AGENTS.md'],
      ['opencode', 'AGENTS.md'],
      ['cursor', 'AGENTS.md'],
      ['copilot', 'AGENTS.md'],
      ['generic', 'AGENTS.md'],
    ] as const) {
      const p = join(bindingOutDir, rt, file);
      expect(existsSync(p), `${rt} binding block`).toBe(true);
      const body = readFileSync(p, 'utf8');
      expect(body).toContain('<!-- exarchos:binding:start -->');
      expect(body).toContain('<!-- exarchos:binding:end -->');
      expect(body).toContain('Exarchos');
    }
  });

  it('BuildBinding_Block_CarriesRuntimeMcpPrefix', () => {
    const { bindingOutDir } = build();
    const claude = readFileSync(join(bindingOutDir, 'claude', 'CLAUDE.md'), 'utf8');
    const codex = readFileSync(join(bindingOutDir, 'codex', 'AGENTS.md'), 'utf8');
    expect(claude).toContain('mcp__plugin_exarchos_exarchos__exarchos_');
    expect(codex).toContain('mcp__exarchos__exarchos_');
  });
});

describe('buildAllHooks — claude-json profile (#1485 T6)', () => {
  it('BuildBinding_Claude_RendersSessionStartAndEnd', () => {
    const { outDir } = build();
    const json = JSON.parse(readFileSync(join(outDir, 'hooks.json'), 'utf8'));
    expect(Object.keys(json.hooks)).toContain('SessionStart');
    expect(Object.keys(json.hooks)).toContain('SessionEnd');
    // #1525: Claude declares subagentStopEvent → SubagentStop block present.
    expect(Object.keys(json.hooks)).toContain('SubagentStop');
    expect(json.hooks.SubagentStop[0].hooks[0].command).toContain('subagent-stop');
    expect(json.hooks.SessionStart[0].hooks[0].command).toContain('--directive');
  });

  it('BuildBinding_Codex_RendersSessionStartOnly', () => {
    // G1: Codex's end event is `Stop` (deferred) — no SessionEnd block emitted.
    // #1525: Codex has no subagentStopEvent capability → no SubagentStop block.
    const { outDir } = build();
    const json = JSON.parse(readFileSync(join(outDir, 'codex', 'hooks.json'), 'utf8'));
    expect(Object.keys(json.hooks)).toContain('SessionStart');
    expect(Object.keys(json.hooks)).not.toContain('SessionEnd');
    expect(Object.keys(json.hooks)).not.toContain('SubagentStop');
    expect(json.hooks.SessionStart[0].hooks[0].command).toContain('--directive');
  });

  it('BuildBinding_DispatchesOnProfileNotRuntimeName', () => {
    // Codex (not Claude) also emits hooks.json — proves dispatch keys on the
    // declared profile, not a `name === 'claude'` literal.
    const { outDir } = build();
    expect(existsSync(join(outDir, 'codex', 'hooks.json'))).toBe(true);
  });
});

describe('buildAllHooks — opencode-plugin profile (#1485 T7)', () => {
  it('BuildBinding_OpencodePlugin_EmitsTsPluginNoInjection', () => {
    const { outDir, report } = build();
    expect(report.pluginsWritten).toBe(1);
    const plugin = readFileSync(join(outDir, 'opencode', 'plugin', 'exarchos-lifecycle.ts'), 'utf8');
    expect(plugin).toContain('session.created');
    expect(plugin).toContain('exarchos session-start');
    expect(plugin).not.toContain('additionalContext');
  });
});

describe('buildAllHooks — deferred + none notes (#1485 T8)', () => {
  it('BuildBinding_DeferredProfile_EmitsAccurateNote', () => {
    const { outDir } = build();
    for (const rt of ['cursor', 'copilot']) {
      const note = readFileSync(join(outDir, rt, 'HOOKS.md'), 'utf8');
      expect(note).toContain('supports lifecycle hooks');
      expect(note).not.toContain('does not');
    }
  });

  it('BuildBinding_NoneProfile_GenericNoteReferencesAgentsMd', () => {
    const { outDir } = build();
    const note = readFileSync(join(outDir, 'generic', 'HOOKS.md'), 'utf8');
    expect(note).toContain('AGENTS.md');
    expect(note).toContain('no lifecycle-hook system');
  });
});
