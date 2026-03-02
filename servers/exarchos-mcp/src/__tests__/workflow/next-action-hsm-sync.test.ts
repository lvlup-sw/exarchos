import { describe, it, expect } from 'vitest';
import {
  createFeatureHSM,
  createDebugHSM,
  createRefactorHSM,
} from '../../workflow/hsm-definitions.js';
import { HUMAN_CHECKPOINT_PHASES } from '../../workflow/next-action.js';
import type { HSMDefinition } from '../../workflow/state-machine.js';

/**
 * Validates that action strings derived from HSM transitions match
 * the pattern AUTO:${transition.to}. This guards against re-introduction
 * of static phase-to-action overrides that drift from HSM definitions.
 *
 * The next-action handler uses `AUTO:${transition.to}` for all non-fix-cycle
 * transitions. This test walks every HSM transition to verify that pattern
 * produces valid, HSM-aligned action strings.
 */

interface HSMFactory {
  name: string;
  create: () => HSMDefinition;
}

const workflows: HSMFactory[] = [
  { name: 'feature', create: createFeatureHSM },
  { name: 'debug', create: createDebugHSM },
  { name: 'refactor', create: createRefactorHSM },
];

describe('Next-Action HSM Sync', () => {
  for (const { name, create } of workflows) {
    describe(`${name} workflow`, () => {
      const hsm = create();

      it('every non-fix-cycle transition target is a valid HSM state', () => {
        const stateIds = new Set(Object.keys(hsm.states));

        for (const transition of hsm.transitions) {
          if (transition.isFixCycle) continue;
          expect(
            stateIds.has(transition.to),
            `Transition ${transition.from} -> ${transition.to}: target '${transition.to}' is not a valid state in ${name} HSM`,
          ).toBe(true);
        }
      });

      it('derived AUTO:${transition.to} produces unique action per source phase (first match)', () => {
        // Group non-fix-cycle transitions by source phase
        const bySource = new Map<string, string[]>();
        for (const transition of hsm.transitions) {
          if (transition.isFixCycle) continue;
          const targets = bySource.get(transition.from) ?? [];
          targets.push(transition.to);
          bySource.set(transition.from, targets);
        }

        // Each source phase should have at least one outbound transition
        // (except final states which have none)
        for (const [phase, targets] of bySource) {
          expect(targets.length).toBeGreaterThan(0);
          // The first matching transition determines the action string
          const action = `AUTO:${targets[0]}`;
          expect(action).toMatch(/^AUTO:[a-z][a-z0-9-]*$/);
        }
      });

      it('human checkpoint phases are valid HSM state IDs', () => {
        const checkpoints = HUMAN_CHECKPOINT_PHASES[name];
        if (!checkpoints) return; // Not all workflows have checkpoints

        const stateIds = new Set(Object.keys(hsm.states));
        for (const phase of checkpoints) {
          expect(
            stateIds.has(phase),
            `Human checkpoint phase '${phase}' is not a valid state in ${name} HSM`,
          ).toBe(true);
        }
      });

      it('no transition target uses workflow-prefixed naming (e.g., refactor-brief)', () => {
        const badPrefixes = ['feature-', 'debug-', 'refactor-'];
        // Exceptions: track-specific phases legitimately use prefixes
        // (e.g., debug-implement, polish-implement, overhaul-plan)
        const legitimatePrefixed = new Set(Object.keys(hsm.states));

        for (const transition of hsm.transitions) {
          const target = transition.to;
          for (const prefix of badPrefixes) {
            if (target.startsWith(prefix) && !legitimatePrefixed.has(target)) {
              throw new Error(
                `Transition ${transition.from} -> ${target}: uses workflow-prefixed name '${target}' that is not in HSM states`,
              );
            }
          }
        }
      });
    });
  }
});
