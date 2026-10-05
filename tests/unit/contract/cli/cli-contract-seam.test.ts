import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SRC_ROOT as SHIPPED_SRC_ROOT,
  parseEmitBoundary,
  resolveEmitBoundary,
  deriveCliSurface,
  serializeCliSurface,
  serializedCliSurfaceBaseline,
  compileForCli,
  CLI_SURFACE_FILE,
  CLI_ACTION_IDS_FILE,
  renderCliActionIdsModule,
  scanDispatchSites,
  importsRuntimeDispatchValue,
  stripComments,
  runDispatchSeamCensus,
  AUTHORIZED_DISPATCH_PROJECTIONS,
  deriveCliClassification,
  runCliClassificationCensus,
  runCliContractCensus,
  auditCliContract,
  collectLiveCliCommands,
  HOST_LOCAL_COMMANDS,
  PRESENTATION_ALIASES,
  type CliClassification,
} from '../../../../src/contract/cli/cli-contract-seam.js';
import { exitCodeForError, STABLE_ERROR_REGISTRY, CONTRACT_EXIT_CODES } from '../../../../src/contract/error-families.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

describe('CLI-surface generation', () => {
  /** If the checked-in golden differs from a fresh derivation, the golden drifted from the compiled contract. */
  it('CheckedInGolden_MatchesFreshDerivation_ByteForByte', () => {
    const onDisk = readFileSync(CLI_SURFACE_FILE, 'utf8');
    expect(onDisk).toBe(serializedCliSurfaceBaseline());
  });

  /**
   * The addressing module holds the static id set that the generated client dispatches from.
   * If it drifts, the shipped binary addresses a surface that the contract does not compile.
   */
  it('CheckedInAddressingModule_MatchesFreshDerivation_ByteForByte', () => {
    const onDisk = readFileSync(CLI_ACTION_IDS_FILE, 'utf8');
    expect(onDisk).toBe(renderCliActionIdsModule(deriveCliSurface(compileForCli())));
  });

  /** Two independent compiles give the same bytes: no clock, locale or order reaches the output. */
  it('Derivation_IsDeterministic_AcrossRepeatedCompiles', () => {
    const first = serializeCliSurface(deriveCliSurface(compileForCli()));
    const second = serializeCliSurface(deriveCliSurface(compileForCli()));
    expect(first).toBe(second);
  });

  it('Surface_ProjectsEveryCompiledDescriptor', () => {
    const contract = compileForCli();
    const surface = deriveCliSurface(contract);
    expect(surface.commands.length).toBe(contract.descriptors.length);
    expect(surface.commands.length).toBeGreaterThan(0);
  });

  /** Each exit code in the generated surface comes from the contract authority. The CLI defines no exit code. */
  it('EveryExitMapping_DerivesFromContractAuthority', () => {
    const surface = deriveCliSurface(compileForCli());
    for (const command of surface.commands) {
      expect(command.successExitCode).toBe(CONTRACT_EXIT_CODES.SUCCESS);
      for (const mapping of command.errorExits) {
        expect(mapping.exitCode).toBe(exitCodeForError(mapping.code));
      }
    }
  });
});

describe('Dispatch-seam containment census', () => {
  /**
   * The direct-dispatch paths of the live tree are exactly the authorized projections: the MCP wire and the generated CLI client.
   * The deviation ledger is empty, so a new bypass in shipped source fails this test.
   */
  it('LiveTree_OnlyAuthorizedProjectionsImportTheDispatchValue', async () => {
    const sites = await scanDispatchSites();
    expect(sites.map((s) => s.module)).toEqual([...AUTHORIZED_DISPATCH_PROJECTIONS].sort());
  });

  it('LiveTree_PassesTheSeamCensus', async () => {
    const sites = await scanDispatchSites();
    expect(runDispatchSeamCensus(sites)).toEqual([]);
  });

  /**
   * The build compiles `evals`, `benchmarks` and `test-helpers` into `dist/`, because `tsconfig.json` does not exclude them.
   * A scan that skips directories by name hides a direct dispatch path in those modules.
   * Each case plants a bypass in a temporary tree and asserts whether the scan reports it.
   */
  describe('scan boundary derives from the emit, not from folder names', () => {
    const BYPASS = "import { dispatch } from '../core/dispatch.js';\nexport const go = dispatch;\n";

    const scanTree = async (
      layout: Readonly<Record<string, string>>,
      tsconfig?: string,
    ): Promise<readonly string[]> => {
      const pkg = await mkdtemp(path.join(tmpdir(), 'exarchos-seam-boundary-'));
      try {
        if (tsconfig !== undefined) {
          await writeFile(path.join(pkg, 'tsconfig.json'), tsconfig, 'utf8');
        }
        for (const [rel, contents] of Object.entries(layout)) {
          const abs = path.join(pkg, 'src', rel);
          await mkdir(path.dirname(abs), { recursive: true });
          await writeFile(abs, contents, 'utf8');
        }
        const sites = await scanDispatchSites(path.join(pkg, 'src'));
        return sites.map((s) => s.module);
      } finally {
        await rmrfAsync(pkg);
      }
    };

    const LIVE_TSCONFIG = readFileSync(
      path.join(SHIPPED_SRC_ROOT, '..', 'tsconfig.json'),
      'utf8',
    );

    it.each(['evals', 'benchmarks', 'test-helpers', '__fixtures__', '__mocks__'])(
      'ScanBoundary_EmittedDirectory_%s_IsInTheCensus',
      async (dir) => {
        const modules = await scanTree({ [`${dir}/bypass.ts`]: BYPASS }, LIVE_TSCONFIG);
        expect(modules).toEqual([`${dir}/bypass.ts`]);
      },
    );

    /** `tsconfig.json` excludes `__tests__`, so the scan skips that directory: the boundary still exists. */
    it('ScanBoundary_BuildExcludedDirectory_IsNotInTheCensus', async () => {
      const modules = await scanTree({ '__tests__/harness.ts': BYPASS }, LIVE_TSCONFIG);
      expect(modules).toEqual([]);
    });

    /**
     * The live path-prefix exclude sits outside `src/`, so it does not apply to the scan root.
     * The suffix and directory excludes must keep these files out of the census.
     */
    it('ScanBoundary_BuildExcludedSuffixesAndPathPrefixes_AreNotInTheCensus', async () => {
      const modules = await scanTree(
        {
          'a.test.ts': BYPASS,
          'b.bench.ts': BYPASS,
          'c.d.ts': BYPASS,
          'node_modules/dep/index.ts': BYPASS,
          'dist/emitted.ts': BYPASS,
        },
        LIVE_TSCONFIG,
      );
      expect(modules).toEqual([]);
    });

    /**
     * A change to the build excludes changes the scan boundary.
     * The live boundary does not hold `evals`, `benchmarks` or `test-helpers`, because the build emits them.
     */
    it('ScanBoundary_ExclusionsComeFromTheTsconfigNotAConstant', () => {
      const derived = parseEmitBoundary(['**/generated/**', '**/*.gen.ts', 'src/vendor/**']);
      expect(derived.directories.has('generated')).toBe(true);
      expect(derived.suffixes).toContain('.gen.ts');
      expect(derived.pathPrefixes).toContain('src/vendor');
      const live = resolveEmitBoundary(SHIPPED_SRC_ROOT);
      for (const emitted of ['evals', 'benchmarks', 'test-helpers']) {
        expect(live.directories.has(emitted), `${emitted} is emitted to dist/`).toBe(false);
      }
      expect(live.directories.has('__tests__')).toBe(true);
    });

    /** A root with no `tsconfig.json` gets the widest scan: only `node_modules`, `dist` and dot-directories stay out. */
    it('ScanBoundary_NoTsconfig_WidensRatherThanGuesses', async () => {
      const modules = await scanTree({
        'evals/bypass.ts': BYPASS,
        '__tests__/bypass.ts': BYPASS,
        'node_modules/dep/index.ts': BYPASS,
      });
      expect(modules).toEqual(['__tests__/bypass.ts', 'evals/bypass.ts']);
    });

    it('ScanBoundary_UnparseableTsconfig_FailsLoud', async () => {
      const pkg = await mkdtemp(path.join(tmpdir(), 'exarchos-seam-badconfig-'));
      try {
        await mkdir(path.join(pkg, 'src'), { recursive: true });
        await writeFile(path.join(pkg, 'tsconfig.json'), '{"include":["src"]}', 'utf8');
        expect(() => resolveEmitBoundary(path.join(pkg, 'src'))).toThrow(
          /declares no `exclude` array/,
        );
      } finally {
        await rmrfAsync(pkg);
      }
    });

    /**
     * A `tsconfig.json` is JSONC.
     * The resolver accepts a leading line comment, a trailing line comment and a block comment.
     */
    it('ScanBoundary_JsoncCommentForms_AreParsedNotChokedOn', async () => {
      const forms = [
        '{\n  // leading\n  "exclude": ["**/*.test.ts"] // trailing\n}',
        '{\n  /* block */\n  "exclude": ["**/*.test.ts"]\n}',
        '{ "exclude": ["**/*.test.ts"] /* inline */ }',
      ];
      for (const contents of forms) {
        const pkg = await mkdtemp(path.join(tmpdir(), 'exarchos-seam-jsonc-'));
        try {
          await mkdir(path.join(pkg, 'src'), { recursive: true });
          await writeFile(path.join(pkg, 'tsconfig.json'), contents, 'utf8');
          expect(() => resolveEmitBoundary(path.join(pkg, 'src'))).not.toThrow();
        } finally {
          await rmrfAsync(pkg);
        }
      }
    });

    /** The message names the config path, and `cause` keeps the parser error. */
    it('ScanBoundary_MalformedJson_NamesTheConfigAndKeepsTheCause', async () => {
      const pkg = await mkdtemp(path.join(tmpdir(), 'exarchos-seam-malformed-'));
      try {
        await mkdir(path.join(pkg, 'src'), { recursive: true });
        await writeFile(path.join(pkg, 'tsconfig.json'), '{ "exclude": [ ', 'utf8');
        let thrown: unknown;
        try {
          resolveEmitBoundary(path.join(pkg, 'src'));
        } catch (error) {
          thrown = error;
        }
        expect(String((thrown as Error).message)).toContain('tsconfig.json');
        expect((thrown as { cause?: unknown }).cause).toBeInstanceOf(Error);
      } finally {
        await rmrfAsync(pkg);
      }
    });
  });

  /** A value import of `dispatch` is a direct dispatch edge. A type-only import and a mention in a comment are not. */
  it('ImportDetector_DiscriminatesValueFromTypeAndProse', () => {
    expect(importsRuntimeDispatchValue("import { dispatch } from '../core/dispatch.js';")).toBe(true);
    expect(
      importsRuntimeDispatchValue("import { dispatch, type DispatchContext } from '../core/dispatch.js';"),
    ).toBe(true);
    expect(importsRuntimeDispatchValue("import type { DispatchContext } from '../core/dispatch.js';")).toBe(
      false,
    );
    expect(importsRuntimeDispatchValue("import { type DispatchContext } from '../core/dispatch.js';")).toBe(
      false,
    );
    expect(
      importsRuntimeDispatchValue("// we deliberately do not import dispatch from core/dispatch here"),
    ).toBe(false);
  });

  it('StripComments_PreservesStringsButRemovesComments', () => {
    const src = "const s = 'import { dispatch } from x'; // import { dispatch } from y\nconst t = 1;";
    const stripped = stripComments(src);
    expect(stripped).toContain("'import { dispatch } from x'");
    expect(stripped).not.toContain('from y');
  });

  /** A planted direct-dispatch path that no projection claims fails the census. */
  it('PlantedUnauthorizedDispatchSite_FailsCensus', () => {
    const diagnostics = runDispatchSeamCensus([
      { module: 'adapters/mcp/mcp.ts' },
      { module: 'contract/cli/generated-client.ts' },
      { module: 'cli-commands/rogue-direct-dispatch.ts' },
    ]);
    expect(diagnostics.some((d) => d.code === 'UNAUTHORIZED_DISPATCH_SITE')).toBe(true);
    const rogue = diagnostics.find((d) => d.code === 'UNAUTHORIZED_DISPATCH_SITE');
    expect(rogue).toBeDefined();
    if (rogue && rogue.code === 'UNAUTHORIZED_DISPATCH_SITE') {
      expect(rogue.module).toBe('cli-commands/rogue-direct-dispatch.ts');
    }
  });

  /** No deviation covers `adapters/cli/cli.ts`. A dispatch import in that adapter is an unauthorized bypass. */
  it('RegressedCliAdapterDispatchImport_FailsCensus', () => {
    const diagnostics = runDispatchSeamCensus([
      { module: 'adapters/mcp/mcp.ts' },
      { module: 'contract/cli/generated-client.ts' },
      { module: 'adapters/cli/cli.ts' },
    ]);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'UNAUTHORIZED_DISPATCH_SITE', module: 'adapters/cli/cli.ts' }),
    );
  });

  /** A declared projection that has no dispatch site is stale, and the census reports it. */
  it('StaleProjection_FailsCensus', () => {
    const diagnostics = runDispatchSeamCensus([{ module: 'contract/cli/generated-client.ts' }]);
    expect(
      diagnostics.some((d) => d.code === 'STALE_DISPATCH_PROJECTION' && d.module === 'adapters/mcp/mcp.ts'),
    ).toBe(true);
  });
});

describe('CLI command classification census', () => {
  it('LiveCommandTree_IsFullyClassified', async () => {
    const liveCommands = await collectLiveCliCommands();
    const result = runCliContractCensus({
      dispatchSites: [...AUTHORIZED_DISPATCH_PROJECTIONS].map((module) => ({ module })),
      liveCommands,
      classification: deriveCliClassification(),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /**
   * Host-local commands, such as `version`, `mcp` and the harness launchers, do not go through the contract handler.
   * The census must not report them.
   */
  it('HostLocalCommands_AreClassifiedNotFlagged', async () => {
    const classification = deriveCliClassification();
    for (const hostLocal of ['version', 'mcp', 'claude-code']) {
      expect(classification.hostLocal).toContain(hostLocal);
    }
    const liveCommands = await collectLiveCliCommands();
    const diagnostics = runCliClassificationCensus(liveCommands, classification);
    for (const hostLocal of HOST_LOCAL_COMMANDS) {
      expect(
        diagnostics.some((d) => d.code === 'UNCLASSIFIED_CLI_COMMAND' && d.command === hostLocal),
      ).toBe(false);
    }
  });

  /** A planted live command with no classification, such as an undeclared host-local verb, fails the census. */
  it('PlantedRogueCommand_FailsClassificationCensus', () => {
    const classification: CliClassification = {
      toolGroups: ['wf'],
      registryPromotions: [],
      presentationAliases: [],
      hostLocal: [],
    };
    const diagnostics = runCliClassificationCensus(
      [
        { name: 'wf', aliases: [] },
        { name: 'rogue', aliases: [] },
      ],
      classification,
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'UNCLASSIFIED_CLI_COMMAND', command: 'rogue' }),
    ]);
  });

  it('StaleHostLocalRule_FailsCensus', () => {
    const classification: CliClassification = {
      toolGroups: ['wf'],
      registryPromotions: [],
      presentationAliases: [],
      hostLocal: ['ghost-verb'],
    };
    const diagnostics = runCliClassificationCensus([{ name: 'wf', aliases: [] }], classification);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'STALE_HOST_LOCAL_RULE', command: 'ghost-verb' }),
    ]);
  });

  it('StalePresentationAlias_FailsCensus', () => {
    const classification: CliClassification = {
      toolGroups: ['wf'],
      registryPromotions: [],
      presentationAliases: ['ghost-alias'],
      hostLocal: [],
    };
    const diagnostics = runCliClassificationCensus([{ name: 'wf', aliases: [] }], classification);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'STALE_PRESENTATION_ALIAS', command: 'ghost-alias' }),
    ]);
  });

  it('DeclaredPresentationAliases_AllAppearLive', async () => {
    const liveCommands = await collectLiveCliCommands();
    const liveNames = new Set(liveCommands.map((c) => c.name));
    for (const alias of PRESENTATION_ALIASES) {
      expect(liveNames.has(alias)).toBe(true);
    }
  });
});

describe('CLI contract census (live system)', () => {
  it('AuditCliContract_IsGreen', async () => {
    const result = await auditCliContract();
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /** Each registered stable error code resolves to the exit code that the registry assigns. */
  it('EveryStableErrorCode_ResolvesToItsRegistryExitCode', () => {
    for (const [code, spec] of Object.entries(STABLE_ERROR_REGISTRY)) {
      expect(exitCodeForError(code)).toBe(spec.exitCode);
    }
  });
});
