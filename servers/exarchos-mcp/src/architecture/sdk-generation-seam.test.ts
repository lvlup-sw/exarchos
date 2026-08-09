// ─── DR-0 — MCP SDK generation seam ────────────────────────────────────────
//
// Guards the v1/v2 side-by-side install (task 049). See the module docblock in
// `sdk-generation-seam.ts` for the full rationale; the short version is that
// the plan's stated error-path criterion — "a partially-migrated tree must
// fail typecheck" — does not hold, so the rejection is implemented as a lint
// instead of merely asserted about the compiler.

/**
 * DR-30 authorities. The corpus sweep below is cross-checked against two
 * independent sources, neither derived from the other:
 *
 *   • `./sdk-generation-seam.ts` — the RULE: which package names constitute
 *     the v1 and v2 generations.
 *   • `../../package.json` — the INSTALLED REALITY: which generations npm was
 *     actually asked to resolve. A rule naming a package nobody depends on,
 *     or a dependency the rule cannot classify, is a disagreement between
 *     these two and shows up as a failure rather than a silent pass.
 *
 * @oracle-sources: ./sdk-generation-seam.ts, ../../package.json
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
} from './sdk-generation-seam.js';
import { parseModuleSpecifiers } from '../test-helpers/module-specifier-parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/architecture → servers/exarchos-mcp
const packageRoot = path.join(here, '..', '..');
/** This file — the lint's own fixture corpus, and task 062's kill subject. */
const selfPath = fileURLToPath(import.meta.url);

// ── The superseded scanner, retained as EVIDENCE ─────────────────────────────
//
// Task 062 replaced a raw-text specifier match with a real parse. A test that
// only asserts the new behaviour ("0 sites here") proves the defect is gone but
// says nothing about how large it was — and DR-26's whole problem was its SIZE,
// because ten uncountable sites floored task 053's migration denominator above
// zero. So the predecessor is kept here, in the test, and both numbers are
// asserted. It is the only artefact that can still measure the gap.
//
// It must never be exported or moved back into shipped source.
const SUPERSEDED_SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** What `collectSdkImports` counted in `source` BEFORE task 062. */
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

// ── Fixture specifiers added by task 062 are ASSEMBLED, never written literally
//
// `CollectSdkImports_LintOwnFixture_DropsFromTenToZero` pins this file's
// superseded count at exactly TEN — the number task 061 measured and the number
// the spec records as the entire 56 → 46 delta in task 053's backlog. A new
// fixture containing a literal `from '@modelcontextprotocol/…'` would raise it
// and silently rewrite the historical measurement into something unfalsifiable.
// Assembling the specifier keeps the count at ten while still producing source
// text in which a real, literal specifier sits inside a template literal — which
// is what the parser is actually being tested against. `sdk/seam.test.ts` adopted
// the same discipline for the same reason.
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
  it('MixedV1V2Imports_AreRejectedByTheGate', () => {
    // A module importing both generations is a HIGH finding, which is what makes
    // a partially-migrated tree fail the build rather than compile into two live
    // copies of the protocol.
    //
    // This assertion reads the fixture as TEXT, through the specifier lexer, so
    // it stands whether or not either package is installed.
    //
    // A second part used to live here: it compiled this same fixture and recorded
    // that `tsc` ACCEPTED the mix — the measured premise justifying why the lint
    // must exist at all, since v1's `Transport` was structurally assignable to
    // v2's and TypeScript has no notion of nominal package identity. That premise
    // is no longer constructible. v1 is gone from the manifests and the lockfile,
    // so on a clean install the fixture's v1 specifier does not resolve and `tsc`
    // fails for a RESOLUTION reason, not a brand one. Keeping the check would have
    // pinned a true-looking assertion to a false cause; re-adding v1 as a test-only
    // dependency to keep measuring it would undo the removal. The rung-2 guarantee
    // now rests on the cross-generation vs same-generation brand fixtures below,
    // which are the stronger proof and do not depend on v1 existing.
    const findings = lintSdkGenerationMixing(
      'src/adapters/mcp.ts',
      MIXED_IMPORT_FIXTURE,
      parseModuleSpecifiers,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('HIGH');
    expect(findings[0]!.source).toBe('sdk-generation-seam');
    expect(findings[0]!.file).toBe('src/adapters/mcp.ts');
    // The message must name both offending generations so the fix is obvious
    // from CI output alone.
    expect(findings[0]!.message).toContain('@modelcontextprotocol/sdk/inMemory.js');
    expect(findings[0]!.message).toContain('@modelcontextprotocol/server');

  });

  it('ClassifySdkImport_EachGenerationRoot_ResolvesToItsGeneration', () => {
    // v1 root + subpaths.
    expect(classifySdkImport('@modelcontextprotocol/sdk')).toBe('v1');
    expect(classifySdkImport('@modelcontextprotocol/sdk/server/mcp.js')).toBe('v1');
    expect(classifySdkImport('@modelcontextprotocol/sdk/inMemory.js')).toBe('v1');
    expect(
      classifySdkImport('@modelcontextprotocol/sdk/experimental/tasks/interfaces.js'),
    ).toBe('v1');

    // v2 roots + subpaths.
    expect(classifySdkImport('@modelcontextprotocol/core')).toBe('v2');
    expect(classifySdkImport('@modelcontextprotocol/server')).toBe('v2');
    expect(classifySdkImport('@modelcontextprotocol/server/stdio')).toBe('v2');
    expect(classifySdkImport('@modelcontextprotocol/client')).toBe('v2');

    // Unrelated specifiers are not SDK imports at all.
    expect(classifySdkImport('zod')).toBeUndefined();
    expect(classifySdkImport('./mcp.js')).toBeUndefined();
    // A same-prefix but distinct package must not be mistaken for v1.
    expect(classifySdkImport('@modelcontextprotocol/sdk-extras')).toBeUndefined();
  });

  it('CollectSdkImports_StaticDynamicAndTypeOnly_AreAllSeen', () => {
    // The migration hazard does not care how the module is pulled in, so the
    // scanner must see static imports, type-only imports, dynamic import()
    // and re-exports alike. `adapters/cli.ts` reaches the SDK through a
    // dynamic import, so missing that form would leave a real hole.
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

  it('LintSdkGenerationMixing_SingleGenerationModule_IsAllowed', () => {
    // Directory-by-directory migration REQUIRES that a wholly-v1 module and a
    // wholly-v2 module both pass. Only the mixture is an error.
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

  it('LintSdkGenerationMixing_RepoSources_AreNotYetMixed', () => {
    // Whole-tree sweep: no module in the package may straddle the two
    // generations. Today every module is still v1-only (the migration is
    // blocked on v2's removal of the Tasks store seam), so this passes
    // trivially — but it is the assertion that will catch the first bad
    // directory-by-directory step when the migration does start.
    //
    // NO SELF-EXCEPTION (task 062). This sweep used to skip THIS file, because
    // under the superseded text match its fixture strings read as a module
    // importing both generations — the guard flagged its own test material. The
    // exception is gone: a specifier inside a template literal is not an import
    // node, so this file is now swept like every other and contributes nothing.
    // Deleting an exception is stronger evidence than asserting one is unused,
    // because the sweep would fail if the claim were wrong.
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

    // Non-vacuity: an empty sweep would report zero offenders and read green.
    expect(scanned).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });

  it('ClassifySdkImport_EveryInstalledMcpDependency_IsClassifiable', () => {
    // The second DR-30 authority: cross-check the RULE (which package names
    // this module treats as v1/v2) against the INSTALLED REALITY
    // (package.json). These are independent — package.json does not import
    // the rule, and the rule does not read package.json — so they can
    // genuinely disagree.
    //
    // The disagreement worth catching: a new `@modelcontextprotocol/*`
    // dependency lands and the rule silently ignores it, leaving a whole
    // package outside the mixing gate.
    const pkgRaw: unknown = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(typeof pkgRaw === 'object' && pkgRaw !== null).toBe(true);
    const deps = (pkgRaw as { dependencies?: Record<string, string> }).dependencies ?? {};

    const mcpDeps = Object.keys(deps).filter((n) =>
      n.startsWith('@modelcontextprotocol/'),
    );
    // Non-vacuity: if this ever reads empty, the assertions below prove nothing.
    expect(mcpDeps.length).toBeGreaterThan(0);

    const unclassifiable = mcpDeps.filter((n) => classifySdkImport(n) === undefined);
    expect(
      unclassifiable,
      'These @modelcontextprotocol/* dependencies are installed but the ' +
        'generation rule does not recognise them, so modules importing them ' +
        'escape the mixing gate. Add them to V1_PACKAGE / V2_PACKAGES.',
    ).toEqual([]);

    // ── THE ALONGSIDE-INSTALL HAS ENDED (task 049) ──────────────────────────
    // The previous revision asserted `['v1', 'v2']` and said the milestone
    // "must be an explicit, reviewed edit here". This is that edit: DR-0's
    // source migration completed, nothing imports v1, and the dependency was
    // removed. The tree is single-generation.
    //
    // The assertion is kept EXACT (`toEqual`) rather than loosened to "contains
    // v2". An exact expectation is what made the v1 removal visible here in the
    // first place, and the same tooth now catches the opposite mistake — a v1
    // dependency creeping back in via a transitive hoist or a reverted lockfile
    // would fail this immediately instead of quietly restoring the two-
    // generation hazard the seam's brand exists to police.
    const generations = new Set(mcpDeps.map((n) => classifySdkImport(n)));
    expect(
      [...generations].sort(),
      'The installed MCP generation set changed. Task 049 left this tree on v2 ' +
        'alone; a v1 entry reappearing is the alongside-install returning ' +
        'unreviewed, and a v2 entry disappearing means the server has no SDK.',
    ).toEqual(['v2']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DR-26 / task 062 — the scanner measures imports, not text
// ════════════════════════════════════════════════════════════════════════════

describe('DR-26 — collectSdkImports resolves imports, not text', () => {
  it('CollectSdkImports_SpecifierInsideTemplateLiteral_IsNotAnImportSite', () => {
    // BLOCKING ARM — one real import, and the SAME specifier repeated in every
    // non-import position a lint fixture actually uses: a template literal, a
    // line comment, a block comment and a plain string. Only the first is an
    // import site.
    //
    // The template-literal arm is the one that mattered. Every lint fixture in
    // this package is written as a template literal, which is precisely why the
    // superseded matcher's blind spot landed on the guard's own test corpus
    // rather than somewhere harmless.
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
    // The line is the real import's, not an offset inherited from a decoy.
    expect(found.map((f) => f.line)).toEqual([1]);

    // NEGATIVE TWIN — the superseded matcher counts ALL FIVE against the same
    // input. Without this arm the test above would also pass against a scanner
    // that simply stopped recognising these specifiers at all, which is the
    // failure mode a "0 sites" assertion cannot distinguish from a fix.
    expect(supersededCollectSdkImports(source)).toEqual([
      real,
      inTemplate,
      inLineComment,
      inBlockComment,
      inString,
    ]);
  });

  it('CollectSdkImports_LintOwnFixture_DropsFromTenToZero', () => {
    // THE KILL FIXTURE. The subject is this file: the lint's own corpus, which
    // embeds SDK specifiers as *test input* and imports the SDK not at all.
    //
    // Both numbers are asserted on purpose. `0` alone proves only that the
    // defect is absent; `10` is the defect's SIZE, and the size is the whole
    // reason task 062 blocks task 053 — those ten phantom sites are the entire
    // difference between the 56/24/10 backlog task 052 published and the
    // 46/23/9 task 061 re-derived by parsing.
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

    // And therefore it is not a bypass site at all: the census attributes it
    // nowhere, which is what unfloors the migration denominator.
    expect(collectSdkImportSites(
      'architecture/sdk-generation-seam.test.ts',
      selfSource,
      parseModuleSpecifiers,
    )).toEqual([]);
  });

  it('CollectSdkImports_ZeroModulesResolved_FailsClosed', () => {
    // BLOCKING ARM — a scan that visited no modules must FAIL, even when the
    // sites it carries look fine. This is the tooth that survives task 053:
    // once the migration completes, a low bypass count stops being evidence of
    // anything, so the POPULATION has to be checked independently of the hits.
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

    // NEGATIVE TWIN — the identical scan with a real population is GREEN. The
    // seam it kills: "the census rejects everything, so its rejection above says
    // nothing about emptiness."
    const populated = runSdkSeamCensus({
      sites: [seamSite, v2SeamSite],
      seamModulePresent: true,
      moduleCount: 1,
      installedGenerations: ['v1', 'v2'],
    });
    expect(populated.diagnostics).toEqual([]);
    expect(populated.ok).toBe(true);

    // The sibling tooth is still distinct: modules WERE visited, but the parser
    // resolved nothing. That is a broken scanner, not a clean tree.
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

  it('BypassSiteCount_MigratedTree_CanReachZero', () => {
    // The property task 053 depends on, asserted directly: a tree in which
    // every real import has moved behind the seam reports bypassSiteCount === 0
    // AND passes.
    //
    // The tree is not synthetic where it matters. Its non-seam module is THIS
    // FILE, read from disk — the one module that can never be migrated, because
    // its SDK specifiers are the lint's own fixture text and must stay exactly
    // where they are. That is what made zero unreachable before task 062, so it
    // is the module the proof has to include.
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

    // THE ARITHMETIC FLOOR, measured. Feed the SAME migrated tree through the
    // superseded matcher and the bypass count is ten, not zero — task 053 would
    // have been driving a number toward a target it could not reach no matter
    // how much real migration it did. This is the assertion that makes "can
    // reach zero" a claim about the defect rather than a tautology about a
    // hand-built scan.
    expect(supersededCollectSdkImports(selfSource).length).toBe(10);
    expect(supersededCollectSdkImports(seamSource).length).toBe(2);
  });
});
