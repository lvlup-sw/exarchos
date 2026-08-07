// ─── DR-26 — the owned SDK seam and its generation brands ──────────────────
//
// DR-0's original error-path criterion — "a partially-migrated tree must fail
// typecheck rather than resolve two copies of the protocol types" — was
// measured by task 049 and found FALSE: both SDK generations declare a
// structural `Transport`, TypeScript has no notion of nominal package identity,
// and `tsc --strict` accepts every mixing direction.
//
// DR-26 does not weaken the criterion; it moves it to a subject that can carry
// it. `./seam.ts` is the sole importer of either generation and brands every
// handle it hands out, so the criterion becomes true FOR VALUES DRAWN THROUGH
// THE SEAM. The first test below is that criterion, restated as a live compile.
//
/**
 * DR-30 authorities. The live-tree census below is cross-checked against two
 * sources, neither derived from the other:
 *
 *   • `../architecture/sdk-generation-seam.ts` — the RULE: which specifiers
 *     constitute a generation, and which module is the owned seam.
 *   • `../../package.json` — the INSTALLED REALITY: which generations npm was
 *     actually asked to resolve. A seam that stopped drawing from an installed
 *     generation, or a rule that cannot classify a declared dependency, is a
 *     disagreement between these two and surfaces as a failure rather than a
 *     silent pass.
 *
 * Neither reaches the other in the static import graph: the rule module imports
 * `../sdk/brand.js` (the generation vocabulary) and nothing else from `sdk/`,
 * and `package.json` is data.
 *
 * @oracle-sources: ../architecture/sdk-generation-seam.ts, ../../package.json
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SDK_SEAM_MODULE,
  isOwnedSeamModule,
  lintSdkGenerationMixing,
  collectSdkImportSites,
  runSdkSeamCensus,
  type SdkImportSite,
} from '../architecture/sdk-generation-seam.js';
import { parseModuleSpecifiers } from '../test-helpers/module-specifier-parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/sdk → servers/exarchos-mcp
const packageRoot = path.join(here, '..', '..');
const srcRoot = path.join(packageRoot, 'src');

// ── Fixture specifiers are ASSEMBLED, never written literally ────────────────
//
// The original reason no longer holds, and saying so is the point.
// `LintSdkGenerationMixing_RepoSources_AreNotYetMixed` sweeps every `.ts` file
// under `src/`, including this one, and a literal `from '@modelcontextprotocol/…'`
// in fixture text USED TO make this file look like a module straddling both
// generations. Task 062 replaced that sweep's text match with a real parse, so
// fixture text in a template literal is no longer an import site and the
// assembly is no longer load-bearing.
//
// It is retained rather than unwound because it still buys one thing: this file
// contributes nothing to DR-26's `bypassSiteCount` under EITHER instrument, so
// the live-tree numbers here cannot drift for a reason internal to the test.
const SCOPE = '@modelcontextprotocol';
const v1Specifier = (subpath: string): string => `${SCOPE}/sdk/${subpath}`;
const v2Specifier = (subpath: string): string => `${SCOPE}/${subpath}`;
const importFrom = (specifier: string): string => `import * as m from '${specifier}';\n`;

// ════════════════════════════════════════════════════════════════════════════
// The rung-2 guarantee: compile the brand
// ════════════════════════════════════════════════════════════════════════════

/**
 * POSITIVE CONTROL. Every handle stays inside its own generation. This file
 * must compile CLEAN — otherwise "the cross-generation file failed to compile"
 * would prove nothing about the brand, only that the fixture was broken.
 */
const SAME_GENERATION_FIXTURE = `
import {
  createV1McpServer,
  createV1StdioServerTransport,
  createV1Client,
  createV1LinkedTransportPair,
  connectV1Server,
  connectV1Client,
  createV2McpServer,
  createV2StdioServerTransport,
  createV2LinkedTransportPair,
  connectV2Server,
} from '../src/sdk/seam.js';

export async function v1Only(): Promise<void> {
  const server = createV1McpServer({ name: 'probe', version: '1.0.0' });
  await connectV1Server(server, createV1StdioServerTransport());

  const [clientSide, serverSide] = createV1LinkedTransportPair();
  const client = createV1Client({ name: 'probe', version: '1.0.0' });
  await connectV1Client(client, clientSide);
  await connectV1Server(createV1McpServer({ name: 'peer', version: '1.0.0' }), serverSide);
}

export async function v2Only(): Promise<void> {
  const server = createV2McpServer({ name: 'probe', version: '1.0.0' });
  await connectV2Server(server, createV2StdioServerTransport());

  const [, serverSide] = createV2LinkedTransportPair();
  await connectV2Server(createV2McpServer({ name: 'peer', version: '1.0.0' }), serverSide);
}
`;

/**
 * THE KILL FIXTURE. Four crossings, in both directions, including the exact
 * cross-package "linked pair" DR-0 named and task 049 measured `tsc` accepting.
 * Every one of them must be rejected, and rejected BY THE BRAND (`__gen`).
 */
const CROSS_GENERATION_FIXTURE = `
import {
  createV1McpServer,
  createV1StdioServerTransport,
  createV1LinkedTransportPair,
  connectV1Server,
  createV2McpServer,
  createV2StdioServerTransport,
  createV2LinkedTransportPair,
  connectV2Server,
  type V1Transport,
  type V2Transport,
} from '../src/sdk/seam.js';

// 1. A v1 transport handed to a v2 server.
export async function v1TransportIntoV2Server(): Promise<void> {
  await connectV2Server(createV2McpServer({ name: 'probe', version: '1.0.0' }), createV1StdioServerTransport());
}

// 2. A v2 transport handed to a v1 server.
export async function v2TransportIntoV1Server(): Promise<void> {
  await connectV1Server(createV1McpServer({ name: 'probe', version: '1.0.0' }), createV2StdioServerTransport());
}

// 3. The DR-0 kill fixture: a "linked pair" whose halves come from different
//    generations. The halves are not linked; at runtime this is a hang.
export async function crossGenerationLinkedPair(): Promise<void> {
  const [v1Half] = createV1LinkedTransportPair();
  const [, v2Half] = createV2LinkedTransportPair();
  await connectV2Server(createV2McpServer({ name: 'probe', version: '1.0.0' }), v1Half);
  await connectV1Server(createV1McpServer({ name: 'probe', version: '1.0.0' }), v2Half);
}

// 4. Plain assignment between the branded handle types, both directions.
export function assignAcrossGenerations(v1: V1Transport, v2: V2Transport): void {
  const asV2: V2Transport = v1;
  const asV1: V1Transport = v2;
  void asV2;
  void asV1;
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
 * Group `tsc` output into whole diagnostics. The attribution this test needs
 * lives in the INDENTED continuation lines ("Types of property '__gen' are
 * incompatible"), so reading opener lines alone would lose exactly the evidence
 * that distinguishes a brand rejection from an incidental structural one.
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

/** `tsc` writes its diagnostics to stdout and exits non-zero; recover both. */
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

function runTsc(files: readonly string[]): TscRun {
  let output = '';
  let accepted: boolean;
  try {
    output = execFileSync(
      process.execPath,
      [path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc'), ...TSC_FLAGS, ...files],
      { cwd: packageRoot, encoding: 'utf8', stdio: 'pipe' },
    );
    accepted = true;
  } catch (err) {
    output = spawnOutputOf(err);
    accepted = false;
  }
  return { accepted, output, diagnostics: parseDiagnostics(output) };
}

/**
 * How many of the kill fixture's six crossings must be rejected BY THE BRAND.
 *
 * Measured, not guessed. Five of the six name `SdkGenerationBrand` / `__gen`:
 * the four `connect*` crossings (a handle passed where the other generation is
 * expected) and the v1→v2 assignment. The sixth — the v2→v1 assignment — is
 * rejected for an unrelated structural reason: under `exactOptionalPropertyTypes`
 * v2 declares `onclose?: (() => void) | undefined` where v1 declares
 * `onclose?: () => void`, so `undefined` is not assignable. That rejection is
 * incidental — it would evaporate the moment either package normalised its
 * optional-property style — so it is deliberately NOT counted as brand evidence.
 *
 * This floor is what makes the test a real kill probe: with `__gen` widened from
 * the generation literal to the full union, brand-attributed rejections drop to
 * ZERO and only that one incidental structural error survives — so asserting
 * merely "tsc failed" would still have passed against a dead brand.
 */
const MIN_BRAND_ATTRIBUTED_REJECTIONS = 5;

describe('DR-26 — owned SDK seam, generation-branded handles', () => {
  it('SdkSeam_HandleFromOtherGeneration_FailsCompile', () => {
    // BLOCKING ARM — a handle drawn from one generation, passed where the other
    // is expected, must fail `tsc`. This is DR-0's original rung-2 criterion,
    // now true because the subject is the seam's own branded handle type rather
    // than the SDK's structural `Transport`.
    //
    // NEGATIVE TWIN — the same-generation fixture compiles in the SAME `tsc`
    // invocation and contributes ZERO diagnostics. The seam it kills: "the
    // cross-generation file failed for some unrelated reason (a broken import,
    // a wrong constructor signature, a missing dependency)". Both files share
    // every flag, both import the same module, and only one of them errors —
    // so the rejection is attributable to the brand and to nothing else.
    const tmpDir = fs.mkdtempSync(path.join(packageRoot, '.tmp-sdk-brand-'));
    const samePath = path.join(tmpDir, 'same-generation.ts');
    const crossPath = path.join(tmpDir, 'cross-generation.ts');
    try {
      fs.writeFileSync(samePath, SAME_GENERATION_FIXTURE, 'utf8');
      fs.writeFileSync(crossPath, CROSS_GENERATION_FIXTURE, 'utf8');

      const run = runTsc([samePath, crossPath]);

      expect(
        run.accepted,
        'Cross-generation mixing through the seam COMPILED. DR-26 restores ' +
          "DR-0's rung-2 claim; if this passes, the brand has stopped " +
          `separating the generations.\n${run.output}`,
      ).toBe(false);

      // The failure is the brand's, not the fixture's.
      const fromControl = run.diagnostics.filter((d) => d.file.endsWith('same-generation.ts'));
      expect(
        fromControl.map((d) => d.text),
        'The same-generation control must compile clean. Diagnostics against ' +
          `it mean the fixture is broken, so the cross-generation failure ` +
          `proves nothing.\n${run.output}`,
      ).toEqual([]);

      const fromKill = run.diagnostics.filter((d) => d.file.endsWith('cross-generation.ts'));
      expect(fromKill.length).toBeGreaterThan(0);

      // Rejected BY THE BRAND, not incidentally: the checker's explanation must
      // name the generation discriminant. See MIN_BRAND_ATTRIBUTED_REJECTIONS
      // for why a bare "tsc failed" assertion would not have been enough.
      const brandAttributed = fromKill.filter(
        (d) => d.text.includes('__gen') && d.text.includes('SdkGenerationBrand'),
      );
      expect(
        brandAttributed.length,
        `tsc rejected the mix, but ${brandAttributed.length} of ${fromKill.length} ` +
          `rejections came from the generation brand — the rest may be ` +
          `incidental structural differences that would disappear on the next ` +
          `SDK release.\n${run.output}`,
      ).toBeGreaterThanOrEqual(MIN_BRAND_ATTRIBUTED_REJECTIONS);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 180_000);

  it('SdkSeam_ZeroImportSitesResolved_FailsClosed', () => {
    // BLOCKING ARM — a census that resolves zero SDK import sites must FAIL.
    // Both generations are declared dependencies, so "nothing imports either
    // one" is a broken scan (relocated root, renamed seam, dead scanner), never
    // a clean tree.
    const empty = runSdkSeamCensus({
      sites: [],
      seamModulePresent: true,
      moduleCount: 400,
    });
    expect(empty.ok).toBe(false);
    expect(empty.siteCount).toBe(0);
    expect(empty.diagnostics.map((d) => d.code)).toContain('EMPTY_SDK_IMPORT_DENOMINATOR');

    // NEGATIVE TWIN — the live tree, walked for real, resolves a non-empty
    // population and the census is GREEN. The seam it kills: "the census fails
    // on everything, so its rejection above says nothing about emptiness."
    const scan = scanLiveTree();
    expect(scan.sites.length).toBeGreaterThan(0);
    // The population is checked independently of the hits (task 062): once the
    // migration completes, a low site count stops being evidence of a live scan.
    expect(scan.moduleCount).toBeGreaterThan(50);
    const live = runSdkSeamCensus(scan);
    expect(
      live.diagnostics.map((d) => d.message),
      'The live-tree census must be green; a failure here means the seam moved, ' +
        'stopped importing the SDK, or lost a generation.',
    ).toEqual([]);
    expect(live.ok).toBe(true);

    // The seam is a real subject, and the migration backlog task 053 owns is
    // measured rather than assumed.
    expect(live.seamSiteCount).toBeGreaterThan(0);
    expect(live.bypassSiteCount).toBeGreaterThan(0);

    // Second authority: every generation npm was asked to install must be one
    // the seam actually draws from. `package.json` cannot be derived from the
    // rule module, so the two can genuinely disagree.
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

  it('SdkSeamCensus_SeamMovedOrRenamed_FailsClosed', () => {
    // The other half of "a moved or renamed module cannot pass as a clean
    // tree": sites resolve fine, but the seam itself is gone.
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
    });
    expect(moved.ok).toBe(false);
    expect(moved.diagnostics.map((d) => d.code)).toContain('SDK_SEAM_MODULE_MISSING');

    // Present but drawing from nothing is a seam in name only.
    const hollow = runSdkSeamCensus({
      sites: [site],
      seamModulePresent: true,
      moduleCount: 400,
    });
    expect(hollow.ok).toBe(false);
    expect(hollow.diagnostics.map((d) => d.code)).toContain('SEAM_IMPORTS_NO_SDK');
  });

  it('SdkSeamCensus_SeamDropsOneGeneration_ReportsUncovered', () => {
    // Half the brand rotting while the seam still reads as present is the
    // failure mode a bare "the seam exists" check cannot see.
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
    });
    expect(result.ok).toBe(false);
    const uncovered = result.diagnostics.filter((d) => d.code === 'SEAM_GENERATION_UNCOVERED');
    expect(uncovered.map((d) => (d.code === 'SEAM_GENERATION_UNCOVERED' ? d.generation : ''))).toEqual([
      'v2',
    ]);
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

  it('IsOwnedSeamModule_AbsoluteRelativeAndWindowsPaths_AllResolve', () => {
    expect(isOwnedSeamModule(SDK_SEAM_MODULE)).toBe(true);
    expect(isOwnedSeamModule(`src/${SDK_SEAM_MODULE}`)).toBe(true);
    expect(isOwnedSeamModule(`/repo/servers/exarchos-mcp/src/${SDK_SEAM_MODULE}`)).toBe(true);
    expect(isOwnedSeamModule('C:\\repo\\servers\\exarchos-mcp\\src\\sdk\\seam.ts')).toBe(true);

    // Near-misses must NOT be exempt — the exemption is one module, not a family.
    expect(isOwnedSeamModule('src/sdk/brand.ts')).toBe(false);
    expect(isOwnedSeamModule('src/sdk/seam.test.ts')).toBe(false);
    expect(isOwnedSeamModule('src/adapters/seam.ts')).toBe(false);
  });

  it('LintSdkGenerationMixing_OwnedSeamOnly_IsExemptFromMixing', () => {
    const mixed = importFrom(v1Specifier('inMemory.js')) + importFrom(v2Specifier('server'));

    // The seam holds both generations by design — that IS "sole importer".
    expect(
      lintSdkGenerationMixing(`src/${SDK_SEAM_MODULE}`, mixed, parseModuleSpecifiers),
    ).toEqual([]);

    // Any other module holding both is still a HIGH finding. The exemption is
    // not a hole: it is one named path, and the very next module over fails.
    const findings = lintSdkGenerationMixing(
      'src/adapters/mcp.ts',
      mixed,
      parseModuleSpecifiers,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('HIGH');
  });
});

// ─── Live-tree scan ─────────────────────────────────────────────────────────

/**
 * Walk the shipped source and attribute every SDK import. The population is
 * derived from the filesystem, never enumerated, so a relocated tree shows up as
 * an empty denominator instead of a clean pass.
 *
 * NO SELF-EXCEPTION (task 062). This walk used to skip its own file. That
 * exception existed because the superseded specifier matcher could not tell a
 * fixture string from an import, so a test file that merely NAMES both
 * generations polluted the census — and this file's runtime specifier assembly
 * was the belt to that exception's braces. The parse makes both unnecessary:
 * every `.ts` under `src/` is now scanned on the same terms, including this one.
 */
function scanLiveTree(): {
  sites: SdkImportSite[];
  seamModulePresent: boolean;
  moduleCount: number;
} {
  const sites: SdkImportSite[] = [];
  let moduleCount = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      moduleCount += 1;
      const module = path.relative(srcRoot, full).split(path.sep).join('/');
      sites.push(
        ...collectSdkImportSites(
          module,
          fs.readFileSync(full, 'utf8'),
          parseModuleSpecifiers,
        ),
      );
    }
  };
  walk(srcRoot);
  return {
    sites,
    seamModulePresent: fs.existsSync(path.join(srcRoot, ...SDK_SEAM_MODULE.split('/'))),
    moduleCount,
  };
}
