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
import { runHooksGuard } from '../../../src/install/hooks-guard.js';
import { buildAllHooks } from '../../../src/install/build-hooks.js';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
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
  // Runtime-neutral logical prose (DR-5): the block is placeholder-free, so the
  // build renders it once into `binding/standard/block.md`.
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
function provisionProject(): string {
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
  execSync('git init -q -b main', { cwd: root, env: gitEnv });
  execSync('git add -A', { cwd: root, env: gitEnv });
  execSync('git commit -q -m "seed"', { cwd: root, env: gitEnv });
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
 * Provision a temp project shaped like the post-shrink (DR-7) world: a hooks.json
 * source with SessionStart + SubagentStop (no SessionEnd), and runtimes exercising
 * every post-shrink dispatch branch — claude (`claude-json` → the sole active
 * hooks.json), codex (`claude-json` non-Claude → note), opencode (`opencode-plugin`
 * → note; a plugin template is present so a *reverted* renderer would still build
 * and emit the retired plugin, making the shape assertions the drift detector).
 */
function provisionShrunkProject(): { root: string; outDir: string } {
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
  // Present only so a reverted (pre-shrink) renderer can still build; the current
  // renderer never reads it (opencode falls through to a note).
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
  execSync('git init -q -b main', { cwd: root, env: gitEnv });
  execSync('git add -A', { cwd: root, env: gitEnv });
  execSync('git commit -q -m "seed"', { cwd: root, env: gitEnv });
  return { root, outDir };
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

describe('runHooksGuard — shrunk hook tree (DR-7)', () => {
  it('hooksGuard_ShrunkTree_Passes', () => {
    const { root, outDir } = provisionShrunkProject();

    // The freshly built + committed shrunk tree round-trips with no drift.
    const result = runHooksGuard({ cwd: root });
    expect(result.ok, result.message).toBe(true);
    expect(result.exitCode).toBe(0);

    // Tie the guard-pass to the actual shrink so a reverted renderer is caught:
    // the sole active artifact is the Claude plugin hooks.json (SubagentStop, no
    // SessionEnd), and neither codex nor opencode emit a lifecycle artifact.
    const claude = JSON.parse(readFileSync(join(outDir, 'hooks.json'), 'utf8'));
    expect(Object.keys(claude.hooks)).toContain('SubagentStop');
    expect(Object.keys(claude.hooks)).not.toContain('SessionEnd');
    expect(existsSync(join(outDir, 'codex', 'hooks.json'))).toBe(false);
    expect(
      existsSync(join(outDir, 'opencode', 'plugin', 'exarchos-lifecycle.ts')),
    ).toBe(false);
  });
});
