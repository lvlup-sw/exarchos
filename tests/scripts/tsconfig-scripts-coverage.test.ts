// Coverage guard for the `tsconfig.scripts.json` typecheck.
//
// Root `tsconfig.json` includes only `src`, so `tsconfig.scripts.json` typechecks the
// guards under `tools/audit` and `tools/release`. The `grep-gates` job of
// `.github/workflows/ci.yml` runs `tsc -p tsconfig.scripts.json` and this test.
//
// `tsc -p` fails on a config that resolves zero files (TS18003). It exits 0 on a config
// that resolves some files but does not cover the guards. Thus the coverage floor is
// data (`REQUIRED_MEMBERS`). The tests measure with `ts.parseJsonConfigFileContent`, the
// resolver that `tsc -p` uses, and not with a hand-written glob or a scan of the JSON text.
//
// The config includes each non-test `.ts` file in the two trees, fixtures included, and
// the ambient `.d.ts` files of `src`. Some guards import `src` modules that need the
// `bun:sqlite` shim. A `src` implementation file must enter the program through an
// import, not through a glob. The config excludes `*.test.ts` files by repository
// convention. It does not include `.mjs` guards, because `allowJs` adds all JavaScript
// in the trees.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A config under test and the trees that it covers. */
interface ScriptsProject {
  /** Repo-relative path of the tsconfig. */
  readonly config: string;
  /** Directory the config is resolved from (its own directory). */
  readonly base: string;
  /**
   * Repo-relative prefixes of the covered trees: `tools/audit` (measurement and gates) and
   * `tools/release` (build and publish). Each tree has its own checks, so a config that
   * covers only one tree fails.
   */
  readonly trees: readonly string[];
}

/** The configs under test. One tsconfig covers the two trees. */
const PROJECTS: readonly ScriptsProject[] = [
  { config: 'tsconfig.scripts.json', base: '.', trees: ['tools/audit', 'tools/release'] },
];

/**
 * The coverage floor, as data. Each entry is a guard that the typecheck must cover. An
 * `include` or `exclude` change that drops an entry fails here, although `tsc` still
 * exits 0 over the remaining files.
 */
const REQUIRED_MEMBERS: readonly string[] = [
  'tools/audit/core/cli-derivation-guard.ts',
  'tools/audit/core/authority-live-proof.ts',
  'tools/audit/core/cli-vocab-guard.ts',
  'tools/audit/gates/guard-inventory.ts',
  'tools/audit/tsconfig-strictness/count-casts.ts',
  'tools/audit/cycle-gate.ts',
  'tools/audit/knip-diff.ts',
  'tools/audit/register-entry-schema.ts',
  'tools/audit/check-base-substrate.ts',
];

/** The file classes that the config does not cover, with the reason for each. */
const UNCOVERED_BY_DESIGN: Readonly<Record<string, string>> = {
  '.mjs guards': 'not TypeScript; `allowJs` would widen the program to all JS in the tree',
  '**/*.test.ts': 'repo-wide convention, already stated in both shipped tsconfigs',
};

/** Repo-relative, forward-slashed. */
const rel = (absolute: string): string =>
  relative(REPO_ROOT, absolute).split(sep).join('/');

/**
 * Resolves a config as `tsc -p` does.
 *
 * @param overrides - Merged over the parsed JSON before resolution, so a kill fixture can
 *   change `include` or `exclude` with no second config file.
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
  /**
   * Each config resolves files, and each tree has its own count. A check of only the total
   * lets one tree become empty. A file outside the trees must be an ambient `.d.ts`
   * declaration, not an implementation file that a wider glob added.
   */
  it('ScriptsTypecheck_BothTrees_ResolveANonEmptyFileSet', () => {
    for (const project of PROJECTS) {
      const { files, errors } = resolveProject(project.config, project.base);
      expect(errors).toEqual([]);
      expect(files.length).toBeGreaterThan(0);

      for (const tree of project.trees) {
        const inTree = files.filter((f) => f.startsWith(`${tree}/`));
        expect(inTree.length, `${project.config} resolves nothing under ${tree}/`).toBeGreaterThan(
          0,
        );
      }
      for (const file of files) {
        if (project.trees.some((t) => file.startsWith(`${t}/`))) continue;
        expect(file.endsWith('.d.ts')).toBe(true);
      }
    }
  });

  /**
   * `tsc -p` exits 0 over a smaller file set, so the test asserts each required member.
   * It also asserts that no covered file is a test file or an `.mjs` file.
   */
  it('ScriptsTypecheck_EveryNamedGuard_IsInTheResolvedProgram', () => {
    const covered = new Set(
      PROJECTS.flatMap((project) => resolveProject(project.config, project.base).files),
    );
    expect(REQUIRED_MEMBERS.length).toBeGreaterThan(0);
    for (const member of REQUIRED_MEMBERS) expect([...covered]).toContain(member);

    expect(Object.keys(UNCOVERED_BY_DESIGN).length).toBeGreaterThan(0);
    for (const file of covered) {
      expect(file.endsWith('.test.ts')).toBe(false);
      expect(file.endsWith('.mjs')).toBe(false);
    }
  });

  /**
   * `REQUIRED_MEMBERS` is a manual list and can go stale. This test covers the full
   * population: each non-test `.ts` file under a tree must be in the program. Thus a new
   * guard needs no list entry, and an `exclude` that drops a file fails here.
   */
  it('ScriptsTypecheck_EveryNonTestScript_IsCovered', () => {
    for (const project of PROJECTS) {
      const { files } = resolveProject(project.config, project.base);
      const covered = new Set(files);
      for (const tree of project.trees) {
        const present = ts.sys
          .readDirectory(join(REPO_ROOT, tree), ['.ts'], undefined, undefined)
          .map(rel)
          .filter((f) => !f.endsWith('.test.ts'));
        expect(present.length, `${tree}/ holds no non-test .ts to cover`).toBeGreaterThan(0);
        for (const file of present) expect([...covered]).toContain(file);
      }
    }
  });

  /**
   * A typecheck that resolves no files must fail. The test uses the shipped configs with
   * only `include` replaced, so the fixture cannot drift from them. The resolver then
   * reports TS18003, which makes `tsc -p` exit non-zero. As a control, the unchanged
   * configs do not report TS18003.
   */
  it('ScriptsTypecheck_ZeroFileConfig_FailsRatherThanPassingClean', () => {
    for (const project of PROJECTS) {
      const emptied = resolveProject(project.config, project.base, {
        include: project.trees.map((t) => `${t}/**/*.no-such-extension`),
      });
      expect(emptied.files).toEqual([]);
      expect(emptied.errors.map((e) => e.code)).toContain(TS_NO_INPUTS);
    }

    for (const project of PROJECTS) {
      const real = resolveProject(project.config, project.base);
      expect(real.errors.map((e) => e.code)).not.toContain(TS_NO_INPUTS);
    }
  });

  /**
   * A typecheck without the strict flags of the project passes on a weaker property than
   * its name states. The test reads the flags from the resolved options, after `extends`.
   */
  it('ScriptsTypecheck_BothConfigs_InheritTheStrictFlagsTheyClaim', () => {
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
