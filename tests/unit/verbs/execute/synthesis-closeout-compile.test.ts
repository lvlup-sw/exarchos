// @oracle-sources: ../../../../src/verbs/execute/compile.ts, the two-action runbook order written out by hand directly above the quantifier — the population `every` ranges over is pinned to exactly that list on the preceding line so a short or empty segment cannot satisfy the execution-authority predicate vacuously
//
// ─── Compiling the synthesis-closeout segment ───────────────────────────────
//
// One `prBody` argument binds onto both leaves' `body` parameter, which is the
// whole reason this is one intent rather than two calls: the body that is
// validated is the body that is opened. The caller answers once.
//
// The compile-time half of the cross-stream observation mechanism is asserted
// HERE rather than inferred from the executor passing. `create_pr` journals its
// intent and its result onto the shared `vcs` stream, so the stream its
// declared emissions are observed on is resolved from its contract, not from
// the subject argument; `validate_pr_body` declares no such stream and is
// observed on the segment's own. A test that only watched the executor succeed
// could not tell the two apart.
//
// The two refusal paths are exercised separately and deliberately. The schema
// refuses a call that omits a branch — that is the path a real caller takes.
// The compiler's own unbound-variable refusal is a SECOND fence, reachable only
// by a validated-args set that satisfies its schema and still lacks the
// variable; a fixture arranges exactly that, so removing either fence reddens
// something.

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

  it('SynthesisCloseout_OnePrBody_BindsOntoBothLeafSpellings', () => {
    const leaves = leavesOf(compileIntent(INTENT, SUBJECT, ARGS, PRODUCTION_COMPILE_DEPS));
    const byAction = new Map(leaves.map((leaf) => [leaf.action, leaf.args]));

    expect(byAction.get('validate_pr_body')).toMatchObject({
      featureId: SUBJECT.streamId,
      body: PR_BODY,
    });
    // Never `pr`: with a PR number the body check shells out to read the body
    // back from the remote, and at this point in the flow there is no remote
    // request to read it from.
    expect(byAction.get('validate_pr_body')).not.toHaveProperty('pr');
    expect(byAction.get('create_pr')).toMatchObject({
      featureId: SUBJECT.streamId,
      title: ARGS.title,
      body: PR_BODY,
      base: ARGS.baseBranch,
      head: ARGS.headBranch,
    });
    // The one document, under both spellings, is the same text.
    expect((byAction.get('create_pr') as { body: string }).body).toBe(
      (byAction.get('validate_pr_body') as { body: string }).body,
    );
  });

  it('SynthesisCloseout_CreatePrLeaf_IsObservedOnTheSharedVcsStream', () => {
    const leaves = leavesOf(compileIntent(INTENT, SUBJECT, ARGS, PRODUCTION_COMPILE_DEPS));
    const byAction = new Map(leaves.map((leaf) => [leaf.action, leaf]));

    // Resolved from the contract, which is declared ahead of any run — not from
    // what the handler turned out to do. The subject argument the compiler
    // wrote onto this leaf does NOT override it.
    expect(byAction.get('create_pr')?.observationStreamId).toBe('vcs');
    expect(byAction.get('create_pr')?.args).toMatchObject({ featureId: SUBJECT.streamId });
    // The other leaf declares no infrastructure stream, so it is observed where
    // every ordinary leaf is: the segment's own subject.
    expect(byAction.get('validate_pr_body')?.observationStreamId).toBe(SUBJECT.streamId);
  });

  it('SynthesisCloseout_WithoutHeadBranch_RefusedByTheIntentSchema', () => {
    const { headBranch: _dropped, ...withoutHead } = ARGS;
    const refusal = refusalOf(compileIntent(INTENT, SUBJECT, withoutHead, PRODUCTION_COMPILE_DEPS));
    expect(refusal.code).toBe('INTENT_ARGS_INVALID');
    expect(refusal.message).toContain('headBranch');
  });

  it('SynthesisCloseout_DraftKnob_Refused', () => {
    // Not an oversight: every field the schema takes is one a leaf's own schema
    // requires. An optional provider knob no leaf needs would be surface with
    // no contract behind it.
    const refusal = refusalOf(
      compileIntent(INTENT, SUBJECT, { ...ARGS, draft: true }, PRODUCTION_COMPILE_DEPS),
    );
    expect(refusal.code).toBe('INTENT_ARGS_INVALID');
    expect(refusal.message).toContain('draft');
  });

  it('SynthesisCloseout_ValidatedArgsWithoutTheVariable_HitTheUnboundFence', () => {
    // The second fence, reached the only way it can be: a schema that accepts a
    // call the runbook's `<prBody>` placeholder has nothing to bind to. The
    // shipped schema makes the field required precisely so a real caller never
    // gets here — which is also why the fence needs its own subject to stay
    // non-vacuous.
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
    // The refusal names WHERE, so a caller does not have to diff the runbook.
    expect(refusal.step).toBe('0:validate_pr_body');
  });
});
