import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectToolchain,
  toolchainFromConfig,
  testFailureExitCodesFor,
  BUILTIN_TOOLCHAINS,
  DEFAULT_TEST_FAILURE_EXIT_CODES,
  classifyHermeticDependency,
  resolveHermeticDouble,
  type Toolchain,
  type HermeticDependencyClass,
} from '../../../src/config/toolchains.js';
import { ExarchosConfigSchema } from '../../../src/config/exarchos-config-schema.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'toolchains-'));
});
afterEach(() => {
  rmrf(dir);
});

function touch(name: string): void {
  writeFileSync(join(dir, name), '', 'utf8');
}

describe('detectToolchain — ecosystem markers', () => {
  it.each([
    ['package.json', 'node', 'Node.js'],
    ['Cargo.toml', 'rust', 'Rust'],
    ['go.mod', 'go', 'Go'],
    ['pyproject.toml', 'python', 'Python'],
    ['requirements.txt', 'python', 'Python'],
    ['setup.py', 'python', 'Python'],
    ['tox.ini', 'python', 'Python'],
    ['pom.xml', 'java-maven', 'Java'],
    ['build.gradle', 'java-gradle', 'Java'],
    ['build.gradle.kts', 'java-gradle', 'Java'],
    ['Gemfile', 'ruby', 'Ruby'],
    ['composer.json', 'php', 'PHP'],
    ['mix.exs', 'elixir', 'Elixir'],
    ['Package.swift', 'swift', 'Swift'],
    ['CMakeLists.txt', 'cmake', 'C/C++'],
  ])('detects %s → %s (%s)', (marker, id, projectType) => {
    touch(marker);
    const tc = detectToolchain(dir);
    expect(tc?.id).toBe(id);
    expect(tc?.projectType).toBe(projectType);
  });
});

describe('detectToolchain — .NET solution formats (#1507)', () => {
  it.each(['App.csproj', 'App.sln', 'App.slnx'])(
    'detects %s as .NET',
    (file) => {
      touch(file);
      const tc = detectToolchain(dir);
      expect(tc?.id).toBe('dotnet');
      expect(tc?.projectType).toBe('.NET');
      expect(tc?.commands.test).toBe('dotnet test');
    },
  );

  it('detects a .slnx-only root (the modern default format) — regression for #1507', () => {
    touch('Dynatoi.slnx');
    expect(detectToolchain(dir)?.id).toBe('dotnet');
  });
});

describe('detectToolchain — priority & misses', () => {
  it('prefers node when package.json coexists with another marker', () => {
    touch('package.json');
    touch('Cargo.toml');
    expect(detectToolchain(dir)?.id).toBe('node');
  });

  it('returns undefined when no marker is present', () => {
    expect(detectToolchain(dir)).toBeUndefined();
  });

  it('returns undefined for an unreadable / nonexistent directory', () => {
    expect(detectToolchain(join(dir, 'does-not-exist'))).toBeUndefined();
  });

  it('matches an extension glob only on the right extension', () => {
    touch('notes.slnxx');
    expect(detectToolchain(dir)).toBeUndefined();
  });
});

describe('detectToolchain — user extra entries (tier 3 override)', () => {
  const zig: Toolchain = {
    id: 'zig',
    projectType: 'Zig',
    markers: ['build.zig'],
    commands: { test: 'zig build test', typecheck: null, install: null, mutation: null, lint: null, contract: null },
  };

  it('detects a user-declared toolchain with zero built-in support', () => {
    touch('build.zig');
    expect(detectToolchain(dir, [zig])?.id).toBe('zig');
  });

  it('lets a user entry win over a built-in for the same marker', () => {
    touch('package.json');
    const customNode: Toolchain = {
      id: 'node-custom',
      projectType: 'Node.js',
      markers: ['package.json'],
      commands: { test: 'just test', typecheck: null, install: null, mutation: null, lint: null, contract: null },
    };
    expect(detectToolchain(dir, [customNode])?.id).toBe('node-custom');
  });
});

describe('toolchainFromConfig — .exarchos.yml toolchains: → registry', () => {
  it('maps id/markers/commands and defaults projectType to the id', () => {
    const tc = toolchainFromConfig({
      id: 'zig',
      markers: ['build.zig'],
      commands: { test: 'zig build test' },
    });
    expect(tc).toEqual({
      id: 'zig',
      projectType: 'zig',
      markers: ['build.zig'],
      commands: {
        test: 'zig build test',
        typecheck: null,
        install: null,
        mutation: null,
        lint: null,
        contract: null,
      },
    });
  });

  it('honors an explicit projectType and fills absent commands with null', () => {
    const tc = toolchainFromConfig({
      id: 'hs',
      projectType: 'Haskell',
      markers: ['*.cabal'],
      commands: { test: 'cabal test', install: 'cabal build' },
    });
    expect(tc.projectType).toBe('Haskell');
    expect(tc.commands).toEqual({
      test: 'cabal test',
      typecheck: null,
      install: 'cabal build',
      mutation: null,
      lint: null,
      contract: null,
    });
  });

  it('a converted entry detects via detectToolchain extra', () => {
    touch('build.zig');
    const zig = toolchainFromConfig({ id: 'zig', markers: ['build.zig'], commands: { test: 'zig build test' } });
    expect(detectToolchain(dir, [zig])?.id).toBe('zig');
  });
});

describe('BUILTIN_TOOLCHAINS — registry integrity', () => {
  it('has unique ids', () => {
    const ids = BUILTIN_TOOLCHAINS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every toolchain declares at least one marker and a test command', () => {
    for (const tc of BUILTIN_TOOLCHAINS) {
      expect(tc.markers.length).toBeGreaterThan(0);
      expect(tc.commands.test).toBeTruthy();
    }
  });

  it('dotnet recognizes all three solution formats', () => {
    const dotnet = BUILTIN_TOOLCHAINS.find((t) => t.id === 'dotnet');
    expect(dotnet?.markers).toEqual(
      expect.arrayContaining(['*.csproj', '*.sln', '*.slnx']),
    );
  });
});

/**
 * The red exit codes of each built-in toolchain. Each description says where its codes come from: a measured run, the documentation or the source.
 * A row with no description holds the default, and no run measured it.
 */
const RED_EXIT_CODES_BY_TOOLCHAIN: Readonly<Record<string, readonly number[]>> = {
  /** Measured: a failing test and a test file that does not import both exit 1, in vitest and in `node --test`. */
  node: [1],
  /** Measured: a build error and a failing VSTest test exit 1. A failing Microsoft.Testing.Platform test exits 2. */
  dotnet: [1, 2],
  /** Measured: a failing test and a compile error of the reverted source both exit 101. */
  rust: [101],
  /** Measured: a failing test and a build error of the reverted source both exit 1. */
  go: [1],
  /** Measured: a failing test exits 1, and a test module that does not import exits 2. */
  python: [1, 2],
  'java-gradle': [1],
  'java-maven': [1],
  ruby: [1],
  /** From the source of PHPUnit and Composer: a failing test exits 1, a test error exits 2, and Composer passes the code through. */
  php: [1, 2],
  /** From the documentation of `mix test`: a failing test exits 2 by default, and a compile error exits 1. */
  elixir: [1, 2],
  swift: [1],
  /** Measured: a failing test and a test that does not run both exit 8. */
  cmake: [8],
};

/**
 * The kill probe reads exit 0 as green, these exit codes as red, and every other exit as a run with no verdict.
 * A runner whose failure code is not 1 needs its own row, or each honest kill gives no verdict and blocks.
 */
describe('testFailureExitCodesFor — the red exit codes of a test run', () => {
  /** The denominator: the table holds each built-in toolchain once, so a new toolchain without a row fails here. */
  it('TestFailureExitCodes_Table_HoldsEachBuiltinOnce', () => {
    const ids = BUILTIN_TOOLCHAINS.map((t) => t.id);

    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => RED_EXIT_CODES_BY_TOOLCHAIN[id] === undefined)).toEqual([]);
    expect(Object.keys(RED_EXIT_CODES_BY_TOOLCHAIN).filter((id) => !ids.includes(id))).toEqual([]);
  });

  for (const toolchain of BUILTIN_TOOLCHAINS) {
    it(`TestFailureExitCodes_${toolchain.id}_IsTheCodesOfItsRunner`, () => {
      expect(testFailureExitCodesFor(toolchain)).toEqual(RED_EXIT_CODES_BY_TOOLCHAIN[toolchain.id]);
    });
  }

  it('TestFailureExitCodes_Default_IsExit1', () => {
    expect(DEFAULT_TEST_FAILURE_EXIT_CODES).toEqual([1]);
  });

  it('TestFailureExitCodes_NoToolchain_IsTheDefault', () => {
    expect(testFailureExitCodesFor(undefined)).toEqual([1]);
  });

  /** The codes are not a config key: a user toolchain carries none, and the strict schema refuses the key. */
  it('TestFailureExitCodes_UserToolchain_HasNoConfigKey', () => {
    const entry = { id: 'rust-ws', markers: ['Cargo.toml'], commands: { test: 'cargo test --workspace' } };

    expect(testFailureExitCodesFor(toolchainFromConfig(entry))).toEqual([1]);
    expect(ExarchosConfigSchema.safeParse({ toolchains: [entry] }).success).toBe(true);
    expect(ExarchosConfigSchema.safeParse({ toolchains: [{ ...entry, testFailureExitCodes: [101] }] }).success).toBe(false);
  });
});

describe('BUILTIN_TOOLCHAINS — verification command seeds (task 016)', () => {
  function commandsFor(id: string): Toolchain['commands'] {
    const tc = BUILTIN_TOOLCHAINS.find((t) => t.id === id);
    if (!tc) throw new Error(`no built-in toolchain '${id}'`);
    return tc.commands;
  }

  it('BuiltinToolchains_Node_SeedsStrykerMutation', () => {
    expect(commandsFor('node').mutation).toBe('npx stryker run');
  });

  it('BuiltinToolchains_Dotnet_SeedsDotnetStryker', () => {
    expect(commandsFor('dotnet').mutation).toBe('dotnet stryker');
  });

  it('BuiltinToolchains_Rust_SeedsCargoMutants', () => {
    expect(commandsFor('rust').mutation).toBe('cargo mutants --in-diff');
  });

  it('BuiltinToolchains_Python_SeedsMutmut', () => {
    expect(commandsFor('python').mutation).toBe('mutmut run');
  });

  it('BuiltinToolchains_JavaMaven_SeedsPitest', () => {
    expect(commandsFor('java-maven').mutation).toBe(
      'mvn org.pitest:pitest-maven:mutationCoverage',
    );
  });

  /**
   * The contract field is `{ codegen, diff } | null`. A built-in toolchain seeds null, because
   * contracts are keyed on schema artifacts, not on the language.
   * A toolchain that seeds a structured value must carry both keys.
   */
  it('ToolchainCommands_ContractField_DefaultsNullStructured', () => {
    for (const tc of BUILTIN_TOOLCHAINS) {
      const contract = tc.commands.contract;
      if (contract !== null) {
        expect('codegen' in contract).toBe(true);
        expect('diff' in contract).toBe(true);
      } else {
        expect(contract).toBeNull();
      }
    }
    expect(commandsFor('node').contract).toBeNull();
  });

  /**
   * A toolchain seeds a lint command only when its ecosystem has one conventional command.
   * Node lint is a project script, so node seeds null.
   */
  it('ToolchainCommands_LintField_Seeded', () => {
    expect(commandsFor('rust').lint).toBe('cargo clippy');
    expect(commandsFor('go').lint).toBe('go vet ./...');
    expect(commandsFor('python').lint).toBe('ruff check');
    expect(commandsFor('node').lint).toBeNull();
  });

  it('every toolchain exposes the widened readonly null-able command fields', () => {
    for (const tc of BUILTIN_TOOLCHAINS) {
      expect('mutation' in tc.commands).toBe(true);
      expect('lint' in tc.commands).toBe(true);
      expect('contract' in tc.commands).toBe(true);
    }
  });
});

describe('hermetic-double resolution (SIV-5 #1531)', () => {
  /** A container-backed double never runs in the inner loop. */
  it('Hermetic_DatabaseDependency_ResolvesTestcontainersReal', () => {
    expect(classifyHermeticDependency('pg')).toBe('database');
    expect(classifyHermeticDependency('mongoose')).toBe('database');
    const d = resolveHermeticDouble('database');
    expect(d.double).toMatch(/Testcontainers/i);
    expect(d.fidelity).toBe('real');
    expect(d.cadence).toBe('boundary-offline');
  });

  /** The emulator is a fake of the cloud, and the descriptor must say so. */
  it('Hermetic_CloudApiDependency_ResolvesLocalStackWithFakeCaveat', () => {
    expect(classifyHermeticDependency('@aws-sdk/client-s3')).toBe('cloud-api');
    expect(classifyHermeticDependency('aws-sdk')).toBe('cloud-api');
    const d = resolveHermeticDouble('cloud-api');
    expect(d.double).toMatch(/LocalStack/i);
    expect(d.fidelity).toBe('fake');
    expect(d.caveat ?? '').toMatch(/fake of the cloud/i);
  });

  /** A subpath specifier such as `axios/dist` must classify like the bare package name. */
  it('Hermetic_ThirdPartyHttp_ResolvesPactStubInnerLoop', () => {
    expect(classifyHermeticDependency('axios')).toBe('third-party-http');
    expect(classifyHermeticDependency('got')).toBe('third-party-http');
    expect(classifyHermeticDependency('axios/dist/node/axios.cjs')).toBe('third-party-http');
    expect(classifyHermeticDependency('undici/lib/api')).toBe('third-party-http');
    const d = resolveHermeticDouble('third-party-http');
    expect(d.double).toMatch(/Pact-verified contract stub/i);
    expect(d.fidelity).toBe('stub');
    expect(d.cadence).toBe('inner-loop');
  });

  /** The classifier, not only `resolveHermeticDouble`, must reach the class from real package specifiers. */
  it('Hermetic_MessageBrokerDependency_ClassifiesAsMessageBroker', () => {
    expect(classifyHermeticDependency('kafkajs')).toBe('message-broker');
    expect(classifyHermeticDependency('amqplib')).toBe('message-broker');
    const d = resolveHermeticDouble('message-broker');
    expect(d.depClass).toBe('message-broker');
  });

  /** An unrecognized specifier gives null, not a wrong class. */
  it('Hermetic_UnknownDependency_StaysUnclassified', () => {
    expect(classifyHermeticDependency('some-obscure-pkg')).toBeNull();
    expect(classifyHermeticDependency('@scope/internal-thing')).toBeNull();
  });

  /** Each class resolves to a full descriptor, not to a bare command string. */
  it('Hermetic_Resolution_IsInspectableDescriptorNotBakedLiteral', () => {
    const classes: readonly HermeticDependencyClass[] = [
      'database',
      'cloud-api',
      'message-broker',
      'third-party-http',
      'owned-interface',
    ];
    for (const c of classes) {
      const d = resolveHermeticDouble(c);
      expect(d.depClass).toBe(c);
      expect(typeof d.double).toBe('string');
      expect(d.double.length).toBeGreaterThan(0);
      expect(['real', 'fake', 'stub']).toContain(d.fidelity);
      expect(['inner-loop', 'boundary-offline']).toContain(d.cadence);
    }
  });
});
