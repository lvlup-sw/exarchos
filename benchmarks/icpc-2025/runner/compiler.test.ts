import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectLanguage, compile, execute, runSolution } from './compiler.js';

const TEST_DIR = join(import.meta.dirname, '.test-fixtures');

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

describe('detectLanguage', () => {
  it('detectLanguage_CppExtension_ReturnsCpp', () => {
    expect(detectLanguage('solution.cpp')).toBe('cpp');
    expect(detectLanguage('/path/to/solution.cc')).toBe('cpp');
    expect(detectLanguage('main.cxx')).toBe('cpp');
  });

  it('detectLanguage_PythonExtension_ReturnsPython', () => {
    expect(detectLanguage('solution.py')).toBe('python');
  });

  it('detectLanguage_TypeScriptExtension_ReturnsTypeScript', () => {
    expect(detectLanguage('solution.ts')).toBe('typescript');
  });

  it('detectLanguage_UnknownExtension_ThrowsError', () => {
    expect(() => detectLanguage('solution.rs')).toThrow();
  });
});

describeWithGpp('compile', () => {
  it('compile_ValidCpp_ReturnsExecutablePath', async () => {
    const srcPath = join(TEST_DIR, 'hello.cpp');
    writeFileSync(srcPath, `
#include <iostream>
int main() {
  std::cout << "Hello, World!" << std::endl;
  return 0;
}
`);

    const result = await compile(srcPath);
    expect(result.success).toBe(true);
    expect(result.executablePath).toBeDefined();
    expect(existsSync(result.executablePath!)).toBe(true);
  });

  it('compile_SyntaxError_ReturnsCeVerdict', async () => {
    const srcPath = join(TEST_DIR, 'bad.cpp');
    writeFileSync(srcPath, `
int main() {
  this is not valid c++
  return 0;
}
`);

    const result = await compile(srcPath);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it('compile_Python_ReturnsSourceAsExecutable', async () => {
    const srcPath = join(TEST_DIR, 'hello.py');
    writeFileSync(srcPath, 'print("hello")');

    const result = await compile(srcPath);
    expect(result.success).toBe(true);
    expect(result.executablePath).toBe(srcPath);
  });
});

describeWithGpp('execute', () => {
  it('execute_ValidProgram_ReturnsStdout', async () => {
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

    const result = await execute(compiled.executablePath!, 'test input\n', 5000);
    expect(result.stdout.trim()).toBe('test input');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('execute_TimeLimitExceeded_ReturnsTleVerdict', async () => {
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

    const start = Date.now();
    const result = await execute(compiled.executablePath!, '', 500);
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    // Should complete within 2x the timeout
    expect(elapsed).toBeLessThan(1500);
  });

  it('execute_RuntimeError_ReturnsRteVerdict', async () => {
    const srcPath = join(TEST_DIR, 'rte.cpp');
    writeFileSync(srcPath, `
int main() {
  return 42;
}
`);

    const compiled = await compile(srcPath);
    expect(compiled.success).toBe(true);

    const result = await execute(compiled.executablePath!, '', 5000);
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });
});

describeWithGpp('runSolution', () => {
  it('runSolution_ValidCpp_CompilesAndExecutes', async () => {
    const srcPath = join(TEST_DIR, 'run_echo.cpp');
    writeFileSync(srcPath, `
#include <iostream>
#include <string>
int main() {
  std::string s;
  std::cin >> s;
  std::cout << s << std::endl;
  return 0;
}
`);

    const result = await runSolution(srcPath, 'hello\n', 5000);
    expect(result.compiled).toBe(true);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  });

  it('runSolution_CompileError_ReportsCompileFailure', async () => {
    const srcPath = join(TEST_DIR, 'run_bad.cpp');
    writeFileSync(srcPath, 'not valid c++');

    const result = await runSolution(srcPath, '', 5000);
    expect(result.compiled).toBe(false);
    expect(result.compileError).toBeDefined();
  });
});
