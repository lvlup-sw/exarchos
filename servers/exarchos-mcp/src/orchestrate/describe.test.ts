// ─── describe entries reflect deprecation + DoNotUse pointer (T41, DR-11) ──
//
// Verifies that:
//   • `describe({actions: ['set']})` returns `deprecated: true` for the
//     deprecated phase-write surface so model-facing agents can pivot to
//     the canonical `transition` action without human prompting.
//   • The `set` action description string contains the exact pointer
//     "Do NOT use — use action: 'transition' instead" so the migration
//     breadcrumb is visible in the slim/full registration descriptions.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleWorkflow } from '../workflow/composite.js';
import { EventStore } from '../event-store/store.js';
import { TOOL_REGISTRY } from '../registry.js';
import type { DispatchContext } from '../core/dispatch.js';

let tmpDir: string;
let ctx: DispatchContext;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-describe-'));
  ctx = {
    stateDir: tmpDir,
    eventStore: new EventStore(tmpDir),
    enableTelemetry: false,
  };
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const DO_NOT_USE_POINTER = "Do NOT use — use action: 'transition' instead";

// ─── T41 RED: describe metadata reflects deprecation ───────────────────────

describe('Describe_SetAction (T41, DR-11)', () => {
  it('Describe_SetAction_ReturnsDeprecatedTrue', async () => {
    const result = await handleWorkflow(
      { action: 'describe', actions: ['set', 'transition'] },
      ctx,
    );
    expect(result.success).toBe(true);

    const data = (result as { data?: Record<string, unknown> }).data;
    expect(data).toBeDefined();
    const setEntry = (data as Record<string, Record<string, unknown>>).set;
    const transitionEntry = (data as Record<string, Record<string, unknown>>)
      .transition;
    expect(setEntry).toBeDefined();
    expect(transitionEntry).toBeDefined();

    // The deprecated surface advertises `deprecated: true`.
    expect(setEntry.deprecated).toBe(true);
    // The canonical surface is NOT deprecated.
    expect(transitionEntry.deprecated).toBeFalsy();
  });

  it('ToolDescription_SetAction_ContainsDoNotUsePointer', () => {
    const workflowTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_workflow');
    expect(workflowTool).toBeDefined();
    const setAction = workflowTool!.actions.find((a) => a.name === 'set');
    expect(setAction).toBeDefined();
    // Substring match on the literal pointer — paraphrasing breaks the
    // contract (model-facing agents look for the exact phrase).
    expect(setAction!.description).toContain(DO_NOT_USE_POINTER);
  });
});
