// ─── ACCEPTANCE — outputSchema registers _meta.deprecation (T39, DR-11) ────
//
// Verifies that the affected actions in the C4 (HSM API single-path)
// bundle expose a typed `outputSchema` and that the schema registers
// `_meta.deprecation` as a typed sub-shape. The test additionally verifies
// CLI/MCP byte-equivalence of the response envelope via the parity harness:
// when `set({phase})` is invoked through both carriers, the deprecation
// envelope is identical down to the bytes (modulo wall-clock placeholders).
//
// Kept RED until T40 + T41 land — covered jointly by the bundle.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

import { TOOL_REGISTRY } from './registry.js';
import { handleInit, handleSet } from './workflow/tools.js';
import { EventStore } from './event-store/store.js';
import type { DispatchContext } from './core/dispatch.js';
import {
  callCli,
  callMcp,
  normalize,
} from './__tests__/parity-harness.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(stateDir: string): DispatchContext {
  return {
    stateDir,
    eventStore: new EventStore(stateDir),
    enableTelemetry: false,
  };
}

async function primeForIdeateToPlan(
  ctx: DispatchContext,
  featureId: string,
): Promise<void> {
  await handleInit(
    { featureId, workflowType: 'feature' },
    ctx.stateDir,
    ctx.eventStore,
  );
  await handleSet(
    { featureId, updates: { 'artifacts.design': 'docs/design.md' } },
    ctx.stateDir,
    ctx.eventStore,
  );
}

let cliDir: string;
let mcpDir: string;
let cliCtx: DispatchContext;
let mcpCtx: DispatchContext;

beforeEach(async () => {
  cliDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-acc-cli-'));
  mcpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-acc-mcp-'));
  cliCtx = makeCtx(cliDir);
  mcpCtx = makeCtx(mcpDir);
});

afterEach(async () => {
  await fs.rm(cliDir, { recursive: true, force: true });
  await fs.rm(mcpDir, { recursive: true, force: true });
});

// ─── ACCEPTANCE TEST ────────────────────────────────────────────────────────

describe('OutputSchema (acceptance, T39, DR-11)', () => {
  it('OutputSchema_AffectedActions_RegistersMetaDeprecation', async () => {
    // ─── (1) Both affected actions declare an `outputSchema` typing
    //         `_meta.deprecation`. Verified directly against the registry.
    const workflowTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_workflow');
    expect(workflowTool).toBeDefined();

    const setAction = workflowTool!.actions.find((a) => a.name === 'set');
    const transitionAction = workflowTool!.actions.find((a) => a.name === 'transition');
    expect(setAction?.outputSchema).toBeDefined();
    expect(transitionAction?.outputSchema).toBeDefined();

    // The registered schema must accept a payload carrying the typed
    // `_meta.deprecation` sub-shape exactly as produced by the deprecation
    // rerouting surface.
    const probe = {
      success: true,
      data: { phase: 'plan', updatedAt: '2026-05-08T00:00:00Z' },
      _meta: {
        deprecation: {
          since: '2.10.0',
          removeIn: '2.11.0',
          replacement: 'transition',
        },
      },
    };
    expect(
      (setAction!.outputSchema as z.ZodTypeAny).safeParse(probe).success,
    ).toBe(true);
    expect(
      (transitionAction!.outputSchema as z.ZodTypeAny).safeParse(probe).success,
    ).toBe(true);

    // Reject obviously-invalid deprecation envelopes so the schema's
    // type-checking is meaningful (not a permissive `passthrough`).
    const bogus = {
      success: true,
      data: { phase: 'plan', updatedAt: '2026-05-08T00:00:00Z' },
      _meta: {
        deprecation: {
          since: '', // empty string violates `z.string().min(1)`
          removeIn: '2.11.0',
          replacement: 'transition',
        },
      },
    };
    expect(
      (setAction!.outputSchema as z.ZodTypeAny).safeParse(bogus).success,
    ).toBe(false);

    // ─── (2) CLI/MCP byte-equivalence of the deprecation envelope.
    //         Drive both carriers with the same `set({phase})` call and
    //         assert their normalized responses are deep-equal.
    const featureId = 't39-parity';

    await primeForIdeateToPlan(cliCtx, featureId);
    await primeForIdeateToPlan(mcpCtx, featureId);

    const mcpResult = await callMcp(mcpCtx, 'exarchos_workflow', {
      action: 'set',
      featureId,
      phase: 'plan',
    });
    const { result: cliResult } = await callCli(cliCtx, 'wf', 'set', {
      featureId,
      phase: 'plan',
    });

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);

    const normalizeOpts = { dropKeys: new Set(['_perf']) };
    expect(normalize(cliResult, normalizeOpts)).toEqual(
      normalize(mcpResult, normalizeOpts),
    );

    // The deprecation envelope itself must be present and byte-equal across
    // carriers (not just the surrounding payload).
    const cliMeta = (cliResult as { _meta?: Record<string, unknown> })._meta;
    const mcpMeta = (mcpResult as { _meta?: Record<string, unknown> })._meta;
    expect(cliMeta?.deprecation).toEqual(mcpMeta?.deprecation);
    expect(cliMeta?.deprecation).toEqual({
      since: '2.10.0',
      removeIn: '2.11.0',
      replacement: 'transition',
    });
  });
});
