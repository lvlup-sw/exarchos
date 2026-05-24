// ─── #1292 — MCP SDK pin-policy guard ──────────────────────────────────────
//
// The `@modelcontextprotocol/sdk` dependency is intentionally **exact-pinned**
// (no caret/tilde range). The SDK's Tasks / SEP-1686 surface is marked
// `@experimental`, so a minor bump is an explicit, reviewed decision rather
// than something `npm install` should pick up implicitly. This test guards
// against a future caret/tilde reintroduction.
//
// Re-scope note: the originating issue (#1292) assumed a `^1.0.0` range and
// proposed swapping to `1.26.x`. That premise is stale — the dependency is
// already exact at `1.29.0`. This is therefore a pin-policy ratification +
// guard, not a version swap.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// src/__tests__ → servers/exarchos-mcp
const packageJsonPath = join(here, '..', '..', 'package.json');

function readSdkRange(): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const range = pkg.dependencies?.['@modelcontextprotocol/sdk'];
  expect(range, '@modelcontextprotocol/sdk must be a declared dependency').toBeTypeOf(
    'string',
  );
  return range as string;
}

describe('MCP SDK pin policy (#1292)', () => {
  it('McpSdkPin_PackageJson_IsExactNotCaretRange', () => {
    const range = readSdkRange();

    // Exact version (`1.29.0`) or minor-x (`1.29.x`) — no range operators.
    expect(range).toMatch(/^\d+\.\d+\.(\d+|x)$/);

    // Explicitly NOT a caret or tilde range.
    expect(range.startsWith('^')).toBe(false);
    expect(range.startsWith('~')).toBe(false);
  });
});
