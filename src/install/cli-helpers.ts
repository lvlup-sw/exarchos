/**
 * Shared helpers for the CLI entry points of this package.
 * A CLI module, for example `build-skills.ts`, exposes `main(argv, deps)` with these injectable collaborators.
 * Tests use them to capture output and to stop the process exit.
 */

/** Injectable side-effecting collaborators for a CLI `main()` function. `resolveMainDeps` fills each missing field with a real `process` function. */
export interface MainDeps {
  cwd?: () => string;
  exit?: (code: number) => never;
  log?: (msg: string) => void;
  errLog?: (msg: string) => void;
}

/** `MainDeps` with each field required, after the defaults are applied. */
export interface ResolvedMainDeps {
  cwd: () => string;
  exit: (code: number) => never;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
}

/** Fill each undefined `MainDeps` field with its real-process default. The result is a new object, so a change to it does not change `deps`. */
export function resolveMainDeps(deps: MainDeps = {}): ResolvedMainDeps {
  return {
    cwd: deps.cwd ?? (() => process.cwd()),
    exit: deps.exit ?? ((code: number) => process.exit(code)),
    log: deps.log ?? ((msg: string) => console.log(msg)),
    errLog: deps.errLog ?? ((msg: string) => console.error(msg)),
  };
}
