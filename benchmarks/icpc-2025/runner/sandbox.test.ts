import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runInSandbox } from './sandbox.js';
import { compile } from './compiler.js';

const TEST_DIR = join(import.meta.dirname, '.test-sandbox-fixtures');

function hasGpp(): boolean {
  try {
    execFileSync('which', ['g++']);
    return true;
  } catch {
    return false;
  }
}

const describeWithGpp = hasGpp() ? describe : describe.skip;

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describeWithGpp('runInSandbox', () => {
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
  });

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
  });

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
    expect(result.stdout.length).toBeLessThanOrEqual(maxBytes + 100); // allow small buffer overshoot
  });

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
  });
});
