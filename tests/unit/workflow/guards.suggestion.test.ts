/**
 * Every `suggestedFix.params` payload in `guards.ts` that targets `exarchos_workflow` must use
 * `action: 'update'`. The `set` action is not registered, so a `set` payload gives the agent an
 * unknown-action error. The test scans the source text, because a call to each failure path needs
 * many state shapes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARDS_FILE = join(__dirname, '../../../src/workflow/guards.ts');

describe('Guards suggestedFix migration (Wave 5 / Task 5.1, #1341)', () => {
  /**
   * The source must hold no `action: 'set'` and at least 12 `action: 'update'`. The lower bound
   * catches a change that deletes guards instead of migrating them.
   */
  it('GuardsSuggestedFix_PointsAtCanonicalUpdateAction', () => {
    const source = readFileSync(GUARDS_FILE, 'utf-8');

    const setPattern = /action:\s*['"]set['"]/g;
    const setMatches = source.match(setPattern) ?? [];

    expect(
      setMatches.length,
      `guards.ts must not emit \`action: 'set'\` in any suggestedFix payload. ` +
        `Found ${setMatches.length} occurrence(s). Action 'set' was removed in v2.11's ` +
        `DR-4 substrate cut (#1332); use canonical 'update' (#1340 / Wave 0).`,
    ).toBe(0);

    const updatePattern = /action:\s*['"]update['"]/g;
    const updateMatches = source.match(updatePattern) ?? [];
    expect(
      updateMatches.length,
      `guards.ts should declare at least 12 \`action: 'update'\` ` +
        `suggestedFix payloads (one per migrated guard). Found ${updateMatches.length}.`,
    ).toBeGreaterThanOrEqual(12);
  });
});
