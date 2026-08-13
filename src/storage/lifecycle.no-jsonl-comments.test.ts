import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// #1476: `subagent-context.ts` was deleted with the enforcement-hook excision,
// so the stale-comment audit now covers `lifecycle.ts` alone.
describe('Storage lifecycle: stale JSONL comment audit', () => {
  it('StorageLifecycle_NoStaleJsonlReferences_GrepReturnsZeroMatches', async () => {
    const lifecyclePath = resolve(__dirname, 'lifecycle.ts');
    const lifecycleSrc = await readFile(lifecyclePath, 'utf8');

    const pattern = /jsonl|JSONL/g;
    const lifecycleMatches = lifecycleSrc.match(pattern) ?? [];
    const total = lifecycleMatches.length;

    expect(
      total,
      `Expected zero JSONL/jsonl references, found ${total} (lifecycle.ts)`,
    ).toBe(0);
  });
});
