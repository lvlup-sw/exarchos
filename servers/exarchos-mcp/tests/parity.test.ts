/**
 * T045 — Q2 — CLI/MCP parity gate test (all workflow actions).
 *
 * Implements DR-11. One integration test that asserts every action of the
 * `exarchos_workflow` composite emits byte-identical envelope shape (modulo
 * `_perf.ms` jitter and wall-clock timestamps) when invoked via the CLI
 * adapter vs the MCP dispatch entry point.
 *
 * Structure (data-driven): the per-action logic lives in
 * `./parity-actions.ts`:
 *   - `ACTION_TABLE` — the exhaustive list of specs, one per workflow
 *     action.
 *   - `assertActionParity(fixture, spec)` — invokes both adapters against
 *     a shared fixture and asserts normalized byte-equality.
 *   - `setupFixture` / `teardownFixture` — isolated tmp state dirs per run.
 *
 * Why this lives under `tests/` (not `src/workflow/parity.test.ts`):
 *   - `src/workflow/parity.test.ts` (T014) covers three actions (init, get,
 *     set) as a scoped unit of the workflow suite. This file is the
 *     cross-cutting integration gate that is the single source of truth
 *     for "every workflow action preserves parity" — the CI shipping
 *     contract #1109 §2 names. Placing it under `tests/` mirrors the
 *     load-bearing-golden pattern (T052).
 *   - Vitest's config already includes `tests/**\/*.test.ts`, so no config
 *     change is required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Side-effect import: registers the rehydration reducer with the default
// projection registry so the `rehydrate` action resolves.
import '../src/projections/rehydration/index.js';

import {
  ACTION_TABLE,
  WORKFLOW_ACTIONS,
  assertActionParity,
  setupFixture,
  teardownFixture,
  type ParityFixture,
} from './parity-actions.js';

// ─── Fixture ────────────────────────────────────────────────────────────────

let fixture: ParityFixture;

beforeEach(async () => {
  fixture = await setupFixture();
});

afterEach(async () => {
  await teardownFixture(fixture);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('CliMcpParity_AllWorkflowActions_ByteIdenticalEnvelope (T045, DR-11)', () => {
  // Table-driven: each row in `ACTION_TABLE` becomes one test case.
  // `it.each` gives each generated test a distinct name in the reporter,
  // so a parity break surfaces as `parity for action "cancel"` rather
  // than being buried inside a single aggregate test.
  it.each(ACTION_TABLE)(
    'parity for action "$action"',
    async (spec) => {
      await assertActionParity(fixture, spec);
    },
  );

  // Exhaustiveness sentinel: fails if a new action is added to the
  // workflow composite without a corresponding ACTION_TABLE entry. Lives
  // as its own test so it surfaces in the test report as a named failure
  // rather than silently dropping coverage.
  it('ACTION_TABLE_Covers_All_Workflow_Actions', () => {
    const expected = new Set(WORKFLOW_ACTIONS);
    const covered = new Set(ACTION_TABLE.map((s) => s.action));
    expect(covered).toEqual(expected);
  });
});
