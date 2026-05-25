/**
 * T12 — CLI↔MCP facade parity for invariants_scaffold + invariants_add (INV-2).
 *
 * Both verbs have two facades:
 *   1. MCP — `exarchos_orchestrate { action: 'invariants_scaffold' | 'invariants_add' }`.
 *   2. CLI — the auto-generated `exarchos orch <action>` surface (flags emitted
 *      from each action's Zod schema in registry.ts — no hand-added flags).
 *
 * Both dispatch through the same `exarchos_orchestrate` composite, so for the
 * same args they MUST project byte-identical ToolResult payloads (modulo the
 * wall-clock fields the envelope wrapper injects). This is INV-2.
 *
 * Strategy (mirrors check-invariant-conformance.parity.test.ts): stub the
 * composite via `stubCompositeHandler` and forward to the real handlers with a
 * FRESH in-memory fs per invocation, so the two arms each see identical
 * starting state and produce byte-equal output without touching disk. The add
 * arm uses dryRun (the default) so it is fully deterministic and writes nothing.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../event-store/store.js';
import type { DispatchContext, CompositeHandler } from '../../core/dispatch.js';
import { stubCompositeHandler } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../../__tests__/parity-harness.js';

import { handleScaffold } from './scaffold.js';
import type { ScaffoldDeps } from './scaffold.js';
import { handleAdd } from './add.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const REPO_ROOT = '/parity-repo';
const CATALOG_REL = 'docs/architecture/my-invariants.md';

const VALID_ENTRY = {
  dimension: 'example-dimension',
  axis: 'authoring',
  'cost-of-load': 'reference-only',
  'applies-to': ['src/**/*.ts'],
  summary: 'Modules must not import across the boundary.',
  references: ['docs/architecture/some-design.md'],
  severity: { default: 'advisory' },
  'integrity-class': 'user',
  enforcement: {
    mode: 'audit',
    'audit-prompt': 'Does the diff cross the boundary? Cite the file + line.',
  },
} as const;

/** Fresh in-memory fs per call, seeded with an empty catalog + minimal config. */
function freshDeps(): ScaffoldDeps {
  const files = new Map<string, string>([
    [path.join(REPO_ROOT, CATALOG_REL), 'invariants: []\n'],
    [path.join(REPO_ROOT, '.exarchos.yml'), 'test: npm test\n'],
  ]);
  return {
    exists: (p) => files.has(p),
    read: (p) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    },
    write: (p, contents) => {
      files.set(p, contents);
    },
  };
}

// ─── Arm helpers ─────────────────────────────────────────────────────────────

interface ArmContext {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

async function createArm(prefix: string): Promise<ArmContext> {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  return { stateDir, ctx: { stateDir, eventStore, enableTelemetry: false } };
}

/**
 * Composite stub that forwards the two authoring actions to the real handlers
 * with a fresh in-memory fs. The scaffold path creates a brand-new file
 * (deterministic) per call; the add path is dryRun (writes nothing).
 */
function buildAuthoringStub(): CompositeHandler {
  return async (args, ctx): Promise<ToolResult> => {
    const { action, ...rest } = args;
    if (action === 'invariants_scaffold') {
      // Use a fresh in-memory fs that does NOT pre-seed the catalog file, so
      // the scaffold genuinely "creates" it (deterministic across arms).
      const files = new Map<string, string>([
        [path.join(REPO_ROOT, '.exarchos.yml'), 'test: npm test\n'],
      ]);
      const deps: ScaffoldDeps = {
        exists: (p) => files.has(p),
        read: (p) => {
          const c = files.get(p);
          if (c === undefined) throw new Error(`ENOENT: ${p}`);
          return c;
        },
        write: (p, contents) => {
          files.set(p, contents);
        },
      };
      return handleScaffold(
        { repoRoot: REPO_ROOT, path: rest.path as string, tier: rest.tier as 'dev' | 'user' },
        deps,
      );
    }
    if (action === 'invariants_add') {
      return handleAdd(
        {
          repoRoot: REPO_ROOT,
          entry: rest.entry as Record<string, unknown>,
          catalog: rest.catalog as string,
          tier: rest.tier as 'dev' | 'user',
          dryRun: rest.dryRun === undefined ? true : Boolean(rest.dryRun),
        },
        ctx,
        freshDeps(),
      );
    }
    return {
      success: false,
      error: { code: 'UNEXPECTED_ACTION', message: `parity stub got "${String(action)}"` },
    };
  };
}

function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    keyPlaceholders: { ms: '<MS>' },
    dropKeys: new Set(['_perf', '_meta']),
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('invariants_scaffold + invariants_add CLI↔MCP parity (INV-2)', () => {
  let arms: ArmContext[] = [];
  let restoreStub: (() => void) | null = null;

  afterEach(async () => {
    restoreStub?.();
    restoreStub = null;
    for (const arm of arms) {
      await rm(arm.stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    arms = [];
    vi.restoreAllMocks();
  });

  it('InvariantsScaffold_Parity_CliEqualsMcp', async () => {
    restoreStub = stubCompositeHandler('exarchos_orchestrate', buildAuthoringStub());

    const cliArm = await createArm('inv-scaffold-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('inv-scaffold-parity-mcp-');
    arms.push(mcpArm);

    const { result: cliResult, exitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'invariants_scaffold',
      { path: CATALOG_REL, tier: 'user' },
    );
    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'invariants_scaffold',
      path: CATALOG_REL,
      tier: 'user',
    });

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(exitCode).toBe(0);

    const normalizedCli = normalize(cliResult);
    const normalizedMcp = normalize(mcpResult);
    expect(normalizedCli).toEqual(normalizedMcp);
    expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));
  });

  it('InvariantsAdd_Parity_CliEqualsMcp', async () => {
    restoreStub = stubCompositeHandler('exarchos_orchestrate', buildAuthoringStub());

    const cliArm = await createArm('inv-add-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('inv-add-parity-mcp-');
    arms.push(mcpArm);

    const addArgs = {
      entry: VALID_ENTRY,
      catalog: CATALOG_REL,
      tier: 'user',
      // dryRun omitted → defaults to true at dispatch (INV-5c): deterministic.
    };

    const { result: cliResult, exitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'invariants_add',
      addArgs,
    );
    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'invariants_add',
      ...addArgs,
    });

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(exitCode).toBe(0);

    const cliData = cliResult.data as { committed: boolean; renderedEntry: string };
    expect(cliData.committed).toBe(false);
    expect(cliData.renderedEntry).toMatch(/mode: audit/);

    const normalizedCli = normalize(cliResult);
    const normalizedMcp = normalize(mcpResult);
    expect(normalizedCli).toEqual(normalizedMcp);
    expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));
  });
});
