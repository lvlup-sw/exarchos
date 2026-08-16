import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

// ─── Generated CLI surface: byte-stable drift guard (exit-proof c) ───────────

describe('CLI-surface generation', () => {
  it('CheckedInGolden_MatchesFreshDerivation_ByteForByte', () => {
    // The generator (`npx tsx cli-contract-seam.ts`) IS the regeneration
    // gesture; the checked-in baseline must equal a fresh derivation byte for
    // byte, or the golden has drifted from the compiled contract.
    const onDisk = readFileSync(CLI_SURFACE_FILE, 'utf8');
    expect(onDisk).toBe(serializedCliSurfaceBaseline());
  });

  it('CheckedInAddressingModule_MatchesFreshDerivation_ByteForByte', () => {
    // The generated addressing module (the static id set the generated client
    // dispatches from) regenerates in the SAME gesture as the golden. If it
    // drifts from a fresh derivation, the shipped binary would address a
    // different surface than the contract compiles — fail here, not at a
    // customer's cold start.
    const onDisk = readFileSync(CLI_ACTION_IDS_FILE, 'utf8');
    expect(onDisk).toBe(renderCliActionIdsModule(deriveCliSurface(compileForCli())));
  });

  it('Derivation_IsDeterministic_AcrossRepeatedCompiles', () => {
    // Two independent compiles → identical bytes: no clock/locale/order leak.
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

  // Exit-proof (e): every exit code in the generated surface is DERIVED from the
  // frozen P03-02 authority — the CLI does not invent its own exit ladder.
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

// ─── Collector 1: dispatch-seam containment (exit-proofs a + b) ──────────────

describe('Dispatch-seam containment census', () => {
  // Exit-proof (a): the LIVE tree's direct-dispatch paths are exactly the
  // authorized projection surface — the MCP wire and the CLI's generated
  // client, both contract projections (the DR-25 deviation ledger is empty
  // since `adapters/cli.ts` stopped importing the dispatch value). This is
  // also the genuine-findings gate: a new bypass anywhere in shipped source
  // turns it red.
  it('LiveTree_OnlyAuthorizedProjectionsImportTheDispatchValue', async () => {
    const sites = await scanDispatchSites();
    expect(sites.map((s) => s.module)).toEqual([...AUTHORIZED_DISPATCH_PROJECTIONS].sort());
  });

  it('LiveTree_PassesTheSeamCensus', async () => {
    const sites = await scanDispatchSites();
    expect(runDispatchSeamCensus(sites)).toEqual([]);
  });

  // ─── Scan-boundary kill fixtures (task 081, DR-8) ───────────────────────
  //
  // The boundary used to be six directory NAMES. Three of them — `evals`,
  // `benchmarks`, `test-helpers` — are inside `tsconfig.json`'s `include` and
  // outside its `exclude`, so the build compiles them into `dist/`: 51 emitted
  // modules were skipped on the strength of their folder names, and a direct
  // dispatch path in any of them was invisible to the census that claims none
  // exists. Each case below plants exactly that and requires it to be seen.
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
        await rm(pkg, { recursive: true, force: true });
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

    it('ScanBoundary_BuildExcludedDirectory_IsNotInTheCensus', async () => {
      // The other direction, from the SAME authority: `__tests__` is the one
      // former list member `tsconfig.json` actually excludes, so it must stay
      // out — the repair widens the subject, it does not abolish the boundary.
      const modules = await scanTree({ '__tests__/harness.ts': BYPASS }, LIVE_TSCONFIG);
      expect(modules).toEqual([]);
    });

    it('ScanBoundary_BuildExcludedSuffixesAndPathPrefixes_AreNotInTheCensus', async () => {
      const modules = await scanTree(
        {
          'a.test.ts': BYPASS,
          'b.bench.ts': BYPASS,
          'c.d.ts': BYPASS,
          'evals/benchmarks/seeded-defects/fixtures/planted.ts': BYPASS,
          'node_modules/dep/index.ts': BYPASS,
          'dist/emitted.ts': BYPASS,
        },
        LIVE_TSCONFIG,
      );
      expect(modules).toEqual([]);
    });

    it('ScanBoundary_ExclusionsComeFromTheTsconfigNotAConstant', () => {
      // The derivation is the point. Change what the build excludes and the
      // census's subject changes with it — a name list could not do this.
      const derived = parseEmitBoundary(['**/generated/**', '**/*.gen.ts', 'src/vendor/**']);
      expect(derived.directories.has('generated')).toBe(true);
      expect(derived.suffixes).toContain('.gen.ts');
      expect(derived.pathPrefixes).toContain('src/vendor');
      // And the three names that shipped as exclusions are NOT in the live one.
      const live = resolveEmitBoundary(SHIPPED_SRC_ROOT);
      for (const emitted of ['evals', 'benchmarks', 'test-helpers']) {
        expect(live.directories.has(emitted), `${emitted} is emitted to dist/`).toBe(false);
      }
      expect(live.directories.has('__tests__')).toBe(true);
    });

    it('ScanBoundary_NoTsconfig_WidensRatherThanGuesses', async () => {
      // A synthetic root has no build to ask. Over-scanning is the safe
      // direction, so everything but node_modules/dist/dot-dirs is in scope.
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
        await rm(pkg, { recursive: true, force: true });
      }
    });

    it('ScanBoundary_JsoncCommentForms_AreParsedNotChokedOn', async () => {
      // tsconfig files are JSONC. Only whole-line `//` was stripped, so a
      // trailing comment or any `/* … */` reached JSON.parse and came back as a
      // bare SyntaxError naming no file — from the helper whose whole job is
      // reading this config.
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
          await rm(pkg, { recursive: true, force: true });
        }
      }
    });

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
        // The path is in the message and the parser's own error is retained,
        // so the failure says WHICH config and WHY.
        expect(String((thrown as Error).message)).toContain('tsconfig.json');
        expect((thrown as { cause?: unknown }).cause).toBeInstanceOf(Error);
      } finally {
        await rm(pkg, { recursive: true, force: true });
      }
    });
  });

  it('ImportDetector_DiscriminatesValueFromTypeAndProse', () => {
    // A value import of the shared handler — a direct dispatch edge.
    expect(importsRuntimeDispatchValue("import { dispatch } from '../core/dispatch.js';")).toBe(true);
    expect(
      importsRuntimeDispatchValue("import { dispatch, type DispatchContext } from '../core/dispatch.js';"),
    ).toBe(true);
    // Type-only edges are NOT direct dispatch paths.
    expect(importsRuntimeDispatchValue("import type { DispatchContext } from '../core/dispatch.js';")).toBe(
      false,
    );
    expect(importsRuntimeDispatchValue("import { type DispatchContext } from '../core/dispatch.js';")).toBe(
      false,
    );
    // A prose mention in a comment must not be mistaken for an import.
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

  // Exit-proof (b): a PLANTED direct-dispatch path fails the census. Since the
  // DR-25 primary resolution, `adapters/cli.ts` itself would be such a plant —
  // its old direct path is no longer authorized by anything.
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

  // A REGRESSED adapter — `adapters/cli.ts` re-importing the dispatch value —
  // is a plain unauthorized bypass now, not a recordable state: the retired
  // deviation must not quietly come back.
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

  // The other ratchet arm: a declared projection that stops routing through the
  // shared handler is stale cover.
  it('StaleProjection_FailsCensus', () => {
    const diagnostics = runDispatchSeamCensus([{ module: 'contract/cli/generated-client.ts' }]);
    expect(
      diagnostics.some((d) => d.code === 'STALE_DISPATCH_PROJECTION' && d.module === 'adapters/mcp/mcp.ts'),
    ).toBe(true);
  });
});

// ─── Collector 2: CLI command classification ─────────────────────────────────

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

  it('HostLocalCommands_AreClassifiedNotFlagged', async () => {
    // Host-local commands legitimately do NOT route through the contract
    // handler; the census must RESPECT that classification. `version`, `mcp`,
    // and the harness launchers are host-local and must not be flagged.
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

  // Exit-proof (b), classification arm: a planted, unclassified live command
  // (e.g. a new host-local verb nobody declared) fails the census.
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

// ─── Full live census (the exit-proof harness drives this) ───────────────────

describe('CLI contract census (live system)', () => {
  it('AuditCliContract_IsGreen', async () => {
    const result = await auditCliContract();
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // Every registered stable error code resolves to the exit code the frozen
  // registry assigns — the CLI surface and the contract authority cannot drift.
  it('EveryStableErrorCode_ResolvesToItsRegistryExitCode', () => {
    for (const [code, spec] of Object.entries(STABLE_ERROR_REGISTRY)) {
      expect(exitCodeForError(code)).toBe(spec.exitCode);
    }
  });
});
