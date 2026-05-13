// ─── Wave 5 / Task 5.1 (#1341): guards.ts suggestedFix migration ──────────
//
// Every `suggestedFix.params` payload emitted by a guard targeting the
// `exarchos_workflow` MCP tool must call the CANONICAL update action.
//
// History: prior to v2.11's DR-4 substrate cut (#1332), the public surface
// was `action: 'set'`. That action was removed; Wave 0 of v2.10.0-preview.2
// (#1340) reintroduced the same semantics under `action: 'update'`. Any
// remaining `action: 'set'` reference in a `suggestedFix` payload causes
// agents to invoke a no-longer-registered action, which fails schema
// validation at the MCP boundary.
//
// This test is the RED side of Wave 5 / Task 5.1. It will FAIL until every
// `action: 'set'` occurrence in `guards.ts` is rewritten to `action:
// 'update'`. Verification of the canonical replacement value also catches
// accidental rename to any other action (e.g. `'patch'`) — `update` is the
// only registered phase-agnostic mutation surface.
//
// Why source-text scan vs. invoking each guard's failure path: the guard
// suite has ~12 `suggestedFix` payloads scattered across composed/private
// branches; enumerating every state shape that triggers a failure is more
// brittle than a structural assertion that the file's source contains zero
// `action: 'set'` and at least N `action: 'update'` (where N = original 12
// `set` count, since the migration is one-for-one).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARDS_FILE = join(__dirname, 'guards.ts');

describe('Guards suggestedFix migration (Wave 5 / Task 5.1, #1341)', () => {
  it('GuardsSuggestedFix_PointsAtCanonicalUpdateAction', () => {
    const source = readFileSync(GUARDS_FILE, 'utf-8');

    // No `action: 'set'` anywhere in guards.ts. Pattern matches both
    // single- and double-quoted forms (production code uses single).
    const setPattern = /action:\s*['"]set['"]/g;
    const setMatches = source.match(setPattern) ?? [];

    expect(
      setMatches.length,
      `guards.ts must not emit \`action: 'set'\` in any suggestedFix payload. ` +
        `Found ${setMatches.length} occurrence(s). Action 'set' was removed in v2.11's ` +
        `DR-4 substrate cut (#1332); use canonical 'update' (#1340 / Wave 0).`,
    ).toBe(0);

    // Sanity: the one-for-one migration must leave at least 12 `action:
    // 'update'` references — anchoring against the original `set` count
    // so a refactor that deletes guards instead of renaming them is also
    // caught. Allow >=12 in case future guards are added; the lower bound
    // is what matters.
    const updatePattern = /action:\s*['"]update['"]/g;
    const updateMatches = source.match(updatePattern) ?? [];
    expect(
      updateMatches.length,
      `guards.ts should declare at least 12 \`action: 'update'\` ` +
        `suggestedFix payloads (one per migrated guard). Found ${updateMatches.length}.`,
    ).toBeGreaterThanOrEqual(12);
  });
});
