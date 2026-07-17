// Opt-in eval surface (DR-3).
//
// This package exists solely to own the heavy, eval-only `promptfoo` dependency
// OUTSIDE the default MCP-server install, so a plain `npm install` in
// servers/exarchos-mcp/ no longer pulls promptfoo (and its large transitive
// tree). It is intentionally NOT a workspace of the server or the repo root —
// making it a standalone, install-on-demand package is the mechanism that keeps
// the default closure slim.
//
// The llm-rubric / llm-similarity graders live in ../src/evals/graders and
// resolve promptfoo's `assertions` surface from THIS package's node_modules at
// runtime via ../src/evals/graders/promptfoo-loader.ts. This module re-exports
// that surface so the eval package's own tsconfig typechecks the promptfoo
// contract the graders depend on — a compile-time canary that fires here (only
// when the eval package is installed), never in the default server typecheck.
import { assertions } from 'promptfoo';

export const promptfooAssertions = assertions;
