/**
 * No runbook step that the intent compiler can compile declares the replay kind `reject-replay`.
 * The executor elides a leaf of that kind on retry only in a segment with an immutable bound input.
 * In a segment with no bound input, it refuses the retry, and an operator must recover the segment.
 * The provider writers were the last leaves of that kind.
 * `prune_stale_workflows` declares `reject-replay`, but no runbook names it as a step, and it declares `ensures`.
 */
import { describe, expect, it } from 'vitest';
import { findActionInRegistry, TOOL_REGISTRY } from '../../src/registry.js';
import { ALL_RUNBOOKS } from '../../src/runbooks/definitions.js';

/** Each registered action with its tool and its replay kind. */
function replayKinds(): ReadonlyMap<string, string> {
  const kinds = new Map<string, string>();
  for (const tool of TOOL_REGISTRY) {
    for (const action of tool.actions) {
      const kind = action.actionContract?.replay.kind;
      if (kind !== undefined) kinds.set(`${tool.name}.${action.name}`, kind);
    }
  }
  return kinds;
}

describe('no compiled segment leaf declares reject-replay', () => {
  it('RunbookSteps_NoRegisteredLeafDeclaresRejectReplay', () => {
    const offenders: string[] = [];
    let resolved = 0;
    for (const runbook of ALL_RUNBOOKS) {
      for (const step of runbook.steps) {
        if (step.decide !== undefined || step.tool.startsWith('native:')) continue;
        const declaration = findActionInRegistry(step.tool, step.action);
        if (declaration === undefined) continue;
        resolved += 1;
        if (declaration.actionContract?.replay.kind === 'reject-replay') {
          offenders.push(`${runbook.id}: ${step.tool}.${step.action}`);
        }
      }
    }
    expect(resolved).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it('RejectReplayActions_AreNamedByNoRunbookStep', () => {
    const rejectReplay = [...replayKinds()].filter(([, kind]) => kind === 'reject-replay').map(([id]) => id);
    expect(rejectReplay).toEqual(['exarchos_orchestrate.prune_stale_workflows']);
    const stepIds = new Set(ALL_RUNBOOKS.flatMap((runbook) => runbook.steps.map((step) => `${step.tool}.${step.action}`)));
    expect(rejectReplay.filter((id) => stepIds.has(id))).toEqual([]);
  });
});
