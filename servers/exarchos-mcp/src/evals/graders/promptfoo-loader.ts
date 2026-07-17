import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Minimal shape of the promptfoo `assertions` surface the llm graders consume.
 * Declared locally so the graders never depend on promptfoo's own types (which
 * are absent from the default install, DR-3).
 */
export interface PromptfooAssertions {
  matchesLlmRubric(
    rubric: string,
    output: string,
    options: Record<string, unknown>,
  ): Promise<{ pass: boolean; score?: number; reason?: string }>;
  matchesSimilarity(
    expected: string,
    output: string,
    threshold: number,
    inverse: boolean,
    options: Record<string, unknown>,
  ): Promise<{ pass: boolean; score?: number; reason?: string }>;
}

/**
 * Actionable message shown when an llm-rubric / llm-similarity grader runs
 * without promptfoo installed. promptfoo is an OPT-IN, eval-only dependency
 * (DR-3): it lives ONLY in the eval package, never in the default MCP-server
 * install, so operators must install that package before running these graders.
 */
export const PROMPTFOO_INSTALL_HINT =
  'promptfoo is not installed. It ships only with the opt-in eval package, not the ' +
  'default MCP-server install (DR-3). Install it before running the llm-rubric / ' +
  'llm-similarity graders: `npm --prefix servers/exarchos-mcp/evals-pkg install` ' +
  '(from the repo root), or `cd servers/exarchos-mcp/evals-pkg && npm install`.';

/** Extract the `assertions` surface from an imported module namespace (ESM or CJS-interop). */
export function getAssertions(mod: unknown): PromptfooAssertions | null {
  const candidates: unknown[] = [mod, (mod as { default?: unknown } | null)?.default];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && 'assertions' in candidate) {
      const assertions = (candidate as { assertions?: unknown }).assertions;
      if (assertions && typeof assertions === 'object') {
        return assertions as PromptfooAssertions;
      }
    }
  }
  return null;
}

/**
 * Resolve promptfoo's `assertions` surface for the llm graders.
 *
 * Tries two locations in order:
 *   1. A bare `import('promptfoo')` — resolves when promptfoo is hoisted into an
 *      ancestor node_modules, and is the seam vitest's `vi.mock('promptfoo')`
 *      intercepts in the grader unit tests.
 *   2. The opt-in eval package's own node_modules
 *      (servers/exarchos-mcp/evals-pkg), which is where the eval gate installs
 *      promptfoo. Because the eval package is a standalone sibling (not hoisted
 *      into the server closure), a bare specifier can't reach it, so we resolve
 *      it explicitly relative to this module.
 *
 * Throws {@link PROMPTFOO_INSTALL_HINT} if neither resolves — an actionable
 * install hint rather than an opaque module-not-found crash.
 */
export async function loadPromptfooAssertions(): Promise<PromptfooAssertions> {
  // (1) Bare specifier.
  try {
    const mod: unknown = await import('promptfoo');
    const assertions = getAssertions(mod);
    if (assertions) return assertions;
  } catch {
    // fall through to the eval-package resolution
  }

  // (2) Opt-in eval package (servers/exarchos-mcp/evals-pkg/node_modules).
  // The relative depth is identical from src/ (vitest) and dist/ (built runner):
  // graders/ -> evals/ -> {src,dist}/ -> servers/exarchos-mcp/ -> evals-pkg/.
  try {
    const evalPkgManifest = new URL('../../../evals-pkg/package.json', import.meta.url);
    const requireFromEvalPkg = createRequire(evalPkgManifest);
    const resolved = requireFromEvalPkg.resolve('promptfoo');
    const mod: unknown = await import(pathToFileURL(resolved).href);
    const assertions = getAssertions(mod);
    if (assertions) return assertions;
  } catch {
    // not installed — surface the actionable hint below
  }

  throw new Error(PROMPTFOO_INSTALL_HINT);
}
