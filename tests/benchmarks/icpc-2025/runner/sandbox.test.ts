import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInSandbox } from './sandbox.js';
import { compile } from './compiler.js';
import { WIN32_SPAWN_HEADROOM } from '../../../../vitest.config.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { makeRepoSandbox, type RepoSandbox } from '../../../../tools/test-helpers/repo-sandbox.js';

/** The fixtures and their build output live in a temporary sandbox, never beside this file. */
let fixtures: RepoSandbox | undefined;
let TEST_DIR = '';

/**
 * Runs `g++ --version`, because `which g++` is not enough.
 * The windows-latest runners ship a g++ shim that resolves but cannot compile.
 */
async function hasGpp(): Promise<boolean> {
  try {
    await execFileAsync('g++', ['--version']);
    return true;
  } catch {
    return false;
  }
}

const describeWithGpp = (await hasGpp()) ? describe : describe.skip;

/**
 * Test timeout for a case that compiles its fixture with g++ before it runs the sandbox.
 * A cold compile can exceed the default timeout of 5 seconds.
 * The win32 factor scales the budget, because the `unit` tier timeout on Windows is already 30 seconds.
 * The `timeLimitMs` of the sandbox still bounds the behavior under test.
 */
const COMPILE_BEARING_TIMEOUT_MS = 30_000 * WIN32_SPAWN_HEADROOM;

describeWithGpp('runInSandbox', () => {
  beforeAll(async () => {
    fixtures = await makeRepoSandbox({ prefix: 'icpc-sandbox' });
    TEST_DIR = fixtures.root;
  });

  afterAll(() => {
    fixtures?.remove();
  });

  it('sandbox_NormalExecution_CompletesSuccessfully', async () => {
    const srcPath = join(TEST_DIR, 'echo.cpp');
    writeFileSync(srcPath, `
#include <iostream>
#include <string>
int main() {
  std::string line;
  std::getline(std::cin, line);
  std::cout << line << std::endl;
  return 0;
}
`);

    const compiled = await compile(srcPath);
    expect(compiled.success).toBe(true);

    const result = await runInSandbox(
      compiled.executablePath!,
      [],
      'hello sandbox\n',
      { timeLimitMs: 5000, workDir: TEST_DIR }
    );

    expect(result.stdout.trim()).toBe('hello sandbox');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  }, COMPILE_BEARING_TIMEOUT_MS);

  it('sandbox_InfiniteLoop_KilledWithinTimeout', async () => {
    const srcPath = join(TEST_DIR, 'infinite.cpp');
    writeFileSync(srcPath, `
int main() {
  volatile int x = 0;
  while(true) { x++; }
  return 0;
}
`);

    const compiled = await compile(srcPath);
    expect(compiled.success).toBe(true);

    const result = await runInSandbox(
      compiled.executablePath!,
      [],
      '',
      { timeLimitMs: 500, workDir: TEST_DIR }
    );

    expect(result.timedOut).toBe(true);
  }, COMPILE_BEARING_TIMEOUT_MS);

  it('sandbox_LargeOutput_TruncatesAtLimit', async () => {
    const srcPath = join(TEST_DIR, 'bigout.cpp');
    writeFileSync(srcPath, `
#include <iostream>
#include <string>
int main() {
  std::string chunk(1000, 'A');
  for (int i = 0; i < 2048; i++) {
    std::cout << chunk << "\\n";
  }
  return 0;
}
`);

    const compiled = await compile(srcPath);
    expect(compiled.success).toBe(true);

    const maxBytes = 1024;
    const result = await runInSandbox(
      compiled.executablePath!,
      [],
      '',
      { timeLimitMs: 5000, workDir: TEST_DIR, maxOutputBytes: maxBytes }
    );

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(maxBytes);
  }, COMPILE_BEARING_TIMEOUT_MS);

  it('sandbox_NonZeroExit_CapturesExitCode', async () => {
    const srcPath = join(TEST_DIR, 'exit42.cpp');
    writeFileSync(srcPath, `
int main() {
  return 42;
}
`);

    const compiled = await compile(srcPath);
    expect(compiled.success).toBe(true);

    const result = await runInSandbox(
      compiled.executablePath!,
      [],
      '',
      { timeLimitMs: 5000, workDir: TEST_DIR }
    );

    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  }, COMPILE_BEARING_TIMEOUT_MS);
});
