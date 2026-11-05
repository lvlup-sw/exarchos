/**
 * The mutation tables live in the toolchain registry. For each built-in toolchain with a mutation runner, they give
 * the files and the config that the mutation gate read before the move. The values of each table are the values of the gate.
 *
 * @oracle-sources: ../../../src/config/toolchains.ts, the tables of the mutation gate at the base commit written here as literals
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BUILTIN_TOOLCHAINS,
  changedJavaClasses,
  changedPythonPaths,
  COMMAND_PATH_EXTENSIONS,
  MUTATABLE_EXTENSIONS,
  MUTATION_CONFIG_FILE_PATTERNS,
  MUTATION_CONFIG_SECTION_MARKERS,
  NON_MUTATABLE_MARKERS,
  NON_SCANNABLE_DIRS,
} from '../../../src/config/toolchains.js';
import { discoverMutationConfig, mutatableChangedFiles } from '../../../src/verbs/gates/mutation-adequacy.js';

/** The root of the listing that the discovery seam gives. */
const ROOT = '/repo';

/** The pattern with which the gate found a path token with no directory part, before the move. */
const GATE_COMMAND_PATH_PATTERN = /\.[cm]?[jt]sx?$|\.(sh|py|rb|php)$/i;

/** One mutation runner of the registry: a changed source file, whether the runner mutates it, and the config that discovery finds. */
interface RunnerTarget {
  readonly toolchain: string;
  readonly source: string;
  readonly mutatable: boolean;
  readonly config?: { readonly name: string; readonly head: string };
}

/** The targets of each built-in toolchain whose row names a mutation runner, as the gate read them before the move. */
const TARGETS: readonly RunnerTarget[] = [
  { toolchain: 'node', source: 'src/app.ts', mutatable: true, config: { name: 'stryker.config.mjs', head: '' } },
  { toolchain: 'dotnet', source: 'src/App/Service.cs', mutatable: true, config: { name: 'stryker-config.json', head: '' } },
  { toolchain: 'rust', source: 'src/lib.rs', mutatable: true, config: { name: 'mutants.toml', head: '' } },
  { toolchain: 'python', source: 'pkg/service.py', mutatable: true, config: { name: 'pyproject.toml', head: '[tool.mutmut]\npaths_to_mutate = "pkg"\n' } },
  { toolchain: 'java-gradle', source: 'src/main/java/com/acme/Service.java', mutatable: true, config: { name: 'build.gradle', head: "plugins { id 'info.solidsoft.pitest' }\n" } },
  { toolchain: 'java-maven', source: 'src/main/java/com/acme/Service.java', mutatable: true, config: { name: 'pom.xml', head: '<artifactId>pitest-maven</artifactId>\n' } },
  { toolchain: 'ruby', source: 'lib/service.rb', mutatable: false, config: { name: '.mutant.yml', head: '' } },
  { toolchain: 'php', source: 'src/Service.php', mutatable: false, config: { name: 'infection.json5', head: '' } },
  { toolchain: 'elixir', source: 'lib/service.ex', mutatable: false },
];

/** Command tokens with no directory part, in both cases, that the path-token pattern reads or refuses. */
const COMMAND_TOKENS: readonly string[] = [
  'run.js', 'run.JSX', 'run.ts', 'run.tsx', 'run.cjs', 'run.mjs', 'run.cts', 'run.MTS', 'run.cjsx', 'run.mtsx',
  'run.sh', 'run.PY', 'run.rb', 'run.php', 'stryker.conf.mjs',
  'run.json', 'run.md', 'run.java', 'run.go', 'run.jsxx', 'run.pyc', 'Makefile', 'run',
];

/** Discovers the config of a runner over a listing of the root that holds only that config file. */
function discoverOnly(config: { readonly name: string; readonly head: string } | undefined): ReturnType<typeof discoverMutationConfig> {
  return discoverMutationConfig(ROOT, {
    readDir: (dir) => (dir === ROOT && config !== undefined ? [{ name: config.name, isDirectory: false }] : []),
    readFileHead: () => config?.head ?? '',
  });
}

describe('the mutation tables of the registry', () => {
  /**
   * Each toolchain with a mutation runner has a target, and the gate reads its source and its config through the moved tables.
   * The killing assertions are the values of the moved tables, which the registry did not export before the move.
   */
  it('MutationTargets_EachToolchain_GivesTheTablesThatTheGateUsed', () => {
    const runners = BUILTIN_TOOLCHAINS.filter((toolchain) => toolchain.commands.mutation !== null).map((toolchain) => toolchain.id);

    expect([...runners].sort()).toEqual(TARGETS.map((target) => target.toolchain).sort());
    for (const target of TARGETS) {
      const discovery = discoverOnly(target.config);
      expect(mutatableChangedFiles([target.source, `tests/${target.source}.test.ts`]), target.toolchain).toEqual(target.mutatable ? [target.source] : []);
      if (target.config === undefined) {
        expect(discovery.ok, target.toolchain).toBe(false);
      } else {
        const configPath = path.join(ROOT, target.config.name);
        expect(discovery, target.toolchain).toEqual({ ok: true, configPath, packageDir: path.dirname(configPath) });
      }
    }

    expect(MUTATABLE_EXTENSIONS).toEqual(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.java', '.py', '.rs', '.cs', '.go', '.kt']);
    expect(NON_MUTATABLE_MARKERS).toEqual(['.test.', '.spec.', '/__tests__/', '/__mocks__/', '/__fixtures__/', '/fixtures/', '/node_modules/', '/dist/']);
    expect(MUTATION_CONFIG_FILE_PATTERNS).toEqual([
      /^\.?stryker\.conf(ig)?\.(mjs|cjs|js|json|jsonc)$/i,
      /^stryker-config\.(json|ya?ml)$/i,
      /^infection\.json5?(\.dist)?$/i,
      /^\.?mutant\.ya?ml$/i,
      /^\.?(cargo-)?mutants\.toml$/i,
    ]);
    expect(MUTATION_CONFIG_SECTION_MARKERS).toEqual([
      { basename: 'pyproject.toml', marker: /^\s*\[tool\.mutmut\]/m },
      { basename: 'setup.cfg', marker: /^\s*\[mutmut\]/m },
      { basename: 'pom.xml', marker: /pitest/i },
      { basename: 'build.gradle', marker: /pitest/i },
      { basename: 'build.gradle.kts', marker: /pitest/i },
    ]);
    expect([...NON_SCANNABLE_DIRS]).toEqual(['node_modules', 'dist', 'build', 'out', 'coverage', 'reports', 'target', 'vendor', 'tmp']);
    expect(changedJavaClasses(['src/main/java/com/acme/A.java', 'lib\\B.java', 'src/test/java/com/acme/ATest.java', 'a.py', 'src/main/java/com/acme/A.java'])).toEqual([
      'com.acme.A',
      'lib.B',
      'com.acme.ATest',
    ]);
    expect(changedPythonPaths(['pkg\\mod.py', 'a.ts', 'pkg/mod.py', 'tests/test_mod.py'])).toEqual(['pkg/mod.py', 'tests/test_mod.py']);
    for (const token of COMMAND_TOKENS) {
      const fromList = COMMAND_PATH_EXTENSIONS.some((extension) => token.toLowerCase().endsWith(extension));
      expect(fromList, token).toBe(GATE_COMMAND_PATH_PATTERN.test(token));
    }
    expect(COMMAND_TOKENS.filter((token) => GATE_COMMAND_PATH_PATTERN.test(token))).toHaveLength(15);
  });
});
