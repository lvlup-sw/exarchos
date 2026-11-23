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

/** The native command that runs one emitted TypeScript test file. */
type TypeScriptValidation = { executable: 'npm'; args: string[] } | { executable: 'bun'; args: string[] };

export function typescriptValidation(runner: Runner, path: string): TypeScriptValidation | undefined {
  switch (runner) {
    case 'vitest': return { executable: 'npm', args: ['exec', '--no', '--', 'vitest', 'run', path] };
    case 'node-test': return undefined;
    case 'bun-test': return { executable: 'bun', args: ['test', path] };
  }
}

export const recordEncoder = String.raw`function encodeRecord(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, (character) =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}`;
