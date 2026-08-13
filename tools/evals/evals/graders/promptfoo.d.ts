// Ambient type shim for the OPT-IN, eval-only `promptfoo` dependency (DR-3).
//
// promptfoo is intentionally absent from the default MCP-server install — it
// ships only with the opt-in eval package (tools/evals-pkg).
// This ambient declaration lets the DEFAULT-typechecked server tree compile the
// graders' dynamic `import('promptfoo')` WITHOUT the package installed, so
// `tsc --noEmit` stays green on the slim default closure. At runtime the loader
// (promptfoo-loader.ts) resolves the real module from the eval package or fails
// with an actionable install hint.
//
// Only the narrow `assertions` surface the graders consume is declared. The
// server tsc never runs with the real promptfoo present (the typecheck lane
// installs no promptfoo; the eval gate builds the server BEFORE installing the
// eval package, and that install targets evals-pkg/node_modules, invisible to
// the server's module resolution), so this shim never collides with the
// package's own types.
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
