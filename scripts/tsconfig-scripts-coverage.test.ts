// ─── The `scripts/` typecheck coverage guard (task 066, DR-24) ───────────────
//
// Both `scripts/` trees were compiled by NOTHING. `tsconfig.json` and
// `servers/exarchos-mcp/tsconfig.json` both `include: ["src/**/*"]`, so every
// guard living under either `scripts/` directory — including
// `cli-derivation-guard.ts`, `authority-live-proof.ts`, `cli-vocab-guard.ts` and
// `guard-inventory.ts`, which are the enforcement code most in need of it — was
// unchecked. Three separate tasks (020, 021, 026) each discovered this
// independently and each hand-ran a standalone `tsc --noEmit` over their own
// files. `tsconfig.scripts.json` (root) and `servers/exarchos-mcp/
// tsconfig.scripts.json` close it; `.github/workflows/ci.yml` runs both on the
// UNFILTERED `grep-gates` host.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE GUARDS, AND WHY A CI STEP ALONE IS NOT ENOUGH
//
// `tsc -p <config>` already fails on a config that resolves ZERO files (TS18003),
// so the empty-program case is fail-closed by the compiler. It does NOT fail on a
// config that resolves SOME files while having quietly stopped covering the
// guards it exists to cover — one `exclude` entry, or an `include` narrowed to a
// subdirectory, and the step still exits 0 over whatever is left. That is the
// program's R-11 in its subtler form: the mechanism runs, and covers less than
// its name claims.
//
// So the coverage floor is DATA ({@link REQUIRED_MEMBERS}) and the measurement is
// TypeScript's own config resolver (`ts.parseJsonConfigFileContent`) — the very
// function `tsc -p` uses to build its file list. Not a re-implemented glob, and
// not a text scan of the JSON: the property under test is "which files does this
// config actually resolve", and that is the property measured.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT EACH CONFIG INCLUDES AND EXCLUDES, AND WHY
//
// INCLUDED
//   • `scripts/**/*.ts` in both trees — every non-test TypeScript module under
//     each `scripts/` directory, including `scripts/audit/` and
//     `scripts/tsconfig-strictness/`. Nothing in either tree is carved out.
//   • Ambient `.d.ts` declarations from the sibling `src/` tree
//     (`servers/exarchos-mcp/src/**/*.d.ts` from the root config, `src/**/*.d.ts`
//     from the MCP config). Several scripts import `src/` modules, which drags
//     `src/storage/sqlite-backend.ts` and its `bun:sqlite` shim into the program;
//     without the shim the program fails on a module resolution that is not a
//     real defect. Only DECLARATIONS are included — every `src/*.ts` module in
//     these programs got there by being imported, never by a glob.
//
// EXCLUDED, deliberately
//   • `**/*.test.ts`. This is the repo-wide convention, already stated in BOTH
//     shipped tsconfigs; typechecking tests is a repo-wide policy change, not
//     this task's, and would be a much larger surface than the guards named
//     above. Recorded here so the exclusion is a decision rather than an
//     oversight.
//   • `**/*.bench.ts` and `**/__tests__/**` (MCP config) — carried over from the
//     tsconfig it extends, for the same reason.
//   • `.mjs` guards (`scripts/check-*.mjs`, `scripts/audit/*.mjs`,
//     `servers/exarchos-mcp/scripts/stryker-adapter.mjs`). They are not
//     TypeScript; `allowJs` would bring them in but would also bring in
//     everything else JavaScript in the tree, and checking untyped JS is a
//     different project from this one. Reported, not silently skipped: see
//     {@link UNCOVERED_BY_DESIGN}.
//   • `scripts/__fixtures__/**` matches nothing here — its contents are `.yml`
//     workflow fixtures, so the `*.ts` glob never reaches them. Named so a
//     future `.ts` fixture added there is a conscious choice.
//
// Implements: DR-24 (anti-inertness), DR-6 (the census guard it protects).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The two configs under test, and the tree each one governs. */
interface ScriptsProject {
  /** Repo-relative path of the tsconfig. */
  readonly config: string;
  /** Directory the config is resolved from (its own directory). */
  readonly base: string;
  /** Repo-relative prefix every covered file must sit under. */
  readonly tree: string;
}

const PROJECTS: readonly ScriptsProject[] = [
  { config: 'tsconfig.scripts.json', base: '.', tree: 'scripts' },
  {
    config: 'servers/exarchos-mcp/tsconfig.scripts.json',
    base: 'servers/exarchos-mcp',
    tree: 'servers/exarchos-mcp/scripts',
  },
];

/**
 * The coverage FLOOR, as data.
 *
 * Every entry is a guard whose absence from the typecheck is the defect this
 * task closes — the three the spec names by hand, plus the Wave-1 inventory and
 * the cast census that gate this program's other budgets. A narrowed `include`
 * or a new `exclude` that drops any of them fails here, even though `tsc` would
 * still exit 0 over the remainder.
 */
const REQUIRED_MEMBERS: readonly string[] = [
  // Named by the task: "exactly the enforcement code that most needs type checking".
  'servers/exarchos-mcp/scripts/cli-derivation-guard.ts',
  'servers/exarchos-mcp/scripts/authority-live-proof.ts',
  'servers/exarchos-mcp/scripts/cli-vocab-guard.ts',
  // The Wave-1 guard inventory (task 063) and the DR-14 cast census — both are
  // enforcement code, both live in a `scripts/` tree, neither was compiled.
  'scripts/guard-inventory.ts',
  'scripts/tsconfig-strictness/count-casts.ts',
  // `scripts/audit/` — the wave-S substrate. Every type error this task
  // surfaced was in here, so its continued coverage is the regression guard.
  'scripts/audit/cycle-gate.ts',
  'scripts/audit/knip-diff.ts',
  'scripts/audit/register-entry-schema.ts',
  'scripts/audit/check-base-substrate.ts',
];

/**
 * Guards in a `scripts/` tree that these configs do NOT cover, with the reason.
 *
 * Recorded rather than left implicit: "typechecked by nothing" was invisible for
 * three tasks precisely because nobody wrote down what was outside the net.
 */
const UNCOVERED_BY_DESIGN: Readonly<Record<string, string>> = {
  '.mjs guards': 'not TypeScript; `allowJs` would widen the program to all JS in the tree',
  '**/*.test.ts': 'repo-wide convention, already stated in both shipped tsconfigs',
};

/** Repo-relative, forward-slashed. */
const rel = (absolute: string): string =>
  relative(REPO_ROOT, absolute).split(sep).join('/');

/**
 * Resolve a config exactly as `tsc -p` does.
 *
 * @param overrides - merged over the parsed JSON before resolution, so a kill
 *   fixture can mutate `include`/`exclude` without a second config file on disk.
 */
function resolveProject(
  configPath: string,
  basePath: string,
  overrides: Record<string, unknown> = {},
): { readonly files: readonly string[]; readonly errors: readonly ts.Diagnostic[] } {
  const absolute = join(REPO_ROOT, configPath);
  const read = ts.readConfigFile(absolute, (p) => readFileSync(p, 'utf8'));
  expect(read.error).toBeUndefined();
  const json: unknown = read.config;
  if (typeof json !== 'object' || json === null) throw new Error(`${configPath} is not an object`);
  const parsed = ts.parseJsonConfigFileContent(
    { ...json, ...overrides },
    ts.sys,
    join(REPO_ROOT, basePath),
    undefined,
    absolute,
  );
  return { files: parsed.fileNames.map(rel), errors: parsed.errors };
}

/** TS18003 — "No inputs were found in config file". The empty-program diagnostic. */
const TS_NO_INPUTS = 18003;

describe('scripts/ typecheck coverage (task 066, DR-24)', () => {
  it('ScriptsTypecheck_BothTrees_ResolveANonEmptyFileSet', () => {
    // The non-empty denominator, on the half a green `tsc` cannot speak to: each
    // config resolves files, and every one of them is a real `.ts` under the
    // tree that config exists to cover.
    for (const project of PROJECTS) {
      const { files, errors } = resolveProject(project.config, project.base);
      expect(errors).toEqual([]);
      expect(files.length).toBeGreaterThan(0);

      const inTree = files.filter((f) => f.startsWith(`${project.tree}/`));
      expect(inTree.length).toBeGreaterThan(0);
      // Everything outside the tree is an ambient declaration pulled in on
      // purpose — never a stray implementation file the glob widened into.
      for (const file of files) {
        if (file.startsWith(`${project.tree}/`)) continue;
        expect(file.endsWith('.d.ts')).toBe(true);
      }
    }
  });

  it('ScriptsTypecheck_EveryNamedGuard_IsInTheResolvedProgram', () => {
    // The coverage floor. `tsc -p` exits 0 over a shrunken file set, so the
    // members are asserted rather than inferred from the step passing.
    const covered = new Set(
      PROJECTS.flatMap((project) => resolveProject(project.config, project.base).files),
    );
    expect(REQUIRED_MEMBERS.length).toBeGreaterThan(0);
    for (const member of REQUIRED_MEMBERS) expect([...covered]).toContain(member);

    // …and the deliberate exclusions really are excluded, so the recorded scope
    // is the measured scope in both directions.
    expect(Object.keys(UNCOVERED_BY_DESIGN).length).toBeGreaterThan(0);
    for (const file of covered) {
      expect(file.endsWith('.test.ts')).toBe(false);
      expect(file.endsWith('.mjs')).toBe(false);
    }
  });

  it('ScriptsTypecheck_EveryNonTestScript_IsCovered', () => {
    // The floor above is a hand-maintained list, so it can only ever go stale
    // downward. This asserts the whole population: every non-test `.ts` file the
    // compiler can see under each tree is in that tree's program. A new guard
    // dropped into `scripts/` is covered automatically, and an `exclude` that
    // carves one out fails here without anyone having to remember it.
    for (const project of PROJECTS) {
      const { files } = resolveProject(project.config, project.base);
      const covered = new Set(files);
      const present = ts.sys
        .readDirectory(join(REPO_ROOT, project.tree), ['.ts'], undefined, undefined)
        .map(rel)
        .filter((f) => !f.endsWith('.test.ts'));
      expect(present.length).toBeGreaterThan(0);
      for (const file of present) expect([...covered]).toContain(file);
    }
  });

  it('ScriptsTypecheck_ZeroFileConfig_FailsRatherThanPassingClean', () => {
    // THE KILL FIXTURE. A typecheck that resolves nothing must fail, not pass
    // green over an empty program — the `EMPTY_SEAM_DENOMINATOR` posture, one
    // layer down in the toolchain.
    //
    // Proved against the SHIPPED configs with only `include` neutralised, so the
    // fixture cannot drift from the thing under test. The compiler's own
    // resolver reports TS18003, which is what makes `tsc -p` exit non-zero.
    for (const project of PROJECTS) {
      const emptied = resolveProject(project.config, project.base, {
        include: ['scripts/**/*.no-such-extension'],
      });
      expect(emptied.files).toEqual([]);
      expect(emptied.errors.map((e) => e.code)).toContain(TS_NO_INPUTS);
    }

    // CONTROL: the same resolver over the unmodified configs reports no such
    // error — so the failure above is attributable to the emptied glob and not
    // to the harness always producing one.
    for (const project of PROJECTS) {
      const real = resolveProject(project.config, project.base);
      expect(real.errors.map((e) => e.code)).not.toContain(TS_NO_INPUTS);
    }
  });

  it('ScriptsTypecheck_BothConfigs_InheritTheStrictFlagsTheyClaim', () => {
    // A scripts typecheck that silently ran without the project's strict flags
    // would be the same class of defect as no typecheck at all: green, and about
    // a weaker property than its name says. The flags are read off the RESOLVED
    // options (post-`extends`), not off the file's own text.
    for (const project of PROJECTS) {
      const absolute = join(REPO_ROOT, project.config);
      const read = ts.readConfigFile(absolute, (p) => readFileSync(p, 'utf8'));
      const json: unknown = read.config;
      if (typeof json !== 'object' || json === null) throw new Error('unreadable config');
      const parsed = ts.parseJsonConfigFileContent(
        json,
        ts.sys,
        join(REPO_ROOT, project.base),
        undefined,
        absolute,
      );
      expect(parsed.options.strict).toBe(true);
      expect(parsed.options.noUncheckedIndexedAccess).toBe(true);
      expect(parsed.options.exactOptionalPropertyTypes).toBe(true);
      expect(parsed.options.noEmit).toBe(true);
    }
  });
});
