/**
 * Tests for the `skills:guard` CI check.
 *
 * The guard runs the skill build in-process against a project root and then
 * invokes `git diff --exit-code skills/`. If the build produced any output
 * that differs from the committed tree, the guard reports a non-zero result
 * so CI can fail the PR with a clear remediation message.
 *
 * Implements: DR-1 (guard), DR-10 (stale-output path).
 *
 * Isolation strategy: each test provisions a temp directory, runs
 * `git init` inside it, lays down a minimal `content/` + `content/harness/runtimes/`
 * fixture tree, runs one build so `skills/` exists, commits everything,
 * and then hands that directory to `runSkillsGuard({ cwd })`. Tests
 * never touch the repo's own `skills/` tree.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { runSkillsGuard } from './skills-guard.js';
import { buildAllSkills, clearRegistryLookup } from './build-skills.js';
import { buildCommandAliases } from './build-command-aliases.js';
import { loadAllRuntimes } from './runtimes/load.js';
import { COMMAND_TO_SKILL } from './config/canonical-skills.js';
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
  const dir = mkdtempSync(join(tmpdir(), 'skills-guard-test-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * No-op `regenerateAgents` callback for tests that exercise only the
 * `skills/` half of the guard. The real default tries to spawn
 * `tsx src/runtime/agents/generate-agents.ts` against
 * `cwd`, which doesn't exist in a temp sandbox. Tests that *want* to
 * exercise the agents path inject their own writer instead.
 */
const noopRegenerateAgents = (_cwd: string): void => {
  /* intentionally empty */
};

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

/**
 * Write a minimal valid runtime map YAML for every runtime the loader
 * requires. Matches the fixture used by `build-skills-cli.test.ts` so
 * the guard sees a realistic set of runtimes.
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
        // Wave A: every runtime YAML must declare every RuntimeTokenKey
        // entry. Add the canonical set so `assertRuntimeTokenCoverage`
        // is satisfied; AGENT_LABEL stays for legacy fixture references.
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
 * Provision a temp directory that looks like a real project root:
 *   - `git init` with committer identity set locally
 *   - `content/foo/SKILL.md` source
 *   - `content/harness/runtimes/*.yaml` fixtures
 *   - `skills/` generated from an initial `buildAllSkills()` call
 *   - all of the above committed, so `git diff` starts clean
 */
function provisionProject(): string {
  const root = makeTempDir();

  mkdirSync(join(root, 'content', 'foo'), { recursive: true });
  // `foo` carries an orchestration token ({{TASK_TOOL}}) so it classifies as
  // an orchestration skill and renders per-runtime under `skills/<runtime>/foo/`
  // (DR-2). The skills-guard drift tests below assert against those per-runtime
  // paths; a procedural skill would collapse to `skills/standard/foo/` instead.
  writeFileSync(
    join(root, 'content', 'foo', 'SKILL.md'),
    'Hello {{AGENT_LABEL}} {{TASK_TOOL}}\n',
  );
  writeRuntimeFixtures(join(root, 'content/harness/runtimes'));

  // Seed the `skills/` tree so the guard has something to compare against.
  buildAllSkills({
    srcDir: join(root, 'content'),
    outDir: join(root, 'skills'),
    runtimesDir: join(root, 'content/harness/runtimes'),
  });

  // Initialize git and commit everything so `git diff` starts clean.
  // Using `-c` flags rather than `git config` keeps the committer identity
  // scoped to this invocation and does not rely on the ambient git config.
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  execSync('git init -q -b main', { cwd: root, env: gitEnv });
  execSync('git add -A', { cwd: root, env: gitEnv });
  execSync('git commit -q -m "seed"', { cwd: root, env: gitEnv });

  return root;
}

/**
 * Provision a temp project like `provisionProject`, but the source
 * `SKILL.md` contains a `{{CALL exarchos_workflow set {...}}}` macro so
 * the build exercises the CALL-macro rendering pathway (task 007/009).
 *
 * Used by the task 011 determinism test below to prove that
 * `renderCallMacros` produces byte-identical output across repeated
 * builds — which is what makes `skills:guard` safe to run on trees that
 * include rendered CALL output.
 *
 * We intentionally:
 *   - use a known tool name (`exarchos_workflow`) so `parseCallMacro`
 *     passes its `KNOWN_TOOLS` check, and
 *   - leave the registry lookup unset (see `beforeEach` below) so
 *     `validateCallMacro` is skipped and the test does not depend on
 *     the MCP server schemas.
 */
function provisionProjectWithCallMacro(): string {
  const root = makeTempDir();

  mkdirSync(join(root, 'content', 'foo'), { recursive: true });
  // Multi-key args stress-test JSON key-ordering determinism — the
  // invariant we are locking in is that `JSON.stringify` on the parsed
  // args object produces the same bytes every build, regardless of how
  // many times we re-render.
  writeFileSync(
    join(root, 'content', 'foo', 'SKILL.md'),
    [
      // {{TASK_TOOL}} makes `foo` an orchestration skill so it renders
      // per-runtime; the determinism assertions below target the claude
      // per-runtime render's expanded MCP call.
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
    outDir: join(root, 'skills'),
    runtimesDir: join(root, 'content/harness/runtimes'),
  });

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  execSync('git init -q -b main', { cwd: root, env: gitEnv });
  execSync('git add -A', { cwd: root, env: gitEnv });
  execSync('git commit -q -m "seed"', { cwd: root, env: gitEnv });

  return root;
}

describe('skills-guard — task 023', () => {
  it('SkillsGuard_CleanBuild_Passes', () => {
    const root = provisionProject();

    const result = runSkillsGuard({ cwd: root, regenerateAgents: noopRegenerateAgents });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, 'skills', 'claude', 'foo', 'SKILL.md'))).toBe(
      true,
    );
  });

  it('SkillsGuard_UncommittedDiff_Fails', () => {
    const root = provisionProject();

    // Mutate the source so a subsequent build produces different output
    // than what is currently committed under `skills/`. We do NOT commit
    // the source change — the guard should still fire because the
    // regenerated `skills/` tree now differs from HEAD.
    writeFileSync(
      join(root, 'content', 'foo', 'SKILL.md'),
      'Hello {{AGENT_LABEL}} — updated\n',
    );

    const result = runSkillsGuard({ cwd: root, regenerateAgents: noopRegenerateAgents });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it('SkillsGuard_FailureMessage_IncludesRemediation', () => {
    const root = provisionProject();

    // Force a drift by editing the source without rebuilding.
    writeFileSync(
      join(root, 'content', 'foo', 'SKILL.md'),
      'Hello {{AGENT_LABEL}} — changed\n',
    );

    const result = runSkillsGuard({ cwd: root, regenerateAgents: noopRegenerateAgents });

    expect(result.ok).toBe(false);
    // Remediation must name the build command so a developer can copy
    // it verbatim from the CI log.
    expect(result.message).toMatch(/npm run build:skills/);
    // And the message should make clear what the failure *is* — i.e.
    // that the generated skills tree is stale or out of sync.
    expect(result.message).toMatch(/stale|out of sync|drift/i);
  });

  it('SkillsGuard_DirectSkillEdit_Detected', () => {
    const root = provisionProject();

    // Simulate a developer hand-editing a generated file. The build
    // itself will overwrite that edit, which is exactly how the guard
    // detects the drift: after build, `git diff skills/` shows the
    // generated content minus the hand-edit.
    const generated = join(root, 'skills', 'claude', 'foo', 'SKILL.md');
    const before = readFileSync(generated, 'utf8');
    writeFileSync(generated, before + '\n<!-- hand edit -->\n');

    // Commit the hand-edit so HEAD contains the bad state. Now a fresh
    // build will regenerate the original (un-edited) content and
    // `git diff skills/` against HEAD will be non-empty.
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    execSync('git add -A', { cwd: root, env: gitEnv });
    execSync('git commit -q -m "hand-edit generated file"', {
      cwd: root,
      env: gitEnv,
    });

    const result = runSkillsGuard({ cwd: root, regenerateAgents: noopRegenerateAgents });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    // The diff body returned by the guard should mention the generated
    // file path so developers can see *which* file drifted.
    expect(result.message).toMatch(/skills\/claude\/foo\/SKILL\.md/);
  });
});

/**
 * Task 13: extend `skills:guard` to detect drift in the generated
 * `agents/` tree as well as `skills/`.
 *
 * Today the guard only checks `skills/`. A developer who hand-edits
 * `agents/implementer.md` (or any of the four agent files emitted by
 * `generate-agents.ts`) can land that drift in main without the CI
 * guard catching it. This test asserts the guard fans out to a second
 * `git diff --exit-code agents/` check and fails on any agents drift.
 *
 * Test mechanic mirrors `SkillsGuard_DirectSkillEdit_Detected`:
 *   1. Seed a temp project as usual (skills clean, committed).
 *   2. Commit an `agents/implementer.md` whose content differs from
 *      the canonical generator output.
 *   3. After the guard runs, `git diff agents/` against HEAD must be
 *      non-empty (the regeneration overwrote the hand-edit).
 *
 * To avoid wiring the full real `generateAgents` registry into a temp
 * sandbox (which would require copying every adapter/spec module),
 * this test injects a deterministic regenerator that just writes a
 * known canonical body to `agents/implementer.md`. The production
 * default invokes `generate-agents.ts` via tsx in a child process —
 * see `defaultRegenerateAgents` in `skills-guard.ts`.
 */
describe('skills-guard — task 13 agents/ drift', () => {
  /**
   * Regression for Sentry #1181 HIGH: the guard must detect drift in
   * EVERY agent output tree, not only `agents/` (Claude). When a non-
   * Claude adapter (`.codex/`, `.cursor/`, `.opencode/`, `.github/`)
   * regenerates a different artifact than what's committed, CI must
   * fail — otherwise stale runtime artifacts can land on main.
   *
   * This test seeds a drifted `.codex/agents/implementer.toml`,
   * injects a regenerator that writes the canonical body for it, and
   * asserts the guard surfaces the drift. The four non-Claude
   * directories share the same code path so a single representative
   * regression is sufficient.
   */
  it('SkillsGuard_NonClaudeAgentsDirDrift_FailsCheck', () => {
    const root = provisionProject();

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
    execSync('git add -A', { cwd: root, env: gitEnv });
    execSync('git commit -q -m "drifted codex agents file"', {
      cwd: root,
      env: gitEnv,
    });

    // Regenerator writes the canonical Codex body — different from
    // the committed hand-edited content above, so `git diff
    // .codex/agents/` will be non-empty.
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

  it('SkillsGuard_AgentsDirDrift_FailsCheck', () => {
    const root = provisionProject();

    // Seed a committed `agents/implementer.md` whose content differs
    // from what the (injected) regenerator below will produce. After
    // the guard regenerates, `git diff agents/` against HEAD will be
    // non-empty — this is exactly the same drift-detection mechanic
    // the `skills/` check already uses.
    const agentsDir = join(root, 'agents');
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
    execSync('git add -A', { cwd: root, env: gitEnv });
    execSync('git commit -q -m "drifted agents file"', {
      cwd: root,
      env: gitEnv,
    });

    // Inject a deterministic regenerator so the test does not need
    // the real adapter registry. After the guard calls this, the
    // file's content differs from HEAD — the drift state we need
    // the guard to detect.
    const regenerateAgents = (cwd: string): void => {
      writeFileSync(
        join(cwd, 'agents', 'implementer.md'),
        'CANONICAL implementer body\n',
      );
    };

    const result = runSkillsGuard({ cwd: root, regenerateAgents });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    // The diff body should mention the agents file path so a
    // developer can see *which* file drifted, just like the
    // `skills/` check does.
    expect(result.message).toMatch(/agents\/implementer\.md/);
  });
});

/**
 * Task 011: skills:guard tolerance for rendered `{{CALL}}` macro output.
 *
 * This is an integration-level determinism test. `renderCallMacros` emits
 * `JSON.stringify(args, null, 2)` output for the MCP facade (and
 * `--flag value` pairs for the CLI facade); both are deterministic by
 * design because the underlying args object is constructed with a fixed
 * key ordering (parse order preserved by V8). If that invariant ever
 * broke — e.g. a future refactor switched to `Object.keys().sort()` in a
 * non-idempotent way, or `JSON.stringify` was replaced with a
 * reflection-based pretty-printer — `skills:guard` would start
 * false-positiving on rebuilds. This test locks the invariant in place.
 */
describe('skills-guard — task 011 CALL macro determinism', () => {
  beforeEach(() => {
    // Ensure no prior test's `setRegistryLookup` leaks into this one.
    // The determinism invariant holds independently of registry validation,
    // and we don't want to require the MCP server schemas to be loaded.
    clearRegistryLookup();
  });

  it('SkillsGuard_AfterCallMacroRender_NoDrift', () => {
    const root = provisionProjectWithCallMacro();

    // First guard invocation: the seed build already committed the
    // rendered output; the guard rebuilds in-process and diffs against
    // HEAD. If rendering is deterministic, the diff is empty.
    const firstResult = runSkillsGuard({ cwd: root, regenerateAgents: noopRegenerateAgents });
    expect(firstResult.ok).toBe(true);
    expect(firstResult.exitCode).toBe(0);

    // Sanity: the rendered output actually contains the expanded MCP
    // call (proves we exercised the macro path, not just a no-op).
    const rendered = readFileSync(
      join(root, 'skills', 'claude', 'foo', 'SKILL.md'),
      'utf8',
    );
    expect(rendered).toContain(
      'mcp__claude__exarchos_workflow(',
    );
    expect(rendered).toContain('"action": "set"');

    // Second build + guard: re-render from the same source and confirm
    // the output is still byte-identical to what is committed. This is
    // the core determinism assertion — any non-determinism in
    // `renderCallMacros` (e.g. unstable key ordering in JSON.stringify)
    // would cause this second guard to fail even though nothing
    // changed in the source.
    buildAllSkills({
      srcDir: join(root, 'content'),
      outDir: join(root, 'skills'),
      runtimesDir: join(root, 'content/harness/runtimes'),
    });

    const secondResult = runSkillsGuard({ cwd: root, regenerateAgents: noopRegenerateAgents });
    expect(secondResult.ok).toBe(true);
    expect(secondResult.exitCode).toBe(0);
  });
});

/**
 * T4 (#1472): the same guard that protects `skills/` must also protect
 * the generated `command-aliases/**` tree emitted by T2's
 * `buildCommandAliases`. The alias tree is a build artifact like
 * `skills/`: a contributor who edits a `commands/*.md` description (the
 * lifted source) or the `COMMAND_TO_SKILL` map without regenerating must
 * get a red CI signal, exactly as for skills drift.
 *
 * Determinism note: `buildAllSkills` (the function the guard already
 * calls) does NOT emit aliases — alias emission lives in
 * `buildCommandAliases`, invoked separately by `build:skills`'s `main()`.
 * So the guard cannot simply widen its diff scope; it must also
 * regenerate aliases before diffing. These tests lock that in.
 */
const ALIASES_OPENCODE_DIR = join('command-aliases', 'opencode');

/**
 * Write runtime fixtures for the alias path. Identical to
 * `writeRuntimeFixtures` but flips `capabilities.canonicalCommandAliases`
 * on for opencode (and off for everyone else) so `buildCommandAliases`
 * emits exactly one tree — `command-aliases/opencode/` — mirroring the
 * real repo state after T2.
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
 * Provision a temp project that also has the alias inputs:
 *   - `commands/<name>.md` (frontmatter `description`) for every
 *     `COMMAND_TO_SKILL` key — the source `buildCommandAliases` lifts
 *   - opencode runtime with `canonicalCommandAliases: true`
 *   - `skills/` + `command-aliases/opencode/` both generated and committed
 * so `git diff` starts clean across both trees.
 */
function provisionProjectWithAliases(): string {
  const root = makeTempDir();

  mkdirSync(join(root, 'content', 'foo'), { recursive: true });
  // Orchestration token keeps `foo` on the per-runtime path (see
  // `provisionProject`); the alias tree is what these tests actually diff.
  writeFileSync(
    join(root, 'content', 'foo', 'SKILL.md'),
    'Hello {{AGENT_LABEL}} {{TASK_TOOL}}\n',
  );
  writeAliasRuntimeFixtures(join(root, 'content/harness/runtimes'));

  // One command file per map entry so `buildCommandAliases` finds its
  // lifted `description` source for every canonical name.
  const commandsDir = join(root, 'commands');
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
    outDir: join(root, 'skills'),
    runtimesDir: join(root, 'content/harness/runtimes'),
  });

  // Seed the alias tree exactly as `build:skills`'s main() does.
  buildCommandAliases({
    runtimes: loadAllRuntimes(join(root, 'content/harness/runtimes')),
    commandsDir,
    outDir: join(root, 'command-aliases'),
  });

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  execSync('git init -q -b main', { cwd: root, env: gitEnv });
  execSync('git add -A', { cwd: root, env: gitEnv });
  execSync('git commit -q -m "seed"', { cwd: root, env: gitEnv });

  return root;
}

describe('skills-guard — T4 command-aliases/ drift (#1472)', () => {
  it('AliasesGuard_CleanBuild_Passes', () => {
    const root = provisionProjectWithAliases();

    const result = runSkillsGuard({
      cwd: root,
      regenerateAgents: noopRegenerateAgents,
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    // Sanity: the alias tree exists and was seeded.
    const firstCommand = Object.keys(COMMAND_TO_SKILL)[0];
    expect(
      existsSync(join(root, ALIASES_OPENCODE_DIR, `${firstCommand}.md`)),
    ).toBe(true);
  });

  it('AliasesGuard_StaleCommandDescription_Fails', () => {
    const root = provisionProjectWithAliases();

    // A contributor edits a command description (the lifted source) but
    // forgets to regenerate. The committed `command-aliases/` tree is now
    // stale relative to source. The guard must regenerate + diff and fail.
    const firstCommand = Object.keys(COMMAND_TO_SKILL)[0];
    writeFileSync(
      join(root, 'commands', `${firstCommand}.md`),
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
    // The drift must be attributed to the alias tree, naming the path so
    // a developer can see which artifact is stale.
    expect(result.message).toMatch(/command-aliases/);
  });

  it('AliasesGuard_DirectAliasEdit_Detected', () => {
    const root = provisionProjectWithAliases();

    // Simulate a developer hand-editing a generated alias file and
    // committing it. A fresh regeneration overwrites the hand-edit, so
    // `git diff command-aliases/` against HEAD is non-empty.
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
    execSync('git add -A', { cwd: root, env: gitEnv });
    execSync('git commit -q -m "hand-edit generated alias"', {
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
