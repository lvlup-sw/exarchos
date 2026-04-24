/**
 * T045 — Q2 — CLI/MCP parity gate test (all workflow actions).
 *
 * Implements DR-11. One integration test that asserts every action of the
 * `exarchos_workflow` composite emits byte-identical envelope shape (modulo
 * `_perf.ms` jitter and wall-clock timestamps) when invoked via the CLI
 * adapter vs the MCP dispatch entry point.
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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { DispatchContext } from '../src/core/dispatch.js';
import { EventStore } from '../src/event-store/store.js';

// Side-effect import: registers the rehydration reducer with the default
// projection registry so the `rehydrate` action resolves.
import '../src/projections/rehydration/index.js';

import {
  ACTION_TABLE,
  assertActionParity,
  type ParityFixture,
} from './parity-actions.js';

// ─── Fixture harness ────────────────────────────────────────────────────────

function makeCtx(stateDir: string): DispatchContext {
  return {
    stateDir,
    eventStore: new EventStore(stateDir),
    enableTelemetry: false,
  };
}

let fixture: ParityFixture;

beforeEach(async () => {
  const cliDir = await mkdtemp(path.join(tmpdir(), 'exarchos-parity-all-cli-'));
  const mcpDir = await mkdtemp(path.join(tmpdir(), 'exarchos-parity-all-mcp-'));
  fixture = {
    cliDir,
    mcpDir,
    cliCtx: makeCtx(cliDir),
    mcpCtx: makeCtx(mcpDir),
  };
});

afterEach(async () => {
  await rm(fixture.cliDir, { recursive: true, force: true });
  await rm(fixture.mcpDir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('CliMcpParity_AllWorkflowActions_ByteIdenticalEnvelope (T045, DR-11)', () => {
  for (const spec of ACTION_TABLE) {
    it(`parity for action "${spec.action}"`, async () => {
      await assertActionParity(fixture, spec);
    });
  }

  // Exhaustiveness sentinel: fails if a new action is added to the
  // workflow composite without a corresponding ACTION_TABLE entry. Lives
  // as its own test so it surfaces in the test report as a named failure.
  it('ACTION_TABLE_Covers_All_Workflow_Actions', () => {
    const expected = new Set([
      'init',
      'get',
      'set',
      'cancel',
      'cleanup',
      'reconcile',
      'checkpoint',
      'describe',
      'rehydrate',
    ]);
    const covered = new Set(ACTION_TABLE.map((s) => s.action));
    expect(covered).toEqual(expected);
  });
});
