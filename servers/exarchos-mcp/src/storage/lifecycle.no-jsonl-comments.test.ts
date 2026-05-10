import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('Storage lifecycle and subagent-context: stale JSONL comment audit', () => {
  it('StorageLifecycleAndSubagentContext_NoStaleJsonlReferences_GrepReturnsZeroMatches', async () => {
    const lifecyclePath = resolve(__dirname, 'lifecycle.ts');
    const subagentContextPath = resolve(
      __dirname,
      '..',
      'cli-commands',
      'subagent-context.ts',
    );

    const [lifecycleSrc, subagentSrc] = await Promise.all([
      readFile(lifecyclePath, 'utf8'),
      readFile(subagentContextPath, 'utf8'),
    ]);

    const pattern = /jsonl|JSONL/g;
    const lifecycleMatches = lifecycleSrc.match(pattern) ?? [];
    const subagentMatches = subagentSrc.match(pattern) ?? [];
    const total = lifecycleMatches.length + subagentMatches.length;

    expect(
      total,
      `Expected zero JSONL/jsonl references, found ${total} ` +
        `(lifecycle.ts: ${lifecycleMatches.length}, subagent-context.ts: ${subagentMatches.length})`,
    ).toBe(0);
  });
});
