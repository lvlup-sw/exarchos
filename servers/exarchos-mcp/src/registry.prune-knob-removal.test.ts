// ─── DR-9 (debloat task 016): the removed prune `thresholdMinutes` knob ──────
//
// `thresholdMinutes` was accepted-but-ignored on the `prune_stale_workflows`
// action since #1334 (per-phase staleness moved to `topology.yaml` `staleness`
// blocks). The debloat wave removed it. Because CLI flags AUTO-EMIT from each
// action's Zod schema (via `addFlagsFromSchema`), dropping the schema field
// MUST drop the `--threshold-minutes` flag too. These tests pin that removal
// against the REAL registry + the REAL flag emitter — no grep, no mocks.

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { TOOL_REGISTRY, buildRegistrationSchema } from './registry.js';
import type { ToolAction, CompositeTool } from './registry.js';
import { addFlagsFromSchema } from './adapters/schema-to-flags.js';

/** The real, un-mocked `exarchos_orchestrate` composite tool. */
function orchestrateTool(): CompositeTool {
  const tool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
  if (!tool) throw new Error('exarchos_orchestrate tool missing from TOOL_REGISTRY');
  return tool;
}

/** The real, un-mocked `prune_stale_workflows` action. */
function pruneAction(): ToolAction {
  const action = orchestrateTool().actions.find((a) => a.name === 'prune_stale_workflows');
  if (!action) throw new Error('prune_stale_workflows action missing from exarchos_orchestrate');
  return action;
}

/**
 * Emit the CLI flag set exactly the way the generic CLI path does
 * (`adapters/cli.ts` → `addFlagsFromSchema(cmd, action.schema, action.cli?.flags)`),
 * then read the resulting Commander option longs. This is the true emitted flag
 * set — derived from the schema, not a source grep.
 */
function emittedFlagLongs(action: ToolAction): string[] {
  const cmd = new Command();
  addFlagsFromSchema(cmd, action.schema, action.cli?.flags);
  return cmd.options.map((o) => o.long).filter((l): l is string => typeof l === 'string');
}

describe('DR-9 prune `thresholdMinutes` knob removal', () => {
  it('PruneSchema_RemovedKnob_NoLongerEmitsFlag', () => {
    const flags = emittedFlagLongs(pruneAction());

    // Premise guard: the surviving prune flags DO emit — proves the emitter is
    // live and the negative assertion below is not vacuously green on an empty
    // flag set.
    expect(flags).toContain('--dry-run');
    expect(flags).toContain('--no-dry-run');
    expect(flags).toContain('--force');
    expect(flags).toContain('--include-one-shot');
    expect(flags).toContain('--json');

    // The removed knob emits NO flag — neither the value flag nor a negated form.
    expect(flags).not.toContain('--threshold-minutes');
    expect(flags).not.toContain('--no-threshold-minutes');

    // And the schema field itself is gone (the source the flag derives from).
    expect('thresholdMinutes' in pruneAction().schema.shape).toBe(false);
  });

  it('Registration_PruneSchema_StillBuilds', () => {
    const actions = orchestrateTool().actions;

    // The shared-field flattener reconciles same-name base types across every
    // orchestrate action and THROWS on a divergent contract. Removing the prune
    // field must leave that reconciliation undisturbed.
    expect(() => buildRegistrationSchema(actions)).not.toThrow();

    // The flattened registration schema carries the surviving prune fields but
    // NOT the removed knob.
    const registration = buildRegistrationSchema(actions);
    expect('dryRun' in registration.shape).toBe(true);
    expect('thresholdMinutes' in registration.shape).toBe(false);
  });
});
