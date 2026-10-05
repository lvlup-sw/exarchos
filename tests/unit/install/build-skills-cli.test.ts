/**
 * Tests for the `build-skills` command-line entry point: default paths, exit codes, and the
 * stdout and stderr output. The renderer tests are in `build-skills.test.ts`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { main } from '../../../src/install/build-skills.js';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'build-skills-cli-test-'));
  tempDirs.push(dir);
  return dir;
}
/** Remove each temp directory. A removal error does not fail the test. */
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
 * Write a minimal valid runtime map YAML for each of the six required runtimes, because
 * `loadAllRuntimes` rejects a directory that lacks one. Each file declares every
 * `RuntimeTokenKey` placeholder, because `assertRuntimeTokenCoverage` rejects a missing token.
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
 * Build a valid fixture tree at `root`. The `{{TASK_TOOL}}` token makes `foo` an orchestration
 * skill, so it renders one time for each of the six runtimes. A procedural skill renders
 * only to the `standard` tree.
 */
function writeHappyFixture(root: string): void {
  mkdirSync(join(root, 'content', 'foo'), { recursive: true });
  writeFileSync(
    join(root, 'content', 'foo', 'SKILL.md'),
    'Hello {{AGENT_LABEL}} {{TASK_TOOL}}',
  );
  writeRuntimeFixtures(join(root, 'content/harness/runtimes'));
}

/** The stub dependencies of `main()` and the output that they capture. */
interface CapturedDeps {
  cwd: () => string;
  exit: (code: number) => never;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}
/**
 * Build the stubs. `exit` records the code and throws a sentinel error. Thus `main()` stops
 * and the test process continues.
 */
function makeDeps(cwdValue: string): CapturedDeps {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const captured: CapturedDeps = {
    cwd: () => cwdValue,
    exit: ((code: number) => {
      captured.exitCode = code;
      throw new Error(`__exit_${code}__`);
    }) as (code: number) => never,
    log: (msg: string) => {
      stdout.push(msg);
    },
    errLog: (msg: string) => {
      stderr.push(msg);
    },
    stdout,
    stderr,
    exitCode: null,
  };
  return captured;
}

/** Run `main()` and catch only the sentinel exit error. Any other error fails the test. */
async function runMain(argv: string[], deps: CapturedDeps): Promise<void> {
  try {
    await main(argv, {
      cwd: deps.cwd,
      exit: deps.exit,
      log: deps.log,
      errLog: deps.errLog,
    });
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith('__exit_'))) {
      throw err;
    }
  }
}

describe('build-skills CLI — task 008', () => {
  /** `main()` writes under `rendered/skills` in the working directory. It does not call `exit` on success. */
  it('BuildSkillsCli_NoArgs_UsesDefaultPaths', async () => {
    const root = makeTempDir();
    writeHappyFixture(root);
    const deps = makeDeps(root);

    await runMain([], deps);

    expect(existsSync(join(root, 'rendered', 'skills', 'claude', 'foo', 'SKILL.md'))).toBe(true);
    expect(deps.exitCode).toBeNull();
  });

  /** The tree has no `content/harness/runtimes` directory, so the runtime load throws and `main()` exits with code 1. */
  it('BuildSkillsCli_OnError_ExitsNonZeroWithMessage', async () => {
    const root = makeTempDir();
    mkdirSync(join(root, 'content', 'foo'), { recursive: true });
    writeFileSync(join(root, 'content', 'foo', 'SKILL.md'), 'Hello {{AGENT_LABEL}}');
    const deps = makeDeps(root);

    await runMain([], deps);

    expect(deps.exitCode).toBe(1);
    expect(deps.stderr.join('\n')).toMatch(/runtime/i);
  });

  it('BuildSkillsCli_Success_PrintsSummary', async () => {
    const root = makeTempDir();
    writeHappyFixture(root);
    const deps = makeDeps(root);

    await runMain([], deps);

    expect(deps.stdout.join('\n')).toMatch(/build:skills/);
  });

  /** One orchestration skill and six runtimes give 6 variants. */
  it('BuildSkillsCli_ReportContainsVariantCount', async () => {
    const root = makeTempDir();
    writeHappyFixture(root);
    const deps = makeDeps(root);

    await runMain([], deps);

    const combined = deps.stdout.join('\n');
    expect(combined).toMatch(/6.*variants?/);
  });
});
