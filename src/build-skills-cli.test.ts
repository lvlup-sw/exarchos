/**
 * CLI-level tests for `build-skills`. Isolated from the renderer unit
 * tests in `build-skills.test.ts` so CLI concerns (argv parsing, exit
 * codes, stdout/stderr plumbing) stay separate from the library surface.
 *
 * Implements: DR-2 (npm script integration).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { main } from './build-skills.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'build-skills-cli-test-'));
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
 * Write a minimal valid runtime map YAML. All six required runtimes must
 * be laid down before `loadAllRuntimes` will accept the directory.
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

/** Build a standard happy-path fixture tree rooted at `root`. */
function writeHappyFixture(root: string): void {
  mkdirSync(join(root, 'skills-src', 'foo'), { recursive: true });
  writeFileSync(join(root, 'skills-src', 'foo', 'SKILL.md'), 'Hello {{AGENT_LABEL}}');
  writeRuntimeFixtures(join(root, 'runtimes'));
}

/**
 * Invoke `main()` with in-memory stubs for `cwd`, `exit`, `log`, `errLog`.
 * `exit` is captured rather than allowed to terminate the test process.
 */
interface CapturedDeps {
  cwd: () => string;
  exit: (code: number) => never;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}
function makeDeps(cwdValue: string): CapturedDeps {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const captured: CapturedDeps = {
    cwd: () => cwdValue,
    exit: ((code: number) => {
      captured.exitCode = code;
      // Throwing here prevents fall-through after exit is called but
      // allows the test to capture the exit code. The caller catches
      // this sentinel error.
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

/**
 * Run `main()` and swallow the sentinel exit error so tests can inspect
 * `deps.exitCode` / `deps.stdout` / `deps.stderr` after the fact.
 */
async function runMain(argv: string[], deps: CapturedDeps): Promise<void> {
  try {
    await main(argv, {
      cwd: deps.cwd,
      exit: deps.exit,
      log: deps.log,
      errLog: deps.errLog,
    });
  } catch (err) {
    // Swallow only the synthetic exit sentinel — anything else is a real
    // test failure and should propagate.
    if (!(err instanceof Error && err.message.startsWith('__exit_'))) {
      throw err;
    }
  }
}

describe('build-skills CLI — task 008', () => {
  it('BuildSkillsCli_NoArgs_UsesDefaultPaths', async () => {
    const root = makeTempDir();
    writeHappyFixture(root);
    const deps = makeDeps(root);

    await runMain([], deps);

    // Default paths: srcDir='skills-src', outDir='skills', runtimesDir='runtimes'.
    expect(existsSync(join(root, 'skills', 'claude', 'foo', 'SKILL.md'))).toBe(true);
    expect(deps.exitCode).toBeNull(); // success does not call exit
  });

  it('BuildSkillsCli_OnError_ExitsNonZeroWithMessage', async () => {
    // Missing runtimes directory → loadAllRuntimes throws → CLI exits 1.
    const root = makeTempDir();
    mkdirSync(join(root, 'skills-src', 'foo'), { recursive: true });
    writeFileSync(join(root, 'skills-src', 'foo', 'SKILL.md'), 'Hello {{AGENT_LABEL}}');
    // No `runtimes/` dir at all.
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

  it('BuildSkillsCli_ReportContainsVariantCount', async () => {
    const root = makeTempDir();
    writeHappyFixture(root);
    const deps = makeDeps(root);

    await runMain([], deps);

    // One skill × six runtimes = 6 variants. The summary must mention
    // the count sourced from BuildReport.variantsWritten.
    const combined = deps.stdout.join('\n');
    expect(combined).toMatch(/6.*variants?/);
  });
});
