/**
 * The `prune_stale_workflows` action must have no `thresholdMinutes` field and no `--threshold-minutes` flag.
 *
 * The `staleness` blocks of `topology.yaml` hold the staleness of each phase.
 * The CLI derives its flags from the Zod schema of each action through `addFlagsFromSchema`.
 * The tests use the real registry and the real flag emitter, with no mocks.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { TOOL_REGISTRY, buildRegistrationSchema } from '../../src/registry.js';
import type { ToolAction, CompositeTool } from '../../src/registry.js';
import { addFlagsFromSchema } from '../../src/adapters/cli/schema-to-flags.js';

/** Returns the `exarchos_orchestrate` tool from `TOOL_REGISTRY`. */
function orchestrateTool(): CompositeTool {
  const tool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
  if (!tool) throw new Error('exarchos_orchestrate tool missing from TOOL_REGISTRY');
  return tool;
}

/** Returns the `prune_stale_workflows` action of `exarchos_orchestrate`. */
function pruneAction(): ToolAction {
  const action = orchestrateTool().actions.find((a) => a.name === 'prune_stale_workflows');
  if (!action) throw new Error('prune_stale_workflows action missing from exarchos_orchestrate');
  return action;
}

/**
 * Returns the long flag names that `addFlagsFromSchema` adds to a Commander command for `action`.
 * The generic CLI path makes the same call with the same arguments.
 */
function emittedFlagLongs(action: ToolAction): string[] {
  const cmd = new Command();
  addFlagsFromSchema(cmd, action.schema, action.cli?.flags);
  return cmd.options.map((o) => o.long).filter((l): l is string => typeof l === 'string');
}

describe('DR-9 prune `thresholdMinutes` knob removal', () => {
  /**
   * The test first asserts the flags that the action keeps.
   * Without those assertions, an empty flag set makes the negative assertions pass.
   */
  it('PruneSchema_RemovedKnob_NoLongerEmitsFlag', () => {
    const flags = emittedFlagLongs(pruneAction());

    expect(flags).toContain('--dry-run');
    expect(flags).toContain('--no-dry-run');
    expect(flags).toContain('--force');
    expect(flags).toContain('--include-one-shot');
    expect(flags).toContain('--json');

    expect(flags).not.toContain('--threshold-minutes');
    expect(flags).not.toContain('--no-threshold-minutes');

    expect('thresholdMinutes' in pruneAction().schema.shape).toBe(false);
  });

  /**
   * `buildRegistrationSchema` throws when two orchestrate actions give one field name a different contract.
   * The flattened schema must hold `dryRun` and must not hold `thresholdMinutes`.
   */
  it('Registration_PruneSchema_StillBuilds', () => {
    const actions = orchestrateTool().actions;

    expect(() => buildRegistrationSchema(actions)).not.toThrow();

    const registration = buildRegistrationSchema(actions);
    expect('dryRun' in registration.shape).toBe(true);
    expect('thresholdMinutes' in registration.shape).toBe(false);
  });
});
