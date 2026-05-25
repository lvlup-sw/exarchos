/**
 * Tests for the per-runtime hooks renderer (`buildAllHooks`).
 *
 * #1476 (T8): hooks become a first-class, per-runtime templated artifact —
 * a sibling to `buildAllSkills`. Only `hasHooks` runtimes (per
 * `src/runtimes/types.ts`, `claude` alone today) emit a generated
 * `hooks.json`; non-`hasHooks` runtimes emit nothing executable but a
 * documented manual-steps note. The Claude artifact lands at the
 * well-known `hooks/hooks.json` plugin path so it stays auto-loaded.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildAllHooks } from './build-hooks.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'exarchos-hooks-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Lay down a minimal set of runtime YAMLs. Mirrors the production
 * topology where only `claude` declares `hasHooks: true`.
 */
function writeRuntimeFixtures(runtimesDir: string): void {
  mkdirSync(runtimesDir, { recursive: true });
  const placeholders = [
    'placeholders:',
    '  MCP_PREFIX: "mcp__plugin_exarchos_exarchos__"',
    '  COMMAND_PREFIX: "/"',
    '  TASK_TOOL: "Task"',
    '  CHAIN: "[chain]"',
    '  SPAWN_AGENT_CALL: "spawn"',
    '  SUBAGENT_COMPLETION_HOOK: "completion"',
    '  SUBAGENT_RESULT_API: "result"',
    '',
  ].join('\n');

  const yaml = (name: string, hasHooks: boolean, mcpPrefix: string): string =>
    [
      `name: ${name}`,
      'preferredFacade: mcp',
      'capabilities:',
      '  hasSubagents: true',
      '  hasSlashCommands: true',
      `  hasHooks: ${hasHooks}`,
      '  hasSkillChaining: true',
      `  mcpPrefix: "${mcpPrefix}"`,
      `skillsInstallPath: "~/.${name}/skills"`,
      'detection:',
      '  binaries:',
      `    - ${name}`,
      '  envVars:',
      `    - ${name.toUpperCase()}_SESSION`,
      placeholders,
    ].join('\n');

  writeFileSync(join(runtimesDir, 'claude.yaml'), yaml('claude', true, 'mcp__plugin_exarchos_exarchos__'));
  writeFileSync(join(runtimesDir, 'codex.yaml'), yaml('codex', false, 'mcp__exarchos__'));
  writeFileSync(join(runtimesDir, 'opencode.yaml'), yaml('opencode', false, 'mcp__exarchos__'));
  writeFileSync(join(runtimesDir, 'generic.yaml'), yaml('generic', false, 'mcp__exarchos__'));
  writeFileSync(join(runtimesDir, 'copilot.yaml'), yaml('copilot', false, 'mcp__exarchos__'));
  writeFileSync(join(runtimesDir, 'cursor.yaml'), yaml('cursor', false, 'mcp__exarchos__'));
}

/**
 * Write an observer-only hooks source template carrying `{{MCP_PREFIX}}`.
 */
function writeHooksSource(srcDir: string): void {
  mkdirSync(srcDir, { recursive: true });
  const template = JSON.stringify(
    {
      hooks: {
        SessionEnd: [
          {
            matcher: 'auto',
            hooks: [{ type: 'command', command: 'exarchos session-end', timeout: 30 }],
          },
        ],
        SubagentStop: [
          {
            matcher: 'exarchos-implementer|exarchos-fixer',
            hooks: [{ type: 'command', command: 'exarchos subagent-stop', timeout: 10 }],
          },
        ],
      },
      // The prefix is templated so the renderer proves it substitutes tokens.
      _mcpPrefix: '{{MCP_PREFIX}}',
    },
    null,
    2,
  );
  writeFileSync(join(srcDir, 'hooks.json'), template + '\n');
}

describe('buildAllHooks — #1476 T8', () => {
  it('BuildAllHooks_ClaudeRuntime_LandsAtHooksJson', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'hooks-src');
    const outDir = join(root, 'hooks');
    const runtimesDir = join(root, 'runtimes');
    writeRuntimeFixtures(runtimesDir);
    writeHooksSource(srcDir);

    buildAllHooks({ srcDir, outDir, runtimesDir });

    // Claude output lands at the well-known plugin path: hooks/hooks.json.
    const claudePath = join(outDir, 'hooks.json');
    expect(existsSync(claudePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(claudePath, 'utf8'));
    expect(parsed.hooks.SessionEnd).toBeDefined();
    expect(parsed.hooks.SubagentStop).toBeDefined();
  });

  it('BuildAllHooks_SubstitutesMcpPrefix', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'hooks-src');
    const outDir = join(root, 'hooks');
    const runtimesDir = join(root, 'runtimes');
    writeRuntimeFixtures(runtimesDir);
    writeHooksSource(srcDir);

    buildAllHooks({ srcDir, outDir, runtimesDir });

    const claudeBody = readFileSync(join(outDir, 'hooks.json'), 'utf8');
    expect(claudeBody).toContain('mcp__plugin_exarchos_exarchos__');
    expect(claudeBody).not.toContain('{{MCP_PREFIX}}');
  });

  it('BuildAllHooks_NonHasHooksRuntimes_EmitNoHooksJson', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'hooks-src');
    const outDir = join(root, 'hooks');
    const runtimesDir = join(root, 'runtimes');
    writeRuntimeFixtures(runtimesDir);
    writeHooksSource(srcDir);

    buildAllHooks({ srcDir, outDir, runtimesDir });

    // Non-hasHooks runtimes (codex, opencode) must NOT produce an executable
    // hooks.json — hooks are a Claude-only artifact today.
    expect(existsSync(join(outDir, 'codex', 'hooks.json'))).toBe(false);
    expect(existsSync(join(outDir, 'opencode', 'hooks.json'))).toBe(false);
  });

  it('BuildAllHooks_NonHasHooksRuntimes_EmitDocumentedManualNote', () => {
    const root = makeTempDir();
    const srcDir = join(root, 'hooks-src');
    const outDir = join(root, 'hooks');
    const runtimesDir = join(root, 'runtimes');
    writeRuntimeFixtures(runtimesDir);
    writeHooksSource(srcDir);

    const report = buildAllHooks({ srcDir, outDir, runtimesDir });

    // Documented manual note for non-hasHooks runtimes.
    const codexNote = join(outDir, 'codex', 'HOOKS.md');
    const opencodeNote = join(outDir, 'opencode', 'HOOKS.md');
    expect(existsSync(codexNote)).toBe(true);
    expect(existsSync(opencodeNote)).toBe(true);
    expect(readFileSync(codexNote, 'utf8')).toMatch(/manual/i);

    // Report reflects exactly one runtime (claude) emitting an executable
    // artifact; the other five non-hasHooks runtimes emit a manual note.
    expect(report.hooksWritten).toBe(1);
    expect(report.manualNotesWritten).toBe(5);
  });
});
