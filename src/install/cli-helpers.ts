/**
 * Shared CLI helpers for `src/*` entry points.
 *
 * Each CLI module in this package (e.g. `build-skills.ts`, `skills-guard.ts`)
 * exposes a `main(argv, deps)` function that accepts the same set of
 * injectable side-effecting collaborators so tests can capture output
 * and suppress process exit. Keeping `MainDeps` and the default
 * resolver in one place means a future CLI module only needs to
 * `import { MainDeps, resolveMainDeps } from './cli-helpers.js'`
 * instead of reinventing the shape.
 */

/**
 * Injectable side-effecting collaborators for a CLI `main()` function.
 * Every field is optional — tests override what they care about and
 * let `resolveMainDeps` fill the rest with real `process` wiring.
 */
export interface MainDeps {
  cwd?: () => string;
  exit?: (code: number) => never;
  log?: (msg: string) => void;
  errLog?: (msg: string) => void;
}

/**
 * Same shape as `MainDeps` but with every field required. `main()`
 * callers should treat this as the post-defaults view of their deps
 * so the body never has to re-check for undefined.
 */
export interface ResolvedMainDeps {
  cwd: () => string;
  exit: (code: number) => never;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
}

/**
 * Fill in the real-process defaults for any `MainDeps` field that
 * the caller left undefined. The returned object is safe to mutate;
 * it shares no references with `deps`.
 */
export function resolveMainDeps(deps: MainDeps = {}): ResolvedMainDeps {
  return {
    cwd: deps.cwd ?? (() => process.cwd()),
    exit: deps.exit ?? ((code: number) => process.exit(code)),
    log: deps.log ?? ((msg: string) => console.log(msg)),
    errLog: deps.errLog ?? ((msg: string) => console.error(msg)),
  };
}
