// Ambient type shim for the opt-in, eval-only `promptfoo` dependency.
//
// Only the eval package (`tools/evals-pkg`) ships promptfoo. The default install does not.
// With this shim, the graders' dynamic `import('promptfoo')` type-checks without the package.
// It declares only the `assertions` surface that the graders use. The root package does not
// declare promptfoo, and the eval gate builds before it installs promptfoo into `tools/evals-pkg`.
// The root type-check therefore never sees the real package types.
declare module 'promptfoo' {
  export interface PromptfooAssertionResult {
    pass: boolean;
    score?: number;
    reason?: string;
  }

  export const assertions: {
    matchesLlmRubric(
      rubric: string,
      output: string,
      options: Record<string, unknown>,
    ): Promise<PromptfooAssertionResult>;
    matchesSimilarity(
      expected: string,
      output: string,
      threshold: number,
      inverse: boolean,
      options: Record<string, unknown>,
    ): Promise<PromptfooAssertionResult>;
  };
}
