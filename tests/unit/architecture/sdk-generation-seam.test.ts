// Tests for the MCP SDK generation lint and the import-site census.
//
// TypeScript accepts a module that mixes the two SDK generations, so a lint rejects the mix.
// The module docblock of `sdk-generation-seam.ts` gives the rationale.

/**
 * The corpus sweep checks two independent sources against each other.
 * `sdk-generation-seam.ts` holds the rule: the package names of the v1 and v2 generations.
 * `package.json` holds the generations that npm installs.
 * A dependency that the rule cannot classify fails a test.
 *
 * @oracle-sources: ../../../src/architecture/sdk-generation-seam.ts, ../../../package.json
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SDK_SEAM_MODULE,
  classifySdkImport,
  collectSdkImports,
  collectSdkImportSites,
  lintSdkGenerationMixing,
  runSdkSeamCensus,
  type SdkImportSite,
} from '../../../src/architecture/sdk-generation-seam.js';
import { parseModuleSpecifiers } from '../../../tools/test-helpers/module-specifier-parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The repository root. */
const packageRoot = path.join(here, '../../..');
/** This file. It is the fixture corpus of the lint and the subject of the kill fixture. */
const selfPath = fileURLToPath(import.meta.url);

/**
 * The superseded raw-text specifier match, kept as evidence. The shipped scanner parses the source.
 * A test of the parser alone shows that the defect is gone, but not its size.
 * This regex still measures the size, so the tests assert both counts.
 * Do not export it, and do not move it into shipped source.
 */
const SUPERSEDED_SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** Returns the SDK specifiers that the superseded text match counts in `source`. */
function supersededCollectSdkImports(source: string): string[] {
  SUPERSEDED_SPECIFIER_RE.lastIndex = 0;
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = SUPERSEDED_SPECIFIER_RE.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    if (classifySdkImport(specifier) === undefined) continue;
    out.push(specifier);
  }
  return out;
}

/**
 * The scope of the MCP SDK packages. The helpers that follow assemble fixture specifiers from it.
 * `CollectSdkImports_LintOwnFixture_DropsFromTenToZero` pins the superseded count of this file at ten.
 * A new literal SDK specifier in an import statement of a fixture raises that count.
 * An assembled specifier keeps the count at ten, and the source text under test still holds a literal specifier.
 */
const SCOPE = '@modelcontextprotocol';
const v1Spec = (subpath: string): string => `${SCOPE}/sdk/${subpath}`;
const v2Spec = (subpath: string): string => `${SCOPE}/${subpath}`;
const q = (specifier: string): string => `'${specifier}'`;

/**
 * A module that draws an `InMemoryTransport` from BOTH generations and links
 * the halves across packages. This is the documented v2 footgun: the two
 * halves are not actually connected to each other.
 */
const MIXED_IMPORT_FIXTURE = `
import { InMemoryTransport as V1InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InMemoryTransport as V2InMemoryTransport, McpServer } from '@modelcontextprotocol/server';

export async function crossGenerationPair(): Promise<void> {
  const [v1ClientSide] = V1InMemoryTransport.createLinkedPair();
  const [, v2ServerSide] = V2InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: 'probe', version: '1.0.0' });
  await server.connect(v2ServerSide);
  await v1ClientSide.start();
}
`;

describe('DR-0 — MCP SDK generation seam', () => {
  /**
   * A module that imports both generations is a HIGH finding, so a partly migrated tree fails the build.
   * The lint reads the fixture as text through the specifier parser, so the test does not need an installed package.
   * The message must name both specifiers, so the CI output alone shows the fix.
   */
  it('MixedV1V2Imports_AreRejectedByTheGate', () => {
    const findings = lintSdkGenerationMixing(
      'src/adapters/mcp/mcp.ts',
      MIXED_IMPORT_FIXTURE,
      parseModuleSpecifiers,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('HIGH');
    expect(findings[0]!.source).toBe('sdk-generation-seam');
    expect(findings[0]!.file).toBe('src/adapters/mcp/mcp.ts');
    expect(findings[0]!.message).toContain('@modelcontextprotocol/sdk/inMemory.js');
    expect(findings[0]!.message).toContain('@modelcontextprotocol/server');

  });

  /** A distinct package that only shares the v1 name as a prefix is not v1. */
  it('ClassifySdkImport_EachGenerationRoot_ResolvesToItsGeneration', () => {
    expect(classifySdkImport('@modelcontextprotocol/sdk')).toBe('v1');
    expect(classifySdkImport('@modelcontextprotocol/sdk/server/mcp.js')).toBe('v1');
    expect(classifySdkImport('@modelcontextprotocol/sdk/inMemory.js')).toBe('v1');
    expect(
      classifySdkImport('@modelcontextprotocol/sdk/experimental/tasks/interfaces.js'),
    ).toBe('v1');

    expect(classifySdkImport('@modelcontextprotocol/core')).toBe('v2');
    expect(classifySdkImport('@modelcontextprotocol/server')).toBe('v2');
    expect(classifySdkImport('@modelcontextprotocol/server/stdio')).toBe('v2');
    expect(classifySdkImport('@modelcontextprotocol/client')).toBe('v2');

    expect(classifySdkImport('zod')).toBeUndefined();
    expect(classifySdkImport('./mcp.js')).toBeUndefined();
    expect(classifySdkImport('@modelcontextprotocol/sdk-extras')).toBeUndefined();
  });

  /**
   * The hazard does not depend on the import form.
   * The scanner must see static, type-only, dynamic and re-export forms.
   */
  it('CollectSdkImports_StaticDynamicAndTypeOnly_AreAllSeen', () => {
    const source = `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Task } from '@modelcontextprotocol/sdk/types.js';
export { Client } from '@modelcontextprotocol/client';
const mod = await import('@modelcontextprotocol/server/stdio');
`;
    const found = collectSdkImports(source, parseModuleSpecifiers);
    expect(found.map((f) => f.specifier)).toEqual([
      '@modelcontextprotocol/sdk/server/mcp.js',
      '@modelcontextprotocol/sdk/types.js',
      '@modelcontextprotocol/client',
      '@modelcontextprotocol/server/stdio',
    ]);
    expect(found.map((f) => f.generation)).toEqual(['v1', 'v1', 'v2', 'v2']);
  });

  /** A module of one generation passes, v1 or v2. Only the mix is an error. */
  it('LintSdkGenerationMixing_SingleGenerationModule_IsAllowed', () => {
    const v1Only = `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
`;
    const v2Only = `
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import type { Tool } from '@modelcontextprotocol/core';
`;
    const noSdk = `import { z } from 'zod';`;

    expect(lintSdkGenerationMixing('a.ts', v1Only, parseModuleSpecifiers)).toEqual([]);
    expect(lintSdkGenerationMixing('b.ts', v2Only, parseModuleSpecifiers)).toEqual([]);
    expect(lintSdkGenerationMixing('c.ts', noSdk, parseModuleSpecifiers)).toEqual([]);
  });

  /**
   * The sweep covers each `.ts` file under `src`. No module can import both generations.
   * The floor on `scanned` keeps an empty sweep from a green result.
   */
  it('LintSdkGenerationMixing_RepoSources_AreNotYetMixed', () => {
    const offenders: string[] = [];
    let scanned = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
        } else if (entry.name.endsWith('.ts')) {
          scanned += 1;
          const findings = lintSdkGenerationMixing(
            full,
            fs.readFileSync(full, 'utf8'),
            parseModuleSpecifiers,
          );
          if (findings.length > 0) offenders.push(path.relative(packageRoot, full));
        }
      }
    };
    walk(path.join(packageRoot, 'src'));

    expect(scanned).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });

  /**
   * The test checks the rule against `package.json`. Neither source reads the other, so they can disagree.
   * A new `@modelcontextprotocol` dependency that the rule ignores leaves a package outside the mixing gate.
   * The floor on `mcpDeps` keeps the assertions from an empty input.
   * The generation set is exact: the tree holds v2 alone, and a v1 dependency that returns fails the test.
   */
  it('ClassifySdkImport_EveryInstalledMcpDependency_IsClassifiable', () => {
    const pkgRaw: unknown = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(typeof pkgRaw === 'object' && pkgRaw !== null).toBe(true);
    const deps = (pkgRaw as { dependencies?: Record<string, string> }).dependencies ?? {};

    const mcpDeps = Object.keys(deps).filter((n) =>
      n.startsWith('@modelcontextprotocol/'),
    );
    expect(mcpDeps.length).toBeGreaterThan(0);

    const unclassifiable = mcpDeps.filter((n) => classifySdkImport(n) === undefined);
    expect(
      unclassifiable,
      'These @modelcontextprotocol/* dependencies are installed but the ' +
        'generation rule does not recognise them, so modules importing them ' +
        'escape the mixing gate. Add them to V1_PACKAGE / V2_PACKAGES.',
    ).toEqual([]);

    const generations = new Set(mcpDeps.map((n) => classifySdkImport(n)));
    expect(
      [...generations].sort(),
      'The installed MCP generation set changed. Task 049 left this tree on v2 ' +
        'alone; a v1 entry reappearing is the alongside-install returning ' +
        'unreviewed, and a v2 entry disappearing means the server has no SDK.',
    ).toEqual(['v2']);
  });
});

describe('DR-26 — collectSdkImports resolves imports, not text', () => {
  /**
   * BLOCKING ARM: the source holds one real import and four SDK specifiers in non-import positions.
   * The positions are a template literal, a line comment, a block comment and a plain string.
   * Only the real import is an import site, and the reported line is its line.
   * NEGATIVE TWIN: the superseded matcher counts all five specifiers in the same input.
   * The twin shows that each decoy is a valid SDK specifier, so only its position keeps it out.
   */
  it('CollectSdkImports_SpecifierInsideTemplateLiteral_IsNotAnImportSite', () => {
    const real = v1Spec('server/mcp.js');
    const inTemplate = v1Spec('inMemory.js');
    const inLineComment = v2Spec('server');
    const inBlockComment = v2Spec('core');
    const inString = v1Spec('types.js');

    const source = [
      `import { McpServer } from ${q(real)};`,
      '',
      'const FIXTURE = `',
      `import { InMemoryTransport } from ${q(inTemplate)};`,
      '`;',
      '',
      `// import { X } from ${q(inLineComment)};`,
      `/* export * from ${q(inBlockComment)}; */`,
      `const note = "see also: import x from ${q(inString)}";`,
      'void FIXTURE; void note;',
    ].join('\n');

    const found = collectSdkImports(source, parseModuleSpecifiers);
    expect(found.map((f) => f.specifier)).toEqual([real]);
    expect(found.map((f) => f.generation)).toEqual(['v1']);
    expect(found.map((f) => f.line)).toEqual([1]);

    expect(supersededCollectSdkImports(source)).toEqual([
      real,
      inTemplate,
      inLineComment,
      inBlockComment,
      inString,
    ]);
  });

  /**
   * The kill fixture. The subject is this file, which holds SDK specifiers as test input and imports no SDK package.
   * The test asserts both counts: zero shows that the defect is absent, and ten is the size of the defect.
   * The census attributes no site to this file, so the file is not a bypass site.
   */
  it('CollectSdkImports_LintOwnFixture_DropsFromTenToZero', () => {
    const selfSource = fs.readFileSync(selfPath, 'utf8');

    expect(
      supersededCollectSdkImports(selfSource).length,
      'The superseded text matcher must still count TEN sites in this file. If ' +
        'this number moved, a fixture with a LITERAL @modelcontextprotocol ' +
        'specifier was added — assemble it instead (see v1Spec/v2Spec above), ' +
        'or the historical 56 → 46 correction recorded in the spec becomes ' +
        'unreproducible.',
    ).toBe(10);

    expect(
      collectSdkImports(selfSource, parseModuleSpecifiers).length,
      'This file imports no MCP SDK package. Every specifier in it is fixture ' +
        'text inside a template literal, a comment or a string.',
    ).toBe(0);

    expect(collectSdkImportSites(
      'architecture/sdk-generation-seam.test.ts',
      selfSource,
      parseModuleSpecifiers,
    )).toEqual([]);
  });

  /**
   * BLOCKING ARM: a scan that visited no modules must fail, even when its sites look correct.
   * In a migrated tree a low bypass count is no evidence, so the census checks the population separately.
   * NEGATIVE TWIN: the same scan with a real population passes, so the census does not reject everything.
   * The last arm is a different check: modules were visited, but the parser resolved no site.
   */
  it('CollectSdkImports_ZeroModulesResolved_FailsClosed', () => {
    const seamSite: SdkImportSite = {
      module: SDK_SEAM_MODULE,
      specifier: v1Spec('server/mcp.js'),
      generation: 'v1',
      line: 12,
      throughSeam: true,
    };
    const v2SeamSite: SdkImportSite = {
      module: SDK_SEAM_MODULE,
      specifier: v2Spec('server'),
      generation: 'v2',
      line: 13,
      throughSeam: true,
    };

    const empty = runSdkSeamCensus({
      sites: [seamSite, v2SeamSite],
      seamModulePresent: true,
      moduleCount: 0,
      installedGenerations: ['v1', 'v2'],
    });
    expect(empty.ok).toBe(false);
    expect(empty.moduleCount).toBe(0);
    expect(empty.diagnostics.map((d) => d.code)).toContain('EMPTY_MODULE_POPULATION');

    const populated = runSdkSeamCensus({
      sites: [seamSite, v2SeamSite],
      seamModulePresent: true,
      moduleCount: 1,
      installedGenerations: ['v1', 'v2'],
    });
    expect(populated.diagnostics).toEqual([]);
    expect(populated.ok).toBe(true);

    const noSites = runSdkSeamCensus({
      sites: [],
      seamModulePresent: true,
      moduleCount: 400,
      installedGenerations: ['v1', 'v2'],
    });
    expect(noSites.ok).toBe(false);
    expect(noSites.diagnostics.map((d) => d.code)).toContain(
      'EMPTY_SDK_IMPORT_DENOMINATOR',
    );
  });

  /**
   * A tree with each real import behind the seam reports a bypass count of zero and passes.
   * The non-seam module is this file, read from disk. Its SDK specifiers are fixture text and must stay.
   * The superseded matcher counts ten sites in the same file, so a text match cannot reach zero.
   */
  it('BypassSiteCount_MigratedTree_CanReachZero', () => {
    const seamSource =
      `import { McpServer } from ${q(v1Spec('server/mcp.js'))};\n` +
      `import { InMemoryTransport } from ${q(v2Spec('server'))};\n`;
    const selfSource = fs.readFileSync(selfPath, 'utf8');

    const sites = [
      ...collectSdkImportSites(`src/${SDK_SEAM_MODULE}`, seamSource, parseModuleSpecifiers),
      ...collectSdkImportSites(
        'src/architecture/sdk-generation-seam.test.ts',
        selfSource,
        parseModuleSpecifiers,
      ),
    ];

    const census = runSdkSeamCensus({
      sites,
      seamModulePresent: true,
      moduleCount: 2,
      installedGenerations: ['v1', 'v2'],
    });

    expect(
      census.bypassSiteCount,
      'A fully migrated tree must be able to report ZERO bypass sites. If this ' +
        "is non-zero, the census is counting something that isn't an import.",
    ).toBe(0);
    expect(census.seamSiteCount).toBe(2);
    expect(census.diagnostics).toEqual([]);
    expect(census.ok).toBe(true);

    expect(supersededCollectSdkImports(selfSource).length).toBe(10);
    expect(supersededCollectSdkImports(seamSource).length).toBe(2);
  });
});
