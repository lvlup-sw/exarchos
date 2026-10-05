// @oracle-sources: ../../../../src/verbs/execute/compile.ts, the two-action runbook order written out by hand directly above the quantifier — the population `every` ranges over is pinned to exactly that list on the preceding line so a short or empty segment cannot satisfy the execution-authority predicate vacuously
//
// The synthesis-closeout segment binds one `prBody` argument onto the `body` parameter
// of both leaves, so the two leaves cannot get different texts.
//
// The compiler resolves the observation stream of each leaf from its contract. `create_pr`
// journals onto the shared `vcs` stream. `validate_pr_body` is observed on the segment stream.
// A test that only sees the executor succeed cannot tell the two apart.
//
// Two fences refuse a missing argument. The intent schema refuses a call that omits a branch.
// The unbound-variable refusal of the compiler is the second fence, and a fixture schema reaches it.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  compileIntent,
  PRODUCTION_COMPILE_DEPS,
  type CompileDeps,
} from '../../../../src/verbs/execute/compile.js';
import type { CompiledLeaf } from '../../../../src/verbs/execute/types.js';

const INTENT = 'synthesis-closeout';
const SUBJECT = { streamId: 'wf-synthesis-closeout' };
const PR_BODY = ['## Summary', '', 'One change.', '', '## Changes', '', '## Test Plan', ''].join(
  '\n',
);
const ARGS = {
  title: 'feat: close the segment out',
  prBody: PR_BODY,
  baseBranch: 'main',
  headBranch: 'feature/closeout',
};

function refusalOf(outcome: ReturnType<typeof compileIntent>): {
  code: string;
  message: string;
  step?: string;
} {
  if (outcome.ok) throw new Error('expected a compile refusal, got a segment');
  return outcome.refusal;
}

function leavesOf(outcome: ReturnType<typeof compileIntent>): readonly CompiledLeaf[] {
  if (!outcome.ok) {
    throw new Error(`expected a segment, got ${outcome.refusal.code}: ${outcome.refusal.message}`);
  }
  return outcome.segment.leaves;
}

describe('synthesis-closeout compiles against the live registry', () => {
  it('SynthesisCloseout_CompilesToTheTwoShippedLeaves_InRunbookOrder', () => {
    const leaves = leavesOf(compileIntent(INTENT, SUBJECT, ARGS, PRODUCTION_COMPILE_DEPS));

    expect(leaves.map((leaf) => leaf.action)).toEqual(['validate_pr_body', 'create_pr']);
    expect(leaves.map((leaf) => leaf.onFail)).toEqual(['stop', 'stop']);
    expect(leaves.every((leaf) => leaf.contract.executionAuthority.kind === 'local')).toBe(true);
  });

  /**
   * `enforce: true` is a literal of the step. Without it, the section verdict rides the success carrier,
   * where the `stop` policy cannot see it. Then `create_pr` runs on a body that the check rejected.
   * The body check gets no `pr` argument. With a PR number, the check reads the body back from the remote,
   * and no pull request exists on the remote at this point.
   */
  it('SynthesisCloseout_OnePrBody_BindsOntoBothLeafSpellings', () => {
    const leaves = leavesOf(compileIntent(INTENT, SUBJECT, ARGS, PRODUCTION_COMPILE_DEPS));
    const byAction = new Map(leaves.map((leaf) => [leaf.action, leaf.args]));

    expect(byAction.get('validate_pr_body')).toMatchObject({
      featureId: SUBJECT.streamId,
      body: PR_BODY,
      enforce: true,
    });
    expect(byAction.get('validate_pr_body')).not.toHaveProperty('pr');
    expect(byAction.get('create_pr')).toMatchObject({
      featureId: SUBJECT.streamId,
      title: ARGS.title,
      body: PR_BODY,
      base: ARGS.baseBranch,
      head: ARGS.headBranch,
    });
    expect((byAction.get('create_pr') as { body: string }).body).toBe(
      (byAction.get('validate_pr_body') as { body: string }).body,
    );
  });

  /**
   * The compiler resolves the stream from the declared contract, not from what the handler does.
   * The subject argument on the `create_pr` leaf does not override it. The other leaf declares
   * no infrastructure stream, so it is observed on the segment subject.
   */
  it('SynthesisCloseout_CreatePrLeaf_IsObservedOnTheSharedVcsStream', () => {
    const leaves = leavesOf(compileIntent(INTENT, SUBJECT, ARGS, PRODUCTION_COMPILE_DEPS));
    const byAction = new Map(leaves.map((leaf) => [leaf.action, leaf]));

    expect(byAction.get('create_pr')?.observationStreamId).toBe('vcs');
    expect(byAction.get('create_pr')?.args).toMatchObject({ featureId: SUBJECT.streamId });
    expect(byAction.get('validate_pr_body')?.observationStreamId).toBe(SUBJECT.streamId);
  });

  it('SynthesisCloseout_WithoutHeadBranch_RefusedByTheIntentSchema', () => {
    const { headBranch: _dropped, ...withoutHead } = ARGS;
    const refusal = refusalOf(compileIntent(INTENT, SUBJECT, withoutHead, PRODUCTION_COMPILE_DEPS));
    expect(refusal.code).toBe('INTENT_ARGS_INVALID');
    expect(refusal.message).toContain('headBranch');
  });

  /**
   * Each field of the intent schema is one that a leaf schema requires.
   * An optional provider knob that no leaf needs has no contract behind it.
   */
  it('SynthesisCloseout_DraftKnob_Refused', () => {
    const refusal = refusalOf(
      compileIntent(INTENT, SUBJECT, { ...ARGS, draft: true }, PRODUCTION_COMPILE_DEPS),
    );
    expect(refusal.code).toBe('INTENT_ARGS_INVALID');
    expect(refusal.message).toContain('draft');
  });

  /**
   * The shipped schema requires `prBody`, so a real caller never reaches the second fence.
   * A permissive fixture schema accepts a call that leaves the `<prBody>` placeholder unbound.
   * The refusal names the step, so a caller does not have to compare against the runbook.
   */
  it('SynthesisCloseout_ValidatedArgsWithoutTheVariable_HitTheUnboundFence', () => {
    const permissive: CompileDeps = {
      ...PRODUCTION_COMPILE_DEPS,
      argSchemas: {
        ...PRODUCTION_COMPILE_DEPS.argSchemas,
        [INTENT]: z.object({ prBody: z.string().min(1).optional() }).strict(),
      },
    };

    const refusal = refusalOf(compileIntent(INTENT, SUBJECT, {}, permissive));
    expect(refusal.code).toBe('INTENT_TEMPLATE_VAR_UNBOUND');
    expect(refusal.message).toContain('prBody');
    expect(refusal.step).toBe('0:validate_pr_body');
  });
});
