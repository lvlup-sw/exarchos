// ─── CLI/MCP Parity Under mcp:exarchos:readonly (Issue #1192, T12) ─────────
//
// Closes the #1109 Constraint 2 (MCP Parity) verification step for the
// capability ISP work landed in T03–T11. The capability gate
// (`enforceReadonlyGate`, src/core/dispatch.ts) lives in the shared
// transport-agnostic dispatch entry, so both the CLI adapter
// (src/adapters/cli.ts) and the MCP adapter (src/adapters/mcp.ts) consult
// the same `ctx.capabilityResolver` and short-circuit identically when
// the effective capability set is `{mcp:exarchos:readonly}`.
//
// This suite locks that contract in by exercising both arms with the same
// readonly resolver and asserting:
//
//   1. ALLOWED action (read-only): both facades return byte-equal payloads
//      after normalization, and neither surfaces CAPABILITY_DENIED.
//   2. DENIED action (mutating): both facades return a structurally
//      identical CAPABILITY_DENIED envelope (`error.code`, `error.tool`,
//      `error.action` all match).
//
// If a future refactor splits the gate into per-facade copies and one
// drifts, this test fails — which is the whole point of the parity check.
//
// Strategy notes:
//   - Pipeline view (`exarchos_view pipeline`, CLI alias `vw ls`) is the
//     positive-case action: `exarchos_view` is wholesale read-only
//     (READ_ONLY_ACTIONS.exarchos_view === '*'), so the gate is a pure
//     no-op and any divergence has to come from facade-specific shaping.
//   - `workflow set` is the negative-case action: it is the canonical
//     mutating workflow operation (auto-emits state.patched in normal use)
//     and is explicitly outside READ_ONLY_ACTIONS.exarchos_workflow.
//   - The stateDir is shared between the two arms so any deterministic
//     read returns identical materialized output regardless of which
//     facade is queried first.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CLI_EXIT_CODES } from '../adapters/cli.js';
import { type DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';
import { createInMemoryResolver } from '../capabilities/resolver.js';
import { resetMaterializerCache } from '../views/tools.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
  UUID_ANY_RE,
} from '../__tests__/parity-harness.js';

// ─── Fixture ──────────────────────────────────────────────────────────────

interface ReadonlyFixture {
  readonly tmpDir: string;
  readonly ctx: DispatchContext;
}

async function setupFixture(): Promise<ReadonlyFixture> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'readonly-parity-'));
  const eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
  const ctx: DispatchContext = {
    stateDir: tmpDir,
    eventStore,
    enableTelemetry: false,
    // The whole point of the suite: both facades share this resolver, so
    // both observe `{mcp:exarchos:readonly}` and only `mcp:exarchos:readonly`.
    capabilityResolver: createInMemoryResolver(['mcp:exarchos:readonly']),
  };
  return { tmpDir, ctx };
}

async function teardownFixture(f: ReadonlyFixture): Promise<void> {
  await fs.rm(f.tmpDir, { recursive: true, force: true });
}

// ─── Normalization ────────────────────────────────────────────────────────

/**
 * Mirrors the views parity normalizer (timestamps → `<ISO>`, UUIDs → `<UUID>`,
 * `_perf` dropped) so transient wall-clock / measurement-path drift doesn't
 * register as a parity violation.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<ISO>',
    uuidPlaceholder: '<UUID>',
    uuidRegex: UUID_ANY_RE,
    dropKeys: new Set(['_perf']),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('CLI/MCP parity under mcp:exarchos:readonly (Issue #1192, T12)', () => {
  let fixture: ReadonlyFixture;

  beforeEach(async () => {
    // The materializer caches projection state across test runs; clear it
    // so each tmpDir starts from a clean slate.
    resetMaterializerCache();
    fixture = await setupFixture();
  });

  afterEach(async () => {
    resetMaterializerCache();
    await teardownFixture(fixture);
  });

  it('Readonly_AllowedReadAction_CLI_AndMCP_ReturnEqualPayload', async () => {
    // Arrange — `pipeline` is on the wholesale-readonly view tool; the
    // gate must pass through both facades identically.
    const args = { limit: 10, offset: 0 };

    // Act — invoke the same action through each facade against the shared
    // ctx (same stateDir, same resolver).
    const mcpResult = await harnessCallMcp(fixture.ctx, 'exarchos_view', {
      action: 'pipeline',
      ...args,
    });
    // CLI alias for exarchos_view is `vw`; for the `pipeline` action the
    // registry exposes alias `ls` — see registry.ts line ~1530.
    const { result: cliResult, exitCode } = await harnessCallCli(
      fixture.ctx,
      'vw',
      'ls',
      args,
    );

    // Assert — both succeed, both return equal payloads after normalizing
    // transient fields, and neither path surfaces CAPABILITY_DENIED.
    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);
    expect(mcpResult.error?.code).not.toBe('CAPABILITY_DENIED');
    expect(cliResult.error?.code).not.toBe('CAPABILITY_DENIED');
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  it('Readonly_MutatingAction_RejectsIdentically_From_CLI_AndMCP', async () => {
    // Arrange — `workflow set` is the canonical mutating action; it is
    // explicitly NOT on READ_ONLY_ACTIONS.exarchos_workflow.
    const args = {
      featureId: 'parity-readonly-feature',
      updates: { phase: 'ideate' },
    };

    // Act — both facades against the same ctx.
    const mcpResult = await harnessCallMcp(fixture.ctx, 'exarchos_workflow', {
      action: 'set',
      ...args,
    });
    const { result: cliResult, exitCode } = await harnessCallCli(
      fixture.ctx,
      'wf',
      'set',
      args,
    );

    // Assert — both reject with structurally identical CAPABILITY_DENIED.
    expect(mcpResult.success).toBe(false);
    expect(cliResult.success).toBe(false);
    // CLI maps a failed dispatch ToolResult to HANDLER_ERROR (2).
    expect(exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);

    // Error envelope must be byte-equal across the two facades for the
    // identifying triple (code, tool, action). Message strings are part
    // of the gate's contract too — they're built from those three fields
    // by `enforceReadonlyGate` so any divergence in message text would
    // imply two different gate code paths, defeating the parity check.
    expect(mcpResult.error?.code).toBe('CAPABILITY_DENIED');
    expect(cliResult.error?.code).toBe('CAPABILITY_DENIED');
    expect(mcpResult.error?.tool).toBe('exarchos_workflow');
    expect(cliResult.error?.tool).toBe('exarchos_workflow');
    expect(mcpResult.error?.action).toBe('set');
    expect(cliResult.error?.action).toBe('set');

    // Strongest assertion: the entire normalized error envelope matches.
    // If a future change adds a facade-specific field (e.g. CLI tacks on
    // `argv` while MCP omits it), this catches it.
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});
