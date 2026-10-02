// Opt-in eval package. It owns the eval-only `promptfoo` dependency, so the default install does not pull it.
// This package is not a workspace of the repo root. Install it only when you run the evals.
//
// The llm-rubric and llm-similarity graders in `tools/evals/evals/graders` load promptfoo from the
// `node_modules` of this package through `promptfoo-loader.ts`. This module re-exports the
// `assertions` surface, so the typecheck of this package checks the contract that the graders use.
import { assertions } from 'promptfoo';

export const promptfooAssertions = assertions;
