// CLI and MCP parity under `mcp:exarchos:readonly`.
//
// The capability gate `enforceReadonlyGate` lives in the shared dispatch entry
// (`src/dispatch/core/dispatch.ts`). The CLI and MCP adapters thus consult the same
// `ctx.capabilityResolver` and stop identically under `{mcp:exarchos:readonly}`. Both arms run
// with the same readonly resolver and the same state dir:
//
//   1. An allowed read action (`exarchos_view pipeline`, CLI `vw ls`) returns equal payloads after
//      normalization. `exarchos_view` is wholly read-only, so a difference comes from a facade.
//   2. A denied mutating action (`workflow transition`) returns the same `CAPABILITY_DENIED`
//      envelope on both facades.
//
// A gate that splits into per-facade copies and drifts fails this suite.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CLI_EXIT_CODES } from '../../../../src/adapters/cli/cli.js';
import { type DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { resetMaterializerCache } from '../../../../src/projections/views/tools.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
  UUID_ANY_RE,
} from '../../../../tests/unit/parity-harness.js';
import { rmrfAsync } from '../../../test-helpers/temp-dir.js';

interface ReadonlyFixture {
  readonly tmpDir: string;
  readonly ctx: DispatchContext;
}

/**
 * Creates a temp state dir and a dispatch context. Both facades share its resolver, which grants
 * only `mcp:exarchos:readonly`.
 */
async function setupFixture(): Promise<ReadonlyFixture> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'readonly-parity-'));
  const eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
  const ctx: DispatchContext = {
    stateDir: tmpDir,
    eventStore,
    enableTelemetry: false,
    capabilityResolver: createInMemoryResolver(['mcp:exarchos:readonly']),
  };
  return { tmpDir, ctx };
}

async function teardownFixture(f: ReadonlyFixture): Promise<void> {
  await rmrfAsync(f.tmpDir);
}

/**
 * Mirrors the views parity normalizer: timestamps become `<ISO>`, UUIDs become `<UUID>`, and
 * `_perf` goes. Clock and measurement drift is thus not a parity violation.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<ISO>',
    uuidPlaceholder: '<UUID>',
    uuidRegex: UUID_ANY_RE,
    dropKeys: new Set(['_perf']),
  });
}

/** Each test clears the materializer cache, which keeps projection state across tests. */
describe('CLI/MCP parity under mcp:exarchos:readonly (Issue #1192, T12)', () => {
  let fixture: ReadonlyFixture;

  beforeEach(async () => {
    resetMaterializerCache();
    fixture = await setupFixture();
  });

  afterEach(async () => {
    resetMaterializerCache();
    await teardownFixture(fixture);
  });

  it('Readonly_AllowedReadAction_CLI_AndMCP_ReturnEqualPayload', async () => {
    const args = { limit: 10, offset: 0 };

    const mcpResult = await harnessCallMcp(fixture.ctx, 'exarchos_view', {
      action: 'pipeline',
      ...args,
    });
    const { result: cliResult, exitCode } = await harnessCallCli(
      fixture.ctx,
      'vw',
      'ls',
      args,
    );

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);
    expect(mcpResult.error?.code).not.toBe('CAPABILITY_DENIED');
    expect(cliResult.error?.code).not.toBe('CAPABILITY_DENIED');
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  /**
   * `READ_ONLY_ACTIONS.exarchos_workflow` omits `transition`, so the gate rejects it on both
   * facades. The CLI maps the failed dispatch to `HANDLER_ERROR`. The whole normalized envelope
   * must match, so a field that only one facade adds fails the test.
   */
  it('Readonly_MutatingAction_RejectsIdentically_From_CLI_AndMCP', async () => {
    const args = {
      featureId: 'parity-readonly-feature',
      target: 'plan',
    };

    const mcpResult = await harnessCallMcp(fixture.ctx, 'exarchos_workflow', {
      action: 'transition',
      ...args,
    });
    const { result: cliResult, exitCode } = await harnessCallCli(
      fixture.ctx,
      'wf',
      'transition',
      args,
    );

    expect(mcpResult.success).toBe(false);
    expect(cliResult.success).toBe(false);
    expect(exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);

    expect(mcpResult.error?.code).toBe('CAPABILITY_DENIED');
    expect(cliResult.error?.code).toBe('CAPABILITY_DENIED');
    expect(mcpResult.error?.tool).toBe('exarchos_workflow');
    expect(cliResult.error?.tool).toBe('exarchos_workflow');
    expect(mcpResult.error?.action).toBe('transition');
    expect(cliResult.error?.action).toBe('transition');

    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});
