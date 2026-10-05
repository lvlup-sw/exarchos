/**
 * Tests for the `hooks:guard` CI check. This file is the hooks twin of
 * `skills-guard.test.ts`.
 *
 * The guard builds the hooks tree in process and runs `git diff --exit-code` on
 * `hooks/` and `binding/`. A diff means stale committed output or a hand edit of
 * a generated file. On a diff, the guard returns exit code 1.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { runHooksGuard } from '../../../src/install/hooks-guard.js';
import { buildAllHooks } from '../../../src/install/build-hooks.js';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-guard-test-'));
  tempDirs.push(dir);
  return dir;
}

/** Removes the temp directories. A removal failure does not fail the test. */
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      rmrf(d);
    } catch {
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

/**
 * Writes a binding block with no placeholder. The build renders it once, into
 * `binding/standard/block.md`.
 */
function writeBindingSource(srcDir: string): void {
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, 'binding.md'),
    'This project uses Exarchos. Route via `exarchos:exarchos_workflow`.\n',
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
 * Provision a temp project: content/harness/hooks/, runtimes/, a seeded hooks/ tree,
 * all committed so `git diff` starts clean.
 */
async function provisionProject(): Promise<string> {
  const root = makeTempDir();
  writeHooksSource(join(root, 'content/harness/hooks'));
  writeBindingSource(join(root, 'content/harness/binding'));
  writeRuntimeFixtures(join(root, 'content/harness/runtimes'));
  buildAllHooks({
    srcDir: join(root, 'content/harness/hooks'),
    bindingSrcDir: join(root, 'content/harness/binding'),
    outDir: join(root, 'hooks'),
    bindingOutDir: join(root, 'binding'),
    runtimesDir: join(root, 'content/harness/runtimes'),
  });
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv });
  await execFileAsync('git', ['add', '-A'], { cwd: root, env: gitEnv });
  await execFileAsync('git', ['commit', '-q', '-m', 'seed'], { cwd: root, env: gitEnv });
  return root;
}

const shrunkPlaceholders = [
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

function shrunkRuntimeYaml(name: string, hooksLines: string[]): string {
  return [
    `name: ${name}`,
    'preferredFacade: mcp',
    'capabilities:',
    '  hasSubagents: true',
    '  hasSlashCommands: true',
    ...hooksLines,
    '  hasSkillChaining: true',
    `  mcpPrefix: "mcp__${name}__"`,
    `skillsInstallPath: "~/.${name}/skills"`,
    'detection:',
    '  binaries: []',
    '  envVars: []',
    shrunkPlaceholders,
  ].join('\n');
}

/**
 * Provision a temp project whose `hooks.json` source holds `SessionStart` and
 * `SubagentStop`, and no `SessionEnd`. The runtimes cover the `claude-json`,
 * `opencode-plugin` and `none` profiles. The claude runtime gets the one active
 * `hooks.json`, and each other runtime gets a note. Codex also declares
 * `claude-json`, so it covers the note branch of that profile.
 *
 * The opencode plugin template is present, although the renderer does not read
 * it. Thus a renderer that emits the plugin again still builds, and the shape
 * assertions catch it.
 */
async function provisionShrunkProject(): Promise<{ root: string; outDir: string }> {
  const root = makeTempDir();
  const srcDir = join(root, 'content/harness/hooks');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, 'hooks.json'),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            { matcher: 'startup|resume', hooks: [{ type: 'command', command: 'exarchos session-start', timeout: 10 }] },
          ],
          SubagentStop: [
            { matcher: '*', hooks: [{ type: 'command', command: 'exarchos subagent-stop', timeout: 30 }] },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(join(srcDir, 'opencode-plugin.ts.tmpl'), 'export const X = 1;\n');

  writeBindingSource(join(root, 'content/harness/binding'));

  const runtimesDir = join(root, 'content/harness/runtimes');
  mkdirSync(runtimesDir, { recursive: true });
  writeFileSync(
    join(runtimesDir, 'claude.yaml'),
    shrunkRuntimeYaml('claude', [
      '  hooks:',
      '    profile: claude-json',
      '    canInjectContext: true',
      '    sessionStartEvent: SessionStart',
      '    sessionEndEvent: SessionEnd',
      '    subagentStopEvent: SubagentStop',
    ]),
  );
  writeFileSync(
    join(runtimesDir, 'codex.yaml'),
    shrunkRuntimeYaml('codex', [
      '  hooks:',
      '    profile: claude-json',
      '    canInjectContext: true',
      '    sessionStartEvent: SessionStart',
      '    sessionEndEvent: Stop',
    ]),
  );
  writeFileSync(
    join(runtimesDir, 'opencode.yaml'),
    shrunkRuntimeYaml('opencode', [
      '  hooks:',
      '    profile: opencode-plugin',
      '    canInjectContext: false',
      '    sessionStartEvent: session.created',
      '    sessionEndEvent: session.idle',
    ]),
  );
  for (const name of ['generic', 'copilot', 'cursor']) {
    writeFileSync(
      join(runtimesDir, `${name}.yaml`),
      shrunkRuntimeYaml(name, [
        '  hooks:',
        '    profile: none',
        '    canInjectContext: false',
        '    sessionStartEvent: null',
        '    sessionEndEvent: null',
      ]),
    );
  }

  const outDir = join(root, 'hooks');
  buildAllHooks({
    srcDir,
    bindingSrcDir: join(root, 'content/harness/binding'),
    outDir,
    bindingOutDir: join(root, 'binding'),
    runtimesDir,
  });
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv });
  await execFileAsync('git', ['add', '-A'], { cwd: root, env: gitEnv });
  await execFileAsync('git', ['commit', '-q', '-m', 'seed'], { cwd: root, env: gitEnv });
  return { root, outDir };
}

describe('runHooksGuard — #1476 T10', () => {
  it('HooksGuard_InSyncTree_ReturnsOk', async () => {
    const root = await provisionProject();
    const result = runHooksGuard({ cwd: root });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  /** The test changes the hook source after the commit, so the committed `hooks/` tree is stale. */
  it('HooksGuard_SourceChangedNotRegenerated_FailsWithDrift', async () => {
    const root = await provisionProject();
    writeFileSync(
      join(root, 'content/harness/hooks', 'hooks.json'),
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

  /**
   * The test commits a tampered generated file. The guard builds the correct
   * content, and `git diff` shows the drift.
   */
  it('HooksGuard_CommittedTreeStale_FailsWithDrift', async () => {
    const root = await provisionProject();
    writeFileSync(join(root, 'hooks', 'hooks.json'), '{"hooks":{"tampered":[]}}\n');
    await execFileAsync('git', ['add', '-A'], { cwd: root, env: gitEnv });
    await execFileAsync('git', ['commit', '-q', '-m', 'tamper'], { cwd: root, env: gitEnv });

    const result = runHooksGuard({ cwd: root });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});

describe('runHooksGuard — shrunk hook tree (DR-7)', () => {
  /**
   * A pass of the guard is not sufficient, so the test also asserts the shape of
   * the shrunk tree. The Claude `hooks.json` is the one active artifact, and
   * codex and opencode emit no lifecycle artifact.
   */
  it('hooksGuard_ShrunkTree_Passes', async () => {
    const { root, outDir } = await provisionShrunkProject();

    const result = runHooksGuard({ cwd: root });
    expect(result.ok, result.message).toBe(true);
    expect(result.exitCode).toBe(0);

    const claude = JSON.parse(readFileSync(join(outDir, 'hooks.json'), 'utf8'));
    expect(Object.keys(claude.hooks)).toContain('SubagentStop');
    expect(Object.keys(claude.hooks)).not.toContain('SessionEnd');
    expect(existsSync(join(outDir, 'codex', 'hooks.json'))).toBe(false);
    expect(
      existsSync(join(outDir, 'opencode', 'plugin', 'exarchos-lifecycle.ts')),
    ).toBe(false);
  });
});
