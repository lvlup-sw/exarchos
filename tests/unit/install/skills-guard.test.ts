/**
 * Tests for the `skills:guard` CI check.
 * The guard runs the generators again in a project root, then runs `git diff --exit-code` on each generated tree.
 * A diff makes the guard fail with a message that names the remediation command.
 * Each test builds a git repository in a temp directory and gives it to `runSkillsGuard({ cwd })`.
 * Thus no test changes the generated trees of this repository.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { runSkillsGuard } from '../../../src/install/skills-guard.js';
import { buildAllSkills, clearRegistryLookup } from '../../../src/install/build-skills.js';
import { buildCommandAliases } from '../../../src/install/build-command-aliases.js';
import { loadAllRuntimes } from '../../../src/install/runtimes/load.js';
import { COMMAND_TO_SKILL } from '../../../src/install/config/canonical-skills.js';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skills-guard-test-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * No-op `regenerateAgents` for the tests that do not exercise the agent trees.
 * The default regenerator needs `node_modules/tsx` and `src/runtime/agents/generate-agents.ts` under `cwd`, and a temp project has neither.
 */
const noopRegenerateAgents = (_cwd: string): void => {
};

/** Removes each temp directory. A removal error does not fail the test. */
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      rmrf(d);
    } catch {
    }
  }
});

/**
 * Write a minimal valid runtime YAML for each runtime that the loader requires.
 * Each YAML declares every `RuntimeTokenKey` placeholder, because the build rejects a runtime that omits one.
 * `AGENT_LABEL` is not a canonical token. The fixture skill sources reference it.
 */
function writeRuntimeFixtures(runtimesDir: string): void {
  mkdirSync(runtimesDir, { recursive: true });
  const names = ['generic', 'claude', 'codex', 'opencode', 'copilot', 'cursor'];
  for (const name of names) {
    writeFileSync(
      join(runtimesDir, `${name}.yaml`),
      [
        `name: ${name}`,
        `preferredFacade: mcp`,
        `capabilities:`,
        `  hasSubagents: true`,
        `  hasSlashCommands: true`,
        `  hasSkillChaining: true`,
        `  mcpPrefix: "mcp__${name}__"`,
        `skillsInstallPath: "~/.${name}/skills"`,
        `detection:`,
        `  binaries: []`,
        `  envVars: []`,
        `placeholders:`,
        `  AGENT_LABEL: "agent"`,
        `  MCP_PREFIX: "mcp__${name}__"`,
        `  COMMAND_PREFIX: "/"`,
        `  TASK_TOOL: "Task"`,
        `  CHAIN: "[invoke {{next}} with {{args}}]"`,
        `  SPAWN_AGENT_CALL: 'Task({ prompt: \"{{prompt}}\" })'`,
        `  SUBAGENT_COMPLETION_HOOK: "subagent completion signal (poll-based)"`,
        `  SUBAGENT_RESULT_API: "[poll subagent result]"`,
        ``,
      ].join('\n'),
    );
  }
}

/**
 * Provision a temp git repository that looks like a project root.
 * One commit holds the `content/foo/SKILL.md` source, the runtime fixtures, and the `rendered/skills/` tree, so `git diff` starts clean.
 * The git identity comes from environment variables, so the commit does not depend on the ambient git config.
 *
 * `{{TASK_TOOL}}` is an orchestration token, so `foo` renders once for each runtime under `rendered/skills/<runtime>/foo/`.
 * The drift tests assert those paths. A procedural skill renders only to `rendered/skills/standard/foo/`.
 */
async function provisionProject(): Promise<string> {
  const root = makeTempDir();

  mkdirSync(join(root, 'content', 'foo'), { recursive: true });
  writeFileSync(
    join(root, 'content', 'foo', 'SKILL.md'),
    'Hello {{AGENT_LABEL}} {{TASK_TOOL}}\n',
  );
  writeRuntimeFixtures(join(root, 'content/harness/runtimes'));

  buildAllSkills({
    srcDir: join(root, 'content'),
    outDir: join(root, 'rendered', 'skills'),
    runtimesDir: join(root, 'content/harness/runtimes'),
  });

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv });
  await execFileAsync('git', ['add', '-A'], { cwd: root, env: gitEnv });
  await execFileAsync('git', ['commit', '-q', '-m', 'seed'], { cwd: root, env: gitEnv });

  return root;
}

/**
 * Provision a temp project like `provisionProject`, with a `{{CALL exarchos_workflow set {...}}}` macro in the skill source.
 * `exarchos_workflow` is a known tool name, so `parseCallMacro` accepts the macro.
 * The macro has three arg keys, so an unstable key order changes the rendered bytes.
 * `{{TASK_TOOL}}` keeps `foo` an orchestration skill, and the determinism test reads its claude render.
 */
async function provisionProjectWithCallMacro(): Promise<string> {
  const root = makeTempDir();

  mkdirSync(join(root, 'content', 'foo'), { recursive: true });
  writeFileSync(
    join(root, 'content', 'foo', 'SKILL.md'),
    [
      'Hello {{AGENT_LABEL}} {{TASK_TOOL}}',
      '',
      'Invoke the workflow:',
      '',
      '{{CALL exarchos_workflow set {"featureId":"X","phase":"plan","stage":"begin"}}}',
      '',
    ].join('\n'),
  );
  writeRuntimeFixtures(join(root, 'content/harness/runtimes'));

  buildAllSkills({
    srcDir: join(root, 'content'),
    outDir: join(root, 'rendered', 'skills'),
    runtimesDir: join(root, 'content/harness/runtimes'),
  });

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv });
  await execFileAsync('git', ['add', '-A'], { cwd: root, env: gitEnv });
  await execFileAsync('git', ['commit', '-q', '-m', 'seed'], { cwd: root, env: gitEnv });

  return root;
}

describe('skills-guard — task 023', () => {
  it('SkillsGuard_CleanBuild_Passes', async () => {
    const root = await provisionProject();

    const result = runSkillsGuard({ cwd: root, regenerateAgents: noopRegenerateAgents });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, 'rendered', 'skills', 'claude', 'foo', 'SKILL.md'))).toBe(
      true,
    );
  });

  /**
   * The new source has no `{{TASK_TOOL}}`, so `foo` becomes a procedural skill and its build fails on `{{AGENT_LABEL}}`.
   * Thus the guard fails on the build error, and this test does not reach the `git diff` of a changed source.
   */
  it('SkillsGuard_UncommittedDiff_Fails', async () => {
    const root = await provisionProject();

    writeFileSync(
      join(root, 'content', 'foo', 'SKILL.md'),
      'Hello {{AGENT_LABEL}} — updated\n',
    );

    const result = runSkillsGuard({ cwd: root, regenerateAgents: noopRegenerateAgents });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  /**
   * The message must name the build command, so a developer can copy it from the CI log.
   * The message must also say that the tree is stale.
   * As in the test before this one, the new source fails the build, so the message under test is the build-failure message.
   */
  it('SkillsGuard_FailureMessage_IncludesRemediation', async () => {
    const root = await provisionProject();

    writeFileSync(
      join(root, 'content', 'foo', 'SKILL.md'),
      'Hello {{AGENT_LABEL}} — changed\n',
    );

    const result = runSkillsGuard({ cwd: root, regenerateAgents: noopRegenerateAgents });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/npm run build:skills/);
    expect(result.message).toMatch(/stale|out of sync|drift/i);
  });

  /**
   * The test commits a hand edit of a generated file. The build of the guard writes the generated content again.
   * Thus the diff against HEAD is not empty, and the message names the file that drifted.
   */
  it('SkillsGuard_DirectSkillEdit_Detected', async () => {
    const root = await provisionProject();

    const generated = join(root, 'rendered', 'skills', 'claude', 'foo', 'SKILL.md');
    const before = readFileSync(generated, 'utf8');
    writeFileSync(generated, before + '\n<!-- hand edit -->\n');

    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    await execFileAsync('git', ['add', '-A'], { cwd: root, env: gitEnv });
    await execFileAsync('git', ['commit', '-q', '-m', 'hand-edit generated file'], {
      cwd: root,
      env: gitEnv,
    });

    const result = runSkillsGuard({ cwd: root, regenerateAgents: noopRegenerateAgents });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toMatch(/skills\/claude\/foo\/SKILL\.md/);
  });
});

/**
 * The guard also detects drift in the generated agent trees.
 * Each test commits an agent file with a hand edit, then injects a regenerator that writes a different body to that file.
 * Thus the diff against HEAD is not empty after the guard runs, and the message must name the file.
 * The injected regenerator keeps the real adapter registry out of the temp project.
 */
describe('skills-guard — task 13 agents/ drift', () => {
  /**
   * The guard must detect drift in the agent tree of each runtime, not only in the Claude tree.
   * `.codex/agents/` represents the four non-Claude directories, because one `git diff` call covers all the agent trees.
   */
  it('SkillsGuard_NonClaudeAgentsDirDrift_FailsCheck', async () => {
    const root = await provisionProject();

    const codexAgentsDir = join(root, '.codex', 'agents');
    mkdirSync(codexAgentsDir, { recursive: true });
    writeFileSync(
      join(codexAgentsDir, 'implementer.toml'),
      '# HAND EDITED — not canonical\n',
    );

    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    await execFileAsync('git', ['add', '-A'], { cwd: root, env: gitEnv });
    await execFileAsync('git', ['commit', '-q', '-m', 'drifted codex agents file'], {
      cwd: root,
      env: gitEnv,
    });

    const regenerateAgents = (cwd: string): void => {
      writeFileSync(
        join(cwd, '.codex', 'agents', 'implementer.toml'),
        '# CANONICAL codex implementer body\n',
      );
    };

    const result = runSkillsGuard({ cwd: root, regenerateAgents });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toMatch(/\.codex\/agents\/implementer\.toml/);
  });

  it('SkillsGuard_AgentsDirDrift_FailsCheck', async () => {
    const root = await provisionProject();

    const agentsDir = join(root, 'rendered', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'implementer.md'),
      'HAND EDITED — not canonical\n',
    );

    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    await execFileAsync('git', ['add', '-A'], { cwd: root, env: gitEnv });
    await execFileAsync('git', ['commit', '-q', '-m', 'drifted agents file'], {
      cwd: root,
      env: gitEnv,
    });

    const regenerateAgents = (cwd: string): void => {
      writeFileSync(
        join(cwd, 'rendered', 'agents', 'implementer.md'),
        'CANONICAL implementer body\n',
      );
    };

    const result = runSkillsGuard({ cwd: root, regenerateAgents });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toMatch(/agents\/implementer\.md/);
  });
});

/**
 * The guard must report no drift on a tree that holds rendered `{{CALL}}` macro output.
 * The MCP render of a macro is `JSON.stringify` output, and the arg keys keep their source order.
 * If the render gives different bytes on a rebuild, the guard reports drift on an unchanged source.
 */
describe('skills-guard — task 011 CALL macro determinism', () => {
  /** With no registry lookup, `renderCallMacros` skips schema validation, so the test does not need the MCP schemas. */
  beforeEach(() => {
    clearRegistryLookup();
  });

  /**
   * The first guard run rebuilds the tree and diffs it against the seed commit.
   * The second run comes after one more build from the same source, and it must also find no diff.
   * Between the runs, the test reads the claude render to prove that the build expanded the macro.
   */
  it('SkillsGuard_AfterCallMacroRender_NoDrift', async () => {
    const root = await provisionProjectWithCallMacro();

    const firstResult = runSkillsGuard({ cwd: root, regenerateAgents: noopRegenerateAgents });
    expect(firstResult.ok).toBe(true);
    expect(firstResult.exitCode).toBe(0);

    const rendered = readFileSync(
      join(root, 'rendered', 'skills', 'claude', 'foo', 'SKILL.md'),
      'utf8',
    );
    expect(rendered).toContain(
      'mcp__claude__exarchos_workflow(',
    );
    expect(rendered).toContain('"action": "set"');

    buildAllSkills({
      srcDir: join(root, 'content'),
      outDir: join(root, 'rendered', 'skills'),
      runtimesDir: join(root, 'content/harness/runtimes'),
    });

    const secondResult = runSkillsGuard({ cwd: root, regenerateAgents: noopRegenerateAgents });
    expect(secondResult.ok).toBe(true);
    expect(secondResult.exitCode).toBe(0);
  });
});

/** The one alias tree that the alias fixtures emit, relative to the project root. */
const ALIASES_OPENCODE_DIR = join('rendered', 'command-aliases', 'opencode');

/**
 * Write the runtime fixtures of `writeRuntimeFixtures`, with `capabilities.canonicalCommandAliases` added.
 * Only opencode sets it to `true`, so `buildCommandAliases` emits one tree: `command-aliases/opencode/`.
 */
function writeAliasRuntimeFixtures(runtimesDir: string): void {
  mkdirSync(runtimesDir, { recursive: true });
  const names = ['generic', 'claude', 'codex', 'opencode', 'copilot', 'cursor'];
  for (const name of names) {
    writeFileSync(
      join(runtimesDir, `${name}.yaml`),
      [
        `name: ${name}`,
        `preferredFacade: mcp`,
        `capabilities:`,
        `  hasSubagents: true`,
        `  hasSlashCommands: true`,
        `  hasSkillChaining: true`,
        `  mcpPrefix: "mcp__${name}__"`,
        `  canonicalCommandAliases: ${name === 'opencode' ? 'true' : 'false'}`,
        `skillsInstallPath: "~/.${name}/skills"`,
        `detection:`,
        `  binaries: []`,
        `  envVars: []`,
        `placeholders:`,
        `  AGENT_LABEL: "agent"`,
        `  MCP_PREFIX: "mcp__${name}__"`,
        `  COMMAND_PREFIX: "/"`,
        `  TASK_TOOL: "Task"`,
        `  CHAIN: "[invoke {{next}} with {{args}}]"`,
        `  SPAWN_AGENT_CALL: 'Task({ prompt: \"{{prompt}}\" })'`,
        `  SUBAGENT_COMPLETION_HOOK: "subagent completion signal (poll-based)"`,
        `  SUBAGENT_RESULT_API: "[poll subagent result]"`,
        ``,
      ].join('\n'),
    );
  }
}

/**
 * Provision a temp project that also has the alias inputs.
 * `rendered/commands/` holds one command file for each `COMMAND_TO_SKILL` key, because `buildCommandAliases` reads each `description` from there.
 * The seed commit holds the skills tree and the `command-aliases/opencode/` tree, so `git diff` starts clean for both.
 */
async function provisionProjectWithAliases(): Promise<string> {
  const root = makeTempDir();

  mkdirSync(join(root, 'content', 'foo'), { recursive: true });
  writeFileSync(
    join(root, 'content', 'foo', 'SKILL.md'),
    'Hello {{AGENT_LABEL}} {{TASK_TOOL}}\n',
  );
  writeAliasRuntimeFixtures(join(root, 'content/harness/runtimes'));

  const commandsDir = join(root, 'rendered', 'commands');
  mkdirSync(commandsDir, { recursive: true });
  for (const command of Object.keys(COMMAND_TO_SKILL)) {
    writeFileSync(
      join(commandsDir, `${command}.md`),
      [`---`, `description: Run the ${command} workflow.`, `---`, ``, `# /${command}`, ``].join(
        '\n',
      ),
    );
  }

  buildAllSkills({
    srcDir: join(root, 'content'),
    outDir: join(root, 'rendered', 'skills'),
    runtimesDir: join(root, 'content/harness/runtimes'),
  });

  buildCommandAliases({
    runtimes: loadAllRuntimes(join(root, 'content/harness/runtimes')),
    commandsDir,
    outDir: join(root, 'rendered', 'command-aliases'),
  });

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv });
  await execFileAsync('git', ['add', '-A'], { cwd: root, env: gitEnv });
  await execFileAsync('git', ['commit', '-q', '-m', 'seed'], { cwd: root, env: gitEnv });

  return root;
}

/**
 * The guard also protects the generated `rendered/command-aliases/` tree.
 * `buildAllSkills` does not emit aliases, so the guard must regenerate the aliases before it diffs that tree.
 * A changed command description fails the guard, and so does a committed hand edit of an alias file.
 */
describe('skills-guard — T4 command-aliases/ drift (#1472)', () => {
  it('AliasesGuard_CleanBuild_Passes', async () => {
    const root = await provisionProjectWithAliases();

    const result = runSkillsGuard({
      cwd: root,
      regenerateAgents: noopRegenerateAgents,
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    const firstCommand = Object.keys(COMMAND_TO_SKILL)[0];
    expect(
      existsSync(join(root, ALIASES_OPENCODE_DIR, `${firstCommand}.md`)),
    ).toBe(true);
  });

  /**
   * The test changes a command description and does not regenerate the aliases, so the committed alias tree is stale.
   * The guard must regenerate the aliases, find the diff, and name the alias tree in the message.
   */
  it('AliasesGuard_StaleCommandDescription_Fails', async () => {
    const root = await provisionProjectWithAliases();

    const firstCommand = Object.keys(COMMAND_TO_SKILL)[0];
    writeFileSync(
      join(root, 'rendered', 'commands', `${firstCommand}.md`),
      [
        `---`,
        `description: Run the ${firstCommand} workflow — DESCRIPTION CHANGED.`,
        `---`,
        ``,
        `# /${firstCommand}`,
        ``,
      ].join('\n'),
    );

    const result = runSkillsGuard({
      cwd: root,
      regenerateAgents: noopRegenerateAgents,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toMatch(/command-aliases/);
  });

  it('AliasesGuard_DirectAliasEdit_Detected', async () => {
    const root = await provisionProjectWithAliases();

    const firstCommand = Object.keys(COMMAND_TO_SKILL)[0];
    const generated = join(root, ALIASES_OPENCODE_DIR, `${firstCommand}.md`);
    const before = readFileSync(generated, 'utf8');
    writeFileSync(generated, before + '\n<!-- hand edit -->\n');

    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    await execFileAsync('git', ['add', '-A'], { cwd: root, env: gitEnv });
    await execFileAsync('git', ['commit', '-q', '-m', 'hand-edit generated alias'], {
      cwd: root,
      env: gitEnv,
    });

    const result = runSkillsGuard({
      cwd: root,
      regenerateAgents: noopRegenerateAgents,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toMatch(/command-aliases\/opencode/);
  });
});
