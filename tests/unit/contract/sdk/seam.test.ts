/**
 * Tests the owned SDK seam and its generation brands. TypeScript compares SDK
 * types by structure, so the SDK types alone cannot keep two generations apart.
 * `seam.ts` is the only importer of the SDK and brands each handle that it gives
 * out. Thus `tsc` rejects a handle of one generation where the other is expected.
 *
 * The live-tree census compares two independent sources. The rule module names
 * the SDK specifiers and the seam module. `package.json` names the installed
 * generations.
 *
 * @oracle-sources: ../../../../src/architecture/sdk-generation-seam.ts, ../../../../package.json
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SDK_SEAM_MODULE,
  classifySdkImport,
  isOwnedSeamModule,
  lintSdkGenerationMixing,
  collectSdkImportSites,
  runSdkSeamCensus,
  type SdkImportSite,
} from '../../../../src/architecture/sdk-generation-seam.js';
import type { SdkGeneration } from '../../../../src/contract/sdk/brand.js';
import { parseModuleSpecifiers } from '../../../../tools/test-helpers/module-specifier-parser.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { listTrackedFiles, trackedFilesMissedBy } from '../../../../tools/test-helpers/tracked-population.js';
import { makeRepoSandbox, type RepoSandbox } from '../../../../tools/test-helpers/repo-sandbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, '../../../..');
const srcRoot = path.join(packageRoot, 'src');

/**
 * The SDK package scope. The fixture specifiers are assembled from it, so a scan
 * that matches text does not count this file as an SDK importer.
 */
const SCOPE = '@modelcontextprotocol';
const v1Specifier = (subpath: string): string => `${SCOPE}/sdk/${subpath}`;
const v2Specifier = (subpath: string): string => `${SCOPE}/${subpath}`;
const importFrom = (specifier: string): string => `import * as m from '${specifier}';\n`;

/**
 * The positive control. Each handle stays in its own generation, so this file
 * must compile clean. If it does not, the fixture is broken and the failure of
 * the cross-generation file proves nothing about the brand.
 */
const SAME_GENERATION_FIXTURE = `
import {
  createV2McpServer,
  createV2StdioServerTransport,
  createV2Client,
  createV2LinkedTransportPair,
  connectV2Server,
  connectV2Client,
} from '../src/contract/sdk/seam.js';

export async function v2Only(): Promise<void> {
  const server = createV2McpServer({ name: 'probe', version: '1.0.0' });
  await connectV2Server(server, createV2StdioServerTransport());

  const [clientSide, serverSide] = createV2LinkedTransportPair();
  const client = createV2Client({ name: 'probe', version: '1.0.0' });
  await connectV2Client(client, clientSide);
  await connectV2Server(createV2McpServer({ name: 'peer', version: '1.0.0' }), serverSide);
}
`;

/**
 * The kill fixture. Only the v2 SDK is installed, so the counterparty is
 * synthetic: `V1<Omit<V2Transport, '__gen'>>` is the v2 transport shape with the
 * `v1` brand. The two values differ in the brand only, so each rejection must
 * come from the brand.
 */
const CROSS_GENERATION_FIXTURE = `
import {
  createV2McpServer,
  createV2LinkedTransportPair,
  connectV2Server,
  type V1,
  type V2Transport,
} from '../src/contract/sdk/seam.js';

/**
 * A transport that is structurally identical to a v2 transport and branded v1.
 * Strip-then-rebrand rather than intersect: \\\`V1<V2Transport>\\\` would collapse
 * \\\`__gen\\\` to \\\`never\\\` and reject for an uninhabited-property reason, which
 * would prove the intersection collapsed and not that the brand separates.
 */
declare const v1Transport: V1<Omit<V2Transport, '__gen'>>;

// 1. A v1-branded transport handed to a v2 server.
export async function v1TransportIntoV2Server(): Promise<void> {
  await connectV2Server(createV2McpServer({ name: 'probe', version: '1.0.0' }), v1Transport);
}

// 2. The DR-0 kill fixture: a "linked pair" whose halves disagree on generation.
//    The halves are not linked to each other; at runtime this is a hang.
export async function crossGenerationLinkedPair(): Promise<void> {
  const [v2Half] = createV2LinkedTransportPair();
  await connectV2Server(createV2McpServer({ name: 'probe', version: '1.0.0' }), v2Half);
  await connectV2Server(createV2McpServer({ name: 'probe', version: '1.0.0' }), v1Transport);
}

// 3. Plain assignment between the branded handle types.
export function assignAcrossGenerations(): void {
  const asV2: V2Transport = v1Transport;
  void asV2;
}
`;

/** The package's own strict settings, spelled out for a standalone `tsc` run. */
const TSC_FLAGS = [
  '--noEmit',
  '--strict',
  '--noUncheckedIndexedAccess',
  '--exactOptionalPropertyTypes',
  '--esModuleInterop',
  '--module',
  'NodeNext',
  '--moduleResolution',
  'NodeNext',
  '--target',
  'ES2022',
  '--lib',
  'ES2022',
  '--skipLibCheck',
];

/** One `tsc` diagnostic: its opening line plus every indented continuation. */
interface TscDiagnostic {
  /** The file the diagnostic is reported against. */
  readonly file: string;
  /** Opening line plus continuations, joined — the checker's full explanation. */
  readonly text: string;
}

interface TscRun {
  readonly accepted: boolean;
  readonly output: string;
  readonly diagnostics: readonly TscDiagnostic[];
}

const DIAGNOSTIC_OPENER = /^(\S.*?)\(\d+,\d+\): error TS\d+/;

/**
 * Groups `tsc` output into whole diagnostics. The indented continuation lines
 * name the `__gen` property. That text separates a brand rejection from another
 * structural rejection, so the opener line alone is not sufficient.
 */
function parseDiagnostics(output: string): TscDiagnostic[] {
  const diagnostics: TscDiagnostic[] = [];
  let current: { file: string; lines: string[] } | undefined;
  for (const line of output.split('\n')) {
    const opener = DIAGNOSTIC_OPENER.exec(line);
    if (opener?.[1] !== undefined) {
      if (current) diagnostics.push({ file: current.file, text: current.lines.join('\n') });
      current = { file: opener[1], lines: [line] };
      continue;
    }
    if (current && /^\s+\S/.test(line)) current.lines.push(line);
  }
  if (current) diagnostics.push({ file: current.file, text: current.lines.join('\n') });
  return diagnostics;
}

/** Recovers the output of a failed `tsc` run. `tsc` writes its diagnostics to stdout and exits non-zero. */
function spawnOutputOf(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const streams: string[] = [];
  for (const key of ['stdout', 'stderr']) {
    if (!(key in err)) continue;
    const value: unknown = Reflect.get(err, key);
    if (typeof value === 'string') streams.push(value);
    else if (value instanceof Uint8Array) streams.push(Buffer.from(value).toString('utf8'));
  }
  return streams.join('');
}

async function runTsc(files: readonly string[]): Promise<TscRun> {
  let output = '';
  let accepted: boolean;
  try {
    output = await execFileAsync(
      process.execPath,
      [path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc'), ...TSC_FLAGS, ...files],
      { cwd: packageRoot },
    );
    accepted = true;
  } catch (err) {
    output = spawnOutputOf(err);
    accepted = false;
  }
  return { accepted, output, diagnostics: parseDiagnostics(output) };
}

/**
 * Counts the crossings of the kill fixture from its `export function` sites. A
 * new crossing thus raises the count that the brand rejections must reach.
 */
function crossingCountOf(fixture: string): number {
  return [...fixture.matchAll(/^export (?:async )?function /gm)].length;
}

/**
 * Writes both fixtures into a temp sandbox, never into the checkout. They import
 * the live seam module by absolute path. A `package.json` with
 * `"type": "module"` makes NodeNext read them as ES modules.
 */
function writeBrandFixtures(sandbox: RepoSandbox): { samePath: string; crossPath: string } {
  const seam = path.join(srcRoot, 'contract', 'sdk', 'seam.js').split(path.sep).join('/');
  const retarget = (fixture: string): string => fixture.replaceAll("'../src/contract/sdk/seam.js'", `'${seam}'`);
  sandbox.write('package.json', '{ "type": "module" }\n');
  return {
    samePath: sandbox.write('same-generation.ts', retarget(SAME_GENERATION_FIXTURE)),
    crossPath: sandbox.write('cross-generation.ts', retarget(CROSS_GENERATION_FIXTURE)),
  };
}

describe('DR-26 — owned SDK seam, generation-branded handles', () => {
  /**
   * BLOCKING ARM: `tsc` must reject a handle of one generation where the other
   * generation is expected.
   * NEGATIVE TWIN: the same-generation fixture compiles clean in the same `tsc`
   * run. Thus the rejection comes from the brand, not from a broken fixture.
   *
   * Each rejection must name `__gen` and `SdkGenerationBrand`, because the two
   * values differ in the brand only. The count of brand rejections must reach
   * the count of crossings that the fixture declares.
   */
  it('SdkSeam_HandleFromOtherGeneration_FailsCompile', async () => {
    const fixtures = await makeRepoSandbox({ prefix: 'sdk-brand' });
    try {
      const { samePath, crossPath } = writeBrandFixtures(fixtures);

      const run = await runTsc([samePath, crossPath]);

      expect(
        run.accepted,
        'Cross-generation mixing through the seam COMPILED. DR-26 restores ' +
          "DR-0's rung-2 claim; if this passes, the brand has stopped " +
          `separating the generations.\n${run.output}`,
      ).toBe(false);

      const fromControl = run.diagnostics.filter((d) => d.file.endsWith('same-generation.ts'));
      expect(
        fromControl.map((d) => d.text),
        'The same-generation control must compile clean. Diagnostics against ' +
          `it mean the fixture is broken, so the cross-generation failure ` +
          `proves nothing.\n${run.output}`,
      ).toEqual([]);

      const fromKill = run.diagnostics.filter((d) => d.file.endsWith('cross-generation.ts'));
      expect(fromKill.length).toBeGreaterThan(0);

      const brandAttributed = fromKill.filter(
        (d) => d.text.includes('__gen') && d.text.includes('SdkGenerationBrand'),
      );
      expect(
        brandAttributed.length,
        `tsc rejected the mix, but ${brandAttributed.length} of ${fromKill.length} ` +
          `rejections came from the generation brand — the rest are incidental ` +
          `structural differences, which this fixture is built to have none of.` +
          `\n${run.output}`,
      ).toBe(fromKill.length);

      expect(
        brandAttributed.length,
        `The fixture declares ${crossingCountOf(CROSS_GENERATION_FIXTURE)} crossing(s) ` +
          `but only ${brandAttributed.length} were rejected by the brand. A ` +
          `crossing that compiles is a hole in the rung-2 guarantee.\n${run.output}`,
      ).toBeGreaterThanOrEqual(crossingCountOf(CROSS_GENERATION_FIXTURE));
    } finally {
      fixtures.remove();
    }
  }, 180_000);

  /**
   * BLOCKING ARM: a census with zero SDK import sites must fail. An SDK
   * generation is installed, so zero sites means a broken scan.
   * NEGATIVE TWIN: the census of the live tree is green, so the rejection comes
   * from the empty population.
   *
   * The walk must reach each module that git tracks under the scan root. That
   * check, the site count and the seam site count fail on a broken walk, so a
   * bypass count of zero is not vacuous. `package.json` is the second authority:
   * the seam must import each installed generation.
   */
  it('SdkSeam_ZeroImportSitesResolved_FailsClosed', async () => {
    const empty = runSdkSeamCensus({
      sites: [],
      seamModulePresent: true,
      moduleCount: 400,
      installedGenerations: ['v2'],
    });
    expect(empty.ok).toBe(false);
    expect(empty.siteCount).toBe(0);
    expect(empty.diagnostics.map((d) => d.code)).toContain('EMPTY_SDK_IMPORT_DENOMINATOR');

    const scan = scanLiveTree();
    expect(scan.sites.length).toBeGreaterThan(0);
    const trackedModules = await listTrackedFiles(srcRoot);
    expect(
      trackedFilesMissedBy(scan.modules, trackedModules),
      'the walk did not reach every module git tracks under the scan root — the ' +
        'root moved, an exclusion widened, or the walker broke. Everything below ' +
        'this line is measured over whatever it DID reach.',
    ).toEqual([]);
    const live = runSdkSeamCensus(scan);
    expect(
      live.diagnostics.map((d) => d.message),
      'The live-tree census must be green; a failure here means the seam moved, ' +
        'stopped importing the SDK, or lost a generation.',
    ).toEqual([]);
    expect(live.ok).toBe(true);

    expect(live.seamSiteCount).toBeGreaterThan(0);

    expect(
      live.bypassSiteCount,
      'A module outside `contract/sdk/seam.ts` imports an MCP SDK package directly. ' +
        'DR-26 makes the seam the SOLE importer, so this is a bypass — route ' +
        'the import through `contract/sdk/seam.ts`. `architecture/layer-boundaries-seam.ts` ' +
        'names the offending module.',
    ).toBe(0);

    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const deps =
      typeof pkg === 'object' && pkg !== null
        ? ((pkg as { dependencies?: Record<string, string> }).dependencies ?? {})
        : {};
    const installedScoped = Object.keys(deps).filter((name) => name.startsWith(`${SCOPE}/`));
    expect(installedScoped.length).toBeGreaterThan(0);

    const seamGenerations = new Set(
      scan.sites.filter((site) => site.throughSeam).map((site) => site.generation),
    );
    const uncovered = installedScoped.filter((name) => {
      const generation = name === `${SCOPE}/sdk` ? 'v1' : 'v2';
      return !seamGenerations.has(generation);
    });
    expect(
      uncovered,
      'These MCP SDK packages are installed but the owned seam draws from ' +
        'neither of their generations, so their handles would cross unbranded.',
    ).toEqual([]);
  });

  /**
   * The kill fixture for the tracked-module check. A walk of `verbs/` only still
   * reaches more than 50 modules, so a count threshold of 50 accepts it. The
   * module paths stay relative to `srcRoot`, so only the coverage differs. The
   * check must name the missed modules, and none of them is under `verbs/`.
   */
  it('SdkSeamPopulationPin_NarrowedScanRoot_FailsInsteadOfPassing', async () => {
    const narrowed = scanLiveTree(path.join(srcRoot, 'verbs'), srcRoot);
    expect(
      narrowed.moduleCount,
      'the narrowed root must clear the RETIRED floor — otherwise this fixture ' +
        'proves nothing about what the floor let through',
    ).toBeGreaterThan(50);

    const tracked = await listTrackedFiles(srcRoot);
    const missed = trackedFilesMissedBy(narrowed.modules, tracked, tracked.length);
    expect(missed.length, 'the derived pin must reject the narrowed walk').toBeGreaterThan(0);
    expect(missed.filter((module) => module.startsWith('verbs/'))).toEqual([]);
    expect(missed).toContain('contract/sdk/seam.ts');
  });

  /**
   * The sites resolve, but the seam module is absent. A seam module that is
   * present and imports no SDK also fails.
   */
  it('SdkSeamCensus_SeamMovedOrRenamed_FailsClosed', () => {
    const site: SdkImportSite = {
      module: 'adapters/mcp.ts',
      specifier: v1Specifier('server/mcp.js'),
      generation: 'v1',
      line: 3,
      throughSeam: false,
    };
    const moved = runSdkSeamCensus({
      sites: [site],
      seamModulePresent: false,
      moduleCount: 400,
      installedGenerations: ['v1', 'v2'],
    });
    expect(moved.ok).toBe(false);
    expect(moved.diagnostics.map((d) => d.code)).toContain('SDK_SEAM_MODULE_MISSING');

    const hollow = runSdkSeamCensus({
      sites: [site],
      seamModulePresent: true,
      moduleCount: 400,
      installedGenerations: ['v1', 'v2'],
    });
    expect(hollow.ok).toBe(false);
    expect(hollow.diagnostics.map((d) => d.code)).toContain('SEAM_IMPORTS_NO_SDK');
  });

  /**
   * The seam is present and imports v1 only. The scan declares both generations
   * as installed, because the live manifest holds v2 only and cannot build this
   * case.
   */
  it('SdkSeamCensus_SeamDropsOneGeneration_ReportsUncovered', () => {
    const seamV1Only: SdkImportSite = {
      module: SDK_SEAM_MODULE,
      specifier: v1Specifier('server/mcp.js'),
      generation: 'v1',
      line: 10,
      throughSeam: true,
    };
    const result = runSdkSeamCensus({
      sites: [seamV1Only],
      seamModulePresent: true,
      moduleCount: 400,
      installedGenerations: ['v1', 'v2'],
    });
    expect(result.ok).toBe(false);
    const uncovered = result.diagnostics.filter((d) => d.code === 'SEAM_GENERATION_UNCOVERED');
    expect(uncovered.map((d) => (d.code === 'SEAM_GENERATION_UNCOVERED' ? d.generation : ''))).toEqual([
      'v2',
    ]);
  });

  /**
   * The census checks coverage against the installed set. An empty set has no
   * uncovered generation, so the census must reject an empty set.
   * NEGATIVE TWIN: the same scan with the generation declared is green, so the
   * rejection comes from the empty set.
   */
  it('SdkSeamCensus_NoGenerationInstalled_FailsClosed', () => {
    const seamSite: SdkImportSite = {
      module: SDK_SEAM_MODULE,
      specifier: v2Specifier('server'),
      generation: 'v2',
      line: 10,
      throughSeam: true,
    };
    const none = runSdkSeamCensus({
      sites: [seamSite],
      seamModulePresent: true,
      moduleCount: 400,
      installedGenerations: [],
    });
    expect(none.ok).toBe(false);
    expect(none.diagnostics.map((d) => d.code)).toContain('NO_SDK_GENERATION_INSTALLED');

    const declared = runSdkSeamCensus({
      sites: [seamSite],
      seamModulePresent: true,
      moduleCount: 400,
      installedGenerations: ['v2'],
    });
    expect(declared.diagnostics.map((d) => d.message)).toEqual([]);
    expect(declared.ok).toBe(true);
  });

  it('CollectSdkImportSites_SeamAndBypass_AreAttributedApart', () => {
    const source = importFrom(v1Specifier('types.js')) + importFrom(v2Specifier('server'));

    const seamSites = collectSdkImportSites(
      `src/${SDK_SEAM_MODULE}`,
      source,
      parseModuleSpecifiers,
    );
    expect(seamSites.map((s) => s.generation)).toEqual(['v1', 'v2']);
    expect(seamSites.map((s) => s.throughSeam)).toEqual([true, true]);

    const bypassSites = collectSdkImportSites(
      'src/adapters/mcp.ts',
      source,
      parseModuleSpecifiers,
    );
    expect(bypassSites.map((s) => s.throughSeam)).toEqual([false, false]);
  });

  /** The exemption covers one module. A path that is almost the same is not exempt. */
  it('IsOwnedSeamModule_AbsoluteRelativeAndWindowsPaths_AllResolve', () => {
    expect(isOwnedSeamModule(SDK_SEAM_MODULE)).toBe(true);
    expect(isOwnedSeamModule(`src/${SDK_SEAM_MODULE}`)).toBe(true);
    expect(isOwnedSeamModule(`/repo/src/${SDK_SEAM_MODULE}`)).toBe(true);
    expect(isOwnedSeamModule('C:\\repo\\servers\\exarchos-mcp\\src\\contract\\sdk\\seam.ts')).toBe(true);

    expect(isOwnedSeamModule('src/contract/sdk/brand.ts')).toBe(false);
    expect(isOwnedSeamModule('src/contract/sdk/seam.test.ts')).toBe(false);
    expect(isOwnedSeamModule('src/adapters/seam.ts')).toBe(false);
  });

  /** The seam holds both generations by design. Any other module that holds both is a HIGH finding. */
  it('LintSdkGenerationMixing_OwnedSeamOnly_IsExemptFromMixing', () => {
    const mixed = importFrom(v1Specifier('inMemory.js')) + importFrom(v2Specifier('server'));

    expect(
      lintSdkGenerationMixing(`src/${SDK_SEAM_MODULE}`, mixed, parseModuleSpecifiers),
    ).toEqual([]);

    const findings = lintSdkGenerationMixing(
      'src/adapters/mcp.ts',
      mixed,
      parseModuleSpecifiers,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('HIGH');
  });
});

/**
 * Walks the source tree and attributes each SDK import. The walk reads the
 * population from the filesystem, so a relocated tree gives an empty
 * denominator and not a clean pass.
 *
 * @param relativeTo The base of the reported module paths. The narrowed-root
 *   kill fixture sets it to `srcRoot`, so only the coverage differs between
 *   the two scans.
 */
function scanLiveTree(
  root: string = srcRoot,
  relativeTo: string = root,
): {
  sites: SdkImportSite[];
  seamModulePresent: boolean;
  moduleCount: number;
  /**
   * The modules that the walk reached, relative to `relativeTo`. A shortfall
   * against the tracked population can then name each missed module.
   */
  modules: string[];
  installedGenerations: SdkGeneration[];
} {
  const sites: SdkImportSite[] = [];
  const modules: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const module = path.relative(relativeTo, full).split(path.sep).join('/');
      modules.push(module);
      sites.push(
        ...collectSdkImportSites(
          module,
          fs.readFileSync(full, 'utf8'),
          parseModuleSpecifiers,
        ),
      );
    }
  };
  walk(root);
  return {
    sites,
    seamModulePresent: fs.existsSync(path.join(root, ...SDK_SEAM_MODULE.split('/'))),
    moduleCount: modules.length,
    modules,
    installedGenerations: installedGenerationsFromManifest(),
  };
}

/**
 * Returns the SDK generations that `package.json` declares. `classifySdkImport`
 * classifies each package name, so the manifest and the import scan share one
 * mapping from package name to generation.
 */
function installedGenerationsFromManifest(): SdkGeneration[] {
  const pkg: unknown = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  const deps =
    typeof pkg === 'object' && pkg !== null
      ? ((pkg as { dependencies?: Record<string, string> }).dependencies ?? {})
      : {};
  const generations = new Set<SdkGeneration>();
  for (const name of Object.keys(deps)) {
    const generation = classifySdkImport(name);
    if (generation !== undefined) generations.add(generation);
  }
  return [...generations];
}
