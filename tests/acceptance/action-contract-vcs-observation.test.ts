import { describe, expect, it } from 'vitest';
import { observationStreamId } from '../../src/dispatch/core/interceptors/emission-verifier.js';
import { VCS_STREAM_ID } from '../../src/dispatch/core/infra-streams.js';
import {
  normalizeActionContract,
  type ActionContract,
} from '../../src/registry/action-contract.js';
import { TOOL_REGISTRY, type ToolAction } from '../../src/registry.js';

const VCS_JOURNAL_ACTIONS = ['create_pr', 'add_pr_comment', 'create_issue', 'merge_pr'] as const;

function liveContract(actionName: string): ActionContract {
  const orchestrate = TOOL_REGISTRY.find((tool) => tool.name === 'exarchos_orchestrate');
  if (orchestrate === undefined) throw new Error('exarchos_orchestrate is missing from TOOL_REGISTRY');
  const action = orchestrate.actions.find((a) => a.name === actionName) as ToolAction | undefined;
  if (action === undefined) throw new Error(`${actionName} is missing from exarchos_orchestrate`);
  if (!('actionContract' in action)) throw new Error(`${actionName} is missing actionContract`);
  return normalizeActionContract(Reflect.get(action, 'actionContract'), {
    annotations: { idempotent: action.annotations.idempotent },
  });
}

describe('vcs journal action observation declarations', () => {
  it.each(VCS_JOURNAL_ACTIONS)(
    'VcsJournalActions_DeclareTheSharedStream_ObservationResolvesIt (%s)',
    (actionName) => {
      const contract = liveContract(actionName);
      expect(observationStreamId({}, contract)).toBe(VCS_STREAM_ID);
    },
  );

  it.each(VCS_JOURNAL_ACTIONS)(
    'VcsJournalActions_ForeignFeatureIdArgument_DoesNotOverrideTheDeclaration (%s)',
    (actionName) => {
      const contract = liveContract(actionName);
      expect(observationStreamId({ featureId: 'feat-unrelated' }, contract)).toBe(VCS_STREAM_ID);
    },
  );

  it.each(VCS_JOURNAL_ACTIONS)(
    'VcsJournalActions_CompiledAsLeaves_NeverFallBackToTheSegmentStream (%s)',
    (actionName) => {
      const contract = liveContract(actionName);
      // The exact expression at compile.ts:349, spelled here so the fallback
      // that armed the defect is the thing under test.
      const resolved = observationStreamId({}, contract) ?? 'segment-stream';
      expect(resolved).toBe(VCS_STREAM_ID);
    },
  );

  it.each(VCS_JOURNAL_ACTIONS)(
    'VcsJournalActions_AbstainFromPostconditions_ForAStatedReason (%s)',
    (actionName) => {
      const contract = liveContract(actionName);
      expect(contract.ensures.kind).toBe('none');
      if (contract.ensures.kind === 'none') {
        expect(contract.ensures.because.trim().length).toBeGreaterThan(0);
        expect(contract.ensures.because).not.toContain('does not resolve the stream');
      }
    },
  );
});
