type Runner = 'vitest' | 'node-test' | 'bun-test';

export function registration(runner: Runner): string {
  switch (runner) {
    case 'vitest': return "import { expect, it } from 'vitest';";
    case 'node-test': return "import assert from 'node:assert/strict';\nimport it from 'node:test';";
    case 'bun-test': return "import { strictEqual } from 'node:assert';\nimport { it } from 'bun:test';";
  }
}

export function assertion(runner: Runner, actual: string, expected: string, message: string): string {
  const description = JSON.stringify(message);
  return runner === 'vitest'
    ? `expect(${actual}, ${description}).toBe(${expected});`
    : `${runner === 'node-test' ? 'assert.' : ''}strictEqual(${actual}, ${expected}, ${description});`;
}

export function typescriptValidation(runner: Runner, path: string) {
  switch (runner) {
    case 'vitest': return { executable: 'npm' as const, args: ['exec', '--no', '--', 'vitest', 'run', path] };
    case 'node-test': return { executable: 'node' as const, args: ['--test', '--test-isolation=none', path.replace(/\.ts$/, '.js')] };
    case 'bun-test': return { executable: 'bun' as const, args: ['test', path] };
  }
}

export const recordEncoder = String.raw`function encodeRecord(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, (character) =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}`;
