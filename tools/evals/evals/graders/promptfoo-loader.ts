import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * The promptfoo `assertions` surface that the llm graders use. The default install does not
 * hold promptfoo, so this module declares the shape locally.
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
 * The error message for an llm-rubric or llm-similarity grader that runs without promptfoo.
 * Only the opt-in eval package ships promptfoo. The default MCP-server install does not.
 */
export const PROMPTFOO_INSTALL_HINT =
  'promptfoo is not installed. It ships only with the opt-in eval package, not the ' +
  'default MCP-server install (DR-3). Install it before running the llm-rubric / ' +
  'llm-similarity graders: `npm --prefix tools/evals-pkg install` ' +
  '(from the repo root), or `cd tools/evals-pkg && npm install`.';

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
 * Resolves the promptfoo `assertions` surface for the llm graders.
 *
 * It first tries a bare `import('promptfoo')`, which finds promptfoo in an ancestor
 * `node_modules`. Then it resolves promptfoo from `tools/evals-pkg`, relative to this module.
 * The eval gate installs promptfoo there, and a bare specifier cannot reach it.
 *
 * @throws Error with {@link PROMPTFOO_INSTALL_HINT} when neither location gives the surface.
 */
export async function loadPromptfooAssertions(): Promise<PromptfooAssertions> {
  try {
    const mod: unknown = await import('promptfoo');
    const assertions = getAssertions(mod);
    if (assertions) return assertions;
  } catch {
  }

  try {
    const evalPkgManifest = new URL('../../../evals-pkg/package.json', import.meta.url);
    const requireFromEvalPkg = createRequire(evalPkgManifest);
    const resolved = requireFromEvalPkg.resolve('promptfoo');
    const mod: unknown = await import(pathToFileURL(resolved).href);
    const assertions = getAssertions(mod);
    if (assertions) return assertions;
  } catch {
  }

  throw new Error(PROMPTFOO_INSTALL_HINT);
}
