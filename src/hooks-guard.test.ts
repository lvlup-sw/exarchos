/**
 * Tests for the `hooks:guard` CI check (#1476 T10).
 *
 * Mirrors `skills-guard.test.ts`: the guard re-renders the hooks tree
 * in-process against a project root and invokes `git diff --exit-code
 * hooks/`. A non-empty diff (stale committed output, or a hand-edit of a
 * generated file the build just overwrote) makes the guard report a
 * non-zero result so CI fails the PR with a remediation message.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { runHooksGuard } from './hooks-guard.js';
import { buildAllHooks } from './build-hooks.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-guard-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

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
  const hooksBlock = (hasHooks: boolean): string[] =>
    hasHooks
      ? [
          '  hooks:',
          '    profile: claude-json',
          '    canInjectContext: true',
          '    sessionStartEvent: SessionStart',
          '    sessionEndEvent: SessionEnd',
        ]
      : [
          '  hooks:',
          '    profile: none',
          '    canInjectContext: false',
          '    sessionStartEvent: null',
          '    sessionEndEvent: null',
        ];
  const yaml = (name: string, hasHooks: boolean): string =>
    [
      `name: ${name}`,
      'preferredFacade: mcp',
      'capabilities:',
      '  hasSubagents: true',
      '  hasSlashCommands: true',
      ...hooksBlock(hasHooks),
      '  hasSkillChaining: true',
      `  mcpPrefix: "mcp__${name}__"`,
      `skillsInstallPath: "~/.${name}/skills"`,
      'detection:',
      '  binaries: []',
      '  envVars: []',
      placeholders,
    ].join('\n');
  writeFileSync(join(runtimesDir, 'claude.yaml'), yaml('claude', true));
  for (const name of ['codex', 'opencode', 'copilot', 'cursor', 'generic']) {
    writeFileSync(join(runtimesDir, `${name}.yaml`), yaml(name, false));
  }
}

function writeHooksSource(srcDir: string): void {
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, 'hooks.json'),
    JSON.stringify(
      {
        hooks: {
          SessionEnd: [
            { matcher: 'auto', hooks: [{ type: 'command', command: 'exarchos session-end', timeout: 30 }] },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );
}

function writeBindingSource(srcDir: string): void {
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, 'binding.md'),
    'This project uses Exarchos. Route via `{{MCP_PREFIX}}exarchos_workflow`.\n',
  );
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/**
 * Provision a temp project: hooks-src/, runtimes/, a seeded hooks/ tree,
 * all committed so `git diff` starts clean.
 */
function provisionProject(): string {
  const root = makeTempDir();
  writeHooksSource(join(root, 'hooks-src'));
  writeBindingSource(join(root, 'binding-src'));
  writeRuntimeFixtures(join(root, 'runtimes'));
  buildAllHooks({
    srcDir: join(root, 'hooks-src'),
    bindingSrcDir: join(root, 'binding-src'),
    outDir: join(root, 'hooks'),
    bindingOutDir: join(root, 'binding'),
    runtimesDir: join(root, 'runtimes'),
  });
  execSync('git init -q -b main', { cwd: root, env: gitEnv });
  execSync('git add -A', { cwd: root, env: gitEnv });
  execSync('git commit -q -m "seed"', { cwd: root, env: gitEnv });
  return root;
}

describe('runHooksGuard — #1476 T10', () => {
  it('HooksGuard_InSyncTree_ReturnsOk', () => {
    const root = provisionProject();
    const result = runHooksGuard({ cwd: root });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('HooksGuard_SourceChangedNotRegenerated_FailsWithDrift', () => {
    const root = provisionProject();
    // Mutate the source AFTER committing — the committed hooks/ tree is now
    // stale relative to what the build would produce.
    writeFileSync(
      join(root, 'hooks-src', 'hooks.json'),
      JSON.stringify(
        {
          hooks: {
            SessionEnd: [
              { matcher: 'auto', hooks: [{ type: 'command', command: 'exarchos session-end', timeout: 99 }] },
            ],
          },
        },
        null,
        2,
      ) + '\n',
    );

    const result = runHooksGuard({ cwd: root });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/build:hooks|hooks:guard|stale|drift/i);
  });

  it('HooksGuard_CommittedTreeStale_FailsWithDrift', () => {
    const root = provisionProject();
    // Commit a tampered generated file so the committed hooks/ tree no longer
    // matches what the build produces. The build regenerates the correct
    // content; `git diff` against the stale committed version shows drift.
    writeFileSync(join(root, 'hooks', 'hooks.json'), '{"hooks":{"tampered":[]}}\n');
    execSync('git add -A', { cwd: root, env: gitEnv });
    execSync('git commit -q -m "tamper"', { cwd: root, env: gitEnv });

    const result = runHooksGuard({ cwd: root });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
