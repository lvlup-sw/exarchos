import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  deriveCliSurface,
  serializeCliSurface,
  serializedCliSurfaceBaseline,
  compileForCli,
  CLI_SURFACE_FILE,
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
} from './cli-contract-seam.js';
import { exitCodeForError, STABLE_ERROR_REGISTRY, CONTRACT_EXIT_CODES } from '../error-families.js';

// ─── Generated CLI surface: byte-stable drift guard (exit-proof c) ───────────

describe('CLI-surface generation', () => {
  it('CheckedInGolden_MatchesFreshDerivation_ByteForByte', () => {
    // The generator (`npx tsx cli-contract-seam.ts`) IS the regeneration
    // gesture; the checked-in baseline must equal a fresh derivation byte for
    // byte, or the golden has drifted from the compiled contract.
    const onDisk = readFileSync(CLI_SURFACE_FILE, 'utf8');
    expect(onDisk).toBe(serializedCliSurfaceBaseline());
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
  // authorized projection surface — the MCP wire (a contract projection) plus
  // any module a recorded DR-25 deviation covers (`adapters/cli.ts` today).
  // This is also the genuine-findings gate: a new bypass anywhere in shipped
  // source turns it red.
  it('LiveTree_OnlyAuthorizedProjectionsImportTheDispatchValue', async () => {
    const sites = await scanDispatchSites();
    expect(sites.map((s) => s.module)).toEqual([...AUTHORIZED_DISPATCH_PROJECTIONS].sort());
  });

  it('LiveTree_PassesTheSeamCensus', async () => {
    const sites = await scanDispatchSites();
    expect(runDispatchSeamCensus(sites)).toEqual([]);
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

  // Exit-proof (b): a PLANTED direct-dispatch path fails the census.
  it('PlantedUnauthorizedDispatchSite_FailsCensus', () => {
    const diagnostics = runDispatchSeamCensus([
      { module: 'adapters/cli.ts' },
      { module: 'adapters/mcp.ts' },
      { module: 'cli-commands/rogue-direct-dispatch.ts' },
    ]);
    expect(diagnostics.some((d) => d.code === 'UNAUTHORIZED_DISPATCH_SITE')).toBe(true);
    const rogue = diagnostics.find((d) => d.code === 'UNAUTHORIZED_DISPATCH_SITE');
    expect(rogue).toBeDefined();
    if (rogue && rogue.code === 'UNAUTHORIZED_DISPATCH_SITE') {
      expect(rogue.module).toBe('cli-commands/rogue-direct-dispatch.ts');
    }
  });

  // The other ratchet arm: a declared projection that stops routing through the
  // shared handler is stale cover.
  it('StaleProjection_FailsCensus', () => {
    const diagnostics = runDispatchSeamCensus([{ module: 'adapters/cli.ts' }]);
    expect(
      diagnostics.some((d) => d.code === 'STALE_DISPATCH_PROJECTION' && d.module === 'adapters/mcp.ts'),
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
