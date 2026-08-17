import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInSandbox } from './sandbox.js';
import { compile } from './compiler.js';

const TEST_DIR = join(dirname(fileURLToPath(import.meta.url)), '.test-sandbox-fixtures');

function hasGpp(): boolean {
  // `which g++` is not enough: windows-latest runners ship a g++ shim that
  // resolves yet cannot compile (no MSVC toolchain in PATH). Probe by running
  // `g++ --version` instead — a shim does not respond to its driver flag, so
  // this catches the case where `which` alone would say yes and the compile
  // path would then fail.
  try {
    execFileSync('g++', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const describeWithGpp = hasGpp() ? describe : describe.skip;

// Every case below compiles its own fixture with g++ before it exercises the
// sandbox, so each one carries a cold-compile cost that the default 5s vitest
// timeout does not cover — `compiler.test.ts` records the same compile observed
// at 5007ms and gives it a 30s envelope for exactly this reason. That fix was
// applied there and not here, so these cases stayed on the default and passed
// only while some earlier file happened to warm the compiler first. Under a
// loaded Windows runner all three timed out at ~5001ms. The budget bounds the
// TEST HARNESS; the sandbox's own `timeLimitMs` still bounds the behaviour
// under test, so a genuinely hung sandbox still fails rather than sitting here.
const COMPILE_BEARING_TIMEOUT_MS = 30_000;

describeWithGpp('runInSandbox', () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
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

    const timeoutMs = 500;
    const start = Date.now();
    const result = await runInSandbox(
      compiled.executablePath!,
      [],
      '',
      { timeLimitMs: timeoutMs, workDir: TEST_DIR }
    );
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    // Should die within 2x timeout
    expect(elapsed).toBeLessThan(timeoutMs * 2);
  }, COMPILE_BEARING_TIMEOUT_MS);

  it('sandbox_LargeOutput_TruncatesAtLimit', async () => {
    const srcPath = join(TEST_DIR, 'bigout.cpp');
    // Output ~2MB (each iteration prints 1000 chars + newline)
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

    const maxBytes = 1024; // 1KB limit for test
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
