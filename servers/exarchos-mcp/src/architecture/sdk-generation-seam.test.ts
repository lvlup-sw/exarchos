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
  classifySdkImport,
  collectSdkImports,
  lintSdkGenerationMixing,
} from './sdk-generation-seam.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/architecture → servers/exarchos-mcp
const packageRoot = path.join(here, '..', '..');

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
  it('MixedV1V2Imports_FailTypecheck', () => {
    // ── Part 1: the gate rejects the mixed module. ──────────────────────────
    //
    // This is the operative assertion. A module importing both generations is
    // a HIGH finding, which is what makes a partially-migrated tree fail the
    // build rather than compile into two live copies of the protocol.
    const findings = lintSdkGenerationMixing(
      'src/adapters/mcp.ts',
      MIXED_IMPORT_FIXTURE,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('HIGH');
    expect(findings[0]!.source).toBe('sdk-generation-seam');
    expect(findings[0]!.file).toBe('src/adapters/mcp.ts');
    // The message must name both offending generations so the fix is obvious
    // from CI output alone.
    expect(findings[0]!.message).toContain('@modelcontextprotocol/sdk/inMemory.js');
    expect(findings[0]!.message).toContain('@modelcontextprotocol/server');

    // ── Part 2: prove the gate is load-bearing. ─────────────────────────────
    //
    // The plan assumed `tsc` would reject this on its own. It does not — v1's
    // Transport is structurally assignable to v2's, and TypeScript has no
    // notion of nominal package identity. We compile the exact same fixture
    // under the package's own strict settings and record that it is accepted.
    //
    // If a future SDK release ever DOES make the two nominally incompatible,
    // this expectation flips and the failure is a welcome signal: the lint
    // could then be retired in favour of the compiler. Pinning the measured
    // reality is what keeps that decision evidence-based instead of assumed.
    const tmpDir = fs.mkdtempSync(path.join(packageRoot, '.tmp-sdk-seam-'));
    const fixturePath = path.join(tmpDir, 'mixed-imports.ts');
    try {
      fs.writeFileSync(fixturePath, MIXED_IMPORT_FIXTURE, 'utf8');

      let tscAccepted: boolean;
      try {
        execFileSync(
          process.execPath,
          [
            path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
            '--noEmit',
            '--strict',
            '--module',
            'NodeNext',
            '--moduleResolution',
            'NodeNext',
            '--target',
            'ES2022',
            '--lib',
            'ES2022',
            '--skipLibCheck',
            fixturePath,
          ],
          { cwd: packageRoot, stdio: 'pipe' },
        );
        tscAccepted = true;
      } catch {
        tscAccepted = false;
      }

      expect(
        tscAccepted,
        'Measured DR-0 finding: `tsc` accepts cross-generation MCP SDK mixing, ' +
          'which is precisely why lintSdkGenerationMixing must exist. If this ' +
          'now fails, the compiler rejects the mix on its own and the lint may ' +
          'be reconsidered.',
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

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
    const found = collectSdkImports(source);
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

    expect(lintSdkGenerationMixing('a.ts', v1Only)).toEqual([]);
    expect(lintSdkGenerationMixing('b.ts', v2Only)).toEqual([]);
    expect(lintSdkGenerationMixing('c.ts', noSdk)).toEqual([]);
  });

  it('LintSdkGenerationMixing_RepoSources_AreNotYetMixed', () => {
    // Whole-tree sweep: no module in the package may straddle the two
    // generations. Today every module is still v1-only (the migration is
    // blocked on v2's removal of the Tasks store seam), so this passes
    // trivially — but it is the assertion that will catch the first bad
    // directory-by-directory step when the migration does start.
    const offenders: string[] = [];
    // This file is the one legitimate exception: it embeds BOTH generations as
    // fixture text so the lint has something to reject. Scanning it would
    // flag the guard's own test material.
    const selfName = 'sdk-generation-seam.test.ts';
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
        } else if (entry.name.endsWith('.ts') && entry.name !== selfName) {
          const findings = lintSdkGenerationMixing(
            full,
            fs.readFileSync(full, 'utf8'),
          );
          if (findings.length > 0) offenders.push(path.relative(packageRoot, full));
        }
      }
    };
    walk(path.join(packageRoot, 'src'));

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

    // DR-0's premise: BOTH generations are installed side by side. If either
    // side disappears, the alongside-install has ended — which is a real
    // milestone (v1 removal) that must be an explicit, reviewed edit here.
    const generations = new Set(mcpDeps.map((n) => classifySdkImport(n)));
    expect([...generations].sort()).toEqual(['v1', 'v2']);
  });
});
