/**
 * Tests for the rehydrate-foundation migration follow-ups registry (T061, DR-16).
 *
 * Phase progression: RED (doc does not yet exist) →
 * GREEN (`docs/migrations/rehydrate-foundation-followups.md` created with all
 * required deferred items, each carrying a Scope line).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DOC_PATH = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  '../docs/migrations/rehydrate-foundation-followups.md',
);

const REQUIRED_ITEMS = [
  'decisions',
  'applyCacheHints',
  'check-golden-fixture-note',
  'deliveryPath',
  'nextAction',
  'pollingEventSource',
  'deliveryPath enum',
] as const;

describe('MigrationFollowups_EachDeferredComponent_HasIssue', () => {
  it('doc exists', () => {
    expect(existsSync(DOC_PATH)).toBe(true);
  });

  it('doc contains at least 7 numbered or bulleted items', () => {
    const content = readFileSync(DOC_PATH, 'utf8');
    // Match ### N. headings (numbered sections)
    const headings = content.match(/^###\s+\d+\./gm) ?? [];
    expect(headings.length).toBeGreaterThanOrEqual(7);
  });

  it('every item has a Scope line', () => {
    const content = readFileSync(DOC_PATH, 'utf8');
    const scopeLines = content.match(/\*\*Scope:\*\*|Scope:/g) ?? [];
    expect(scopeLines.length).toBeGreaterThanOrEqual(7);
  });

  it.each([
    ['T025 decisions reducer', /decisions/i],
    ['T051 applyCacheHints wiring', /applyCacheHints/i],
    ['T053 CI workflow wiring', /check-golden-fixture-note|CI workflow/i],
    ['T031 deliveryPath upstream', /deliveryPath/i],
    ['nextAction field omission', /nextAction|next_action/i],
    ['EventStore polling adapter', /pollingEventSource|polling/i],
    ['deliveryPath enum spec drift', /enum|direct.*ndjson|ndjson.*direct/i],
  ])('doc mentions: %s', (_label, pattern) => {
    const content = readFileSync(DOC_PATH, 'utf8');
    expect(content).toMatch(pattern);
  });
});
