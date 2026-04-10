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
 * `git init` inside it, lays down a minimal `skills-src/` + `runtimes/`
 * fixture tree, runs one build so `skills/` exists, commits everything,
 * and then hands that directory to `runSkillsGuard({ cwd })`. Tests
 * never touch the repo's own `skills/` tree.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { runSkillsGuard } from './skills-guard.js';
import { buildAllSkills } from './build-skills.js';
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
        `capabilities:`,
        `  hasSubagents: true`,
        `  hasSlashCommands: true`,
        `  hasHooks: true`,
        `  hasSkillChaining: true`,
        `  mcpPrefix: "mcp__${name}__"`,
        `skillsInstallPath: "~/.${name}/skills"`,
        `detection:`,
        `  binaries: []`,
        `  envVars: []`,
        `placeholders:`,
        `  AGENT_LABEL: "agent"`,
        ``,
      ].join('\n'),
    );
  }
}

/**
 * Provision a temp directory that looks like a real project root:
 *   - `git init` with committer identity set locally
 *   - `skills-src/foo/SKILL.md` source
 *   - `runtimes/*.yaml` fixtures
 *   - `skills/` generated from an initial `buildAllSkills()` call
 *   - all of the above committed, so `git diff` starts clean
 */
function provisionProject(): string {
  const root = makeTempDir();

  mkdirSync(join(root, 'skills-src', 'foo'), { recursive: true });
  writeFileSync(
    join(root, 'skills-src', 'foo', 'SKILL.md'),
    'Hello {{AGENT_LABEL}}\n',
  );
  writeRuntimeFixtures(join(root, 'runtimes'));

  // Seed the `skills/` tree so the guard has something to compare against.
  buildAllSkills({
    srcDir: join(root, 'skills-src'),
    outDir: join(root, 'skills'),
    runtimesDir: join(root, 'runtimes'),
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

describe('skills-guard — task 023', () => {
  it('SkillsGuard_CleanBuild_Passes', () => {
    const root = provisionProject();

    const result = runSkillsGuard({ cwd: root });

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
      join(root, 'skills-src', 'foo', 'SKILL.md'),
      'Hello {{AGENT_LABEL}} — updated\n',
    );

    const result = runSkillsGuard({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it('SkillsGuard_FailureMessage_IncludesRemediation', () => {
    const root = provisionProject();

    // Force a drift by editing the source without rebuilding.
    writeFileSync(
      join(root, 'skills-src', 'foo', 'SKILL.md'),
      'Hello {{AGENT_LABEL}} — changed\n',
    );

    const result = runSkillsGuard({ cwd: root });

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

    const result = runSkillsGuard({ cwd: root });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    // The diff body returned by the guard should mention the generated
    // file path so developers can see *which* file drifted.
    expect(result.message).toMatch(/skills\/claude\/foo\/SKILL\.md/);
  });
});
