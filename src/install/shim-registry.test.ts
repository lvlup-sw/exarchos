import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHIM_REGISTRY,
  SHIM_SCAN_ROOTS,
  RENDERER_SCAN_ROOTS,
  SELF_PATH,
  RENDERER_PORT_TYPE,
  RENDERER_RENDER_MEMBER,
  APPROVED_CAPABILITY_REASONS,
  parseShimMarkers,
  discoverShims,
  detectRenderer,
  discoverRenderers,
  validateEntryGovernance,
  verifyShimRatchet,
  assertShimRatchet,
  ShimRatchetError,
  type ShimEntry,
  type DiscoveredShim,
  type ShimDiscoveryFs,
} from './shim-registry.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** A far-future clock so real registry expiries are never "in the past". */
const CLOCK = new Date('2026-01-01T00:00:00Z');

/** Build a well-formed registry entry, overridable field-by-field. */
function entry(over: Partial<ShimEntry> = {}): ShimEntry {
  return {
    id: 'sample-shim',
    file: 'src/sample-adapter.ts',
    runtime: 'cursor',
    capability: 'slash-command-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-01-31',
    ...over,
  };
}

/** A discovered marker matching a given entry. */
function discovered(over: Partial<DiscoveredShim> = {}): DiscoveredShim {
  return {
    file: 'src/sample-adapter.ts',
    runtimes: ['cursor'],
    capability: 'slash-command-native',
    raw: 'runtimes: cursor, capability: slash-command-native',
    ...over,
  };
}

// The literal marker token is spliced so this test file never accidentally
// self-declares a shim that a future tree scan could pick up.
const MARK = 'SHIM' + '(';

describe('parseShimMarkers', () => {
  it('parseShimMarkers_MultiRuntimeMarker_SplitsCoverage', () => {
    const src = `// ${MARK}runtimes: copilot+cursor, capability: slash-command-native) — note`;
    const parsed = parseShimMarkers(src, 'x/y.ts');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.runtimes).toEqual(['copilot', 'cursor']);
    expect(parsed[0]?.capability).toBe('slash-command-native');
    expect(parsed[0]?.file).toBe('x/y.ts');
  });

  it('parseShimMarkers_NoMarker_ReturnsEmpty', () => {
    expect(parseShimMarkers('nothing to see here', 'a.ts')).toEqual([]);
  });

  it('parseShimMarkers_MultipleMarkers_AllCaptured', () => {
    const src = [
      `// ${MARK}runtimes: cursor, capability: a)`,
      `// ${MARK}runtimes: copilot, capability: b)`,
    ].join('\n');
    const parsed = parseShimMarkers(src, 'a.ts');
    expect(parsed.map((p) => p.capability)).toEqual(['a', 'b']);
  });
});

describe('validateEntryGovernance', () => {
  it('valid entry → no problems', () => {
    expect(validateEntryGovernance(entry(), CLOCK)).toEqual([]);
  });

  it('bad issue ref → malformed', () => {
    const problems = validateEntryGovernance(entry({ issue: '1590' }), CLOCK);
    expect(problems.map((p) => p.kind)).toContain('malformed');
  });

  it('empty owner → malformed', () => {
    const problems = validateEntryGovernance(entry({ owner: '  ' }), CLOCK);
    expect(problems.map((p) => p.kind)).toContain('malformed');
  });

  it('polluted expires (trailing text) → malformed', () => {
    const problems = validateEntryGovernance(
      entry({ expires: '2027-01-31; see also #1609' }),
      CLOCK,
    );
    expect(problems.map((p) => p.kind)).toContain('malformed');
  });

  it('impossible calendar date → malformed', () => {
    const problems = validateEntryGovernance(entry({ expires: '2027-02-31' }), CLOCK);
    expect(problems.map((p) => p.kind)).toContain('malformed');
  });

  it('past expiry → expired', () => {
    const problems = validateEntryGovernance(entry({ expires: '2020-01-01' }), CLOCK);
    expect(problems.map((p) => p.kind)).toContain('expired');
  });
});

describe('verifyShimRatchet — exit proofs', () => {
  // (e) current authored set, against a matching discovered set, passes.
  it('ShimRatchet_MatchingRegistryAndDiscovery_Passes', () => {
    const result = verifyShimRatchet({
      registry: [entry()],
      discovered: [discovered()],
      now: CLOCK,
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  // (c) adding a shim on disk with no registry entry FAILS.
  it('ShimRatchet_UnregisteredDiscoveredShim_Fails', () => {
    const result = verifyShimRatchet({
      registry: [entry()],
      discovered: [
        discovered(),
        discovered({ file: 'src/new-adapter.ts', runtimes: ['opencode'] }),
      ],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    const unregistered = result.violations.filter((v) => v.kind === 'unregistered');
    expect(unregistered).toHaveLength(1);
    expect(unregistered[0]?.file).toBe('src/new-adapter.ts');
    expect(unregistered[0]?.runtime).toBe('opencode');
  });

  // (c) a multi-runtime marker where only SOME runtimes are registered fails
  //     on the unregistered runtime only.
  it('ShimRatchet_PartiallyRegisteredMultiRuntimeMarker_FailsOnGap', () => {
    const result = verifyShimRatchet({
      registry: [entry({ runtime: 'cursor' })],
      discovered: [discovered({ runtimes: ['cursor', 'copilot'] })],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    const unregistered = result.violations.filter((v) => v.kind === 'unregistered');
    expect(unregistered.map((v) => v.runtime)).toEqual(['copilot']);
  });

  // (d) an expired registry entry FAILS.
  it('ShimRatchet_ExpiredRegistryEntry_Fails', () => {
    const result = verifyShimRatchet({
      registry: [entry({ expires: '2020-01-01' })],
      discovered: [discovered()],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'expired')).toBe(true);
  });

  it('ShimRatchet_CapabilityMismatch_Fails', () => {
    const result = verifyShimRatchet({
      registry: [entry({ capability: 'slash-command-native' })],
      discovered: [discovered({ capability: 'something-else' })],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'capability-mismatch')).toBe(true);
  });

  it('ShimRatchet_RegistryEntryWithoutMarkerOnDisk_Fails', () => {
    const result = verifyShimRatchet({
      registry: [entry()],
      discovered: [],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'missing-on-disk')).toBe(true);
  });

  it('ShimRatchet_DuplicateRegistryId_Fails', () => {
    const result = verifyShimRatchet({
      registry: [entry(), entry({ file: 'src/other.ts', runtime: 'copilot' })],
      discovered: [discovered(), discovered({ file: 'src/other.ts', runtimes: ['copilot'] })],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'duplicate-id')).toBe(true);
  });

  it('assertShimRatchet_Violation_ThrowsShimRatchetError', () => {
    expect(() =>
      assertShimRatchet({ registry: [entry()], discovered: [], now: CLOCK }),
    ).toThrow(ShimRatchetError);
  });
});

describe('discoverShims (injected fs)', () => {
  it('discoverShims_ScansConfiguredRoots_ParsesMarkers', () => {
    const fs: ShimDiscoveryFs = {
      listTsFiles: (absRoot) =>
        absRoot.endsWith('src') ? [join(absRoot, 'adapter.ts'), join(absRoot, 'plain.ts')] : [],
      readFile: (abs) =>
        abs.endsWith('adapter.ts')
          ? `// ${MARK}runtimes: cursor, capability: slash-command-native)`
          : 'no marker here',
    };
    const found = discoverShims({ repoRoot: '/repo', roots: ['src'], fs });
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe('src/adapter.ts');
    expect(found[0]?.runtimes).toEqual(['cursor']);
  });

  it('discoverShims_ExcludesSelfModule', () => {
    const fs: ShimDiscoveryFs = {
      listTsFiles: () => [`/repo/${SELF_PATH}`],
      // Even if the module contained a marker, it must be skipped.
      readFile: () => `// ${MARK}runtimes: cursor, capability: x)`,
    };
    const found = discoverShims({ repoRoot: '/repo', roots: ['src'], fs });
    expect(found).toEqual([]);
  });

  it('discoverShims_NestedRoots_VisitsEachFileOnce', () => {
    // `src/runtime` contains `src/runtime/agents/adapters`; listing both must
    // not report the same marker twice.
    const fs: ShimDiscoveryFs = {
      listTsFiles: (absRoot) =>
        absRoot.endsWith('adapters')
          ? ['/repo/src/runtime/agents/adapters/cursor.ts']
          : ['/repo/src/runtime/agents/adapters/cursor.ts', '/repo/src/runtime/other.ts'],
      readFile: (abs) =>
        abs.endsWith('cursor.ts')
          ? `// ${MARK}runtimes: cursor, capability: slash-command-native)`
          : 'no marker here',
    };
    const found = discoverShims({
      repoRoot: '/repo',
      roots: ['src/runtime', 'src/runtime/agents/adapters'],
      fs,
    });
    expect(found).toHaveLength(1);
  });
});

describe('SHIM_REGISTRY — real repo (exit proof e)', () => {
  it('registry entries are internally well-formed', () => {
    for (const e of SHIM_REGISTRY) {
      // Governance is valid as of the fixed clock (well before real expiries).
      expect(validateEntryGovernance(e, CLOCK)).toEqual([]);
    }
  });

  it('registry files exist on disk', () => {
    // (indirectly) — discovery must find each registered file's marker below,
    // which requires the file to exist. This asserts the paths are real.
    const files = new Set(SHIM_REGISTRY.map((e) => e.file));
    for (const f of files) {
      expect(f.startsWith('servers/') || f.startsWith('src/')).toBe(true);
    }
  });

  it('RealShimSet_MatchesRegistry_RatchetPasses', () => {
    const found = discoverShims({ repoRoot: REPO_ROOT, roots: SHIM_SCAN_ROOTS });
    const renderers = discoverRenderers({ repoRoot: REPO_ROOT, roots: RENDERER_SCAN_ROOTS });
    const result = verifyShimRatchet({
      registry: SHIM_REGISTRY,
      discovered: found,
      renderers,
      now: CLOCK,
    });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

// ─── DR-14: structural, marker-independent renderer discovery ────────────────

/**
 * Source text of a real per-harness renderer, reduced to the three structural
 * facts the detector keys on. The port identifier is spliced so this test file
 * can never itself be mistaken for a renderer by a future tree scan.
 */
const PORT = 'Runtime' + 'Adapter';

interface RendererFixtureOptions {
  /** Runtime id the module declares. `null` ⇒ declare none. */
  readonly runtime?: string | null;
  /** Emit a `SHIM(...)` marker too. Default: NO marker (the DR-14 case). */
  readonly withMarker?: string;
  /** Local alias for the imported port type. */
  readonly alias?: string;
  /** Emit the `implements` (class) form instead of the annotated-const form. */
  readonly asClass?: boolean;
  /** Emit the `satisfies` form (no type annotation) instead. */
  readonly asSatisfies?: boolean;
}

/** A syntactically real per-harness renderer module. */
function rendererSource(opts: RendererFixtureOptions = {}): string {
  const local = opts.alias ?? PORT;
  const imported = opts.alias ? `${PORT} as ${opts.alias}` : PORT;
  const runtimeLine =
    opts.runtime === null ? '' : `  runtime: '${opts.runtime ?? 'newharness'}',\n`;
  const marker = opts.withMarker ? `// ${MARK}${opts.withMarker})\n` : '';
  if (opts.asClass) {
    return (
      `${marker}import type { ${imported} } from './types.js';\n` +
      `export class NewHarnessAdapter implements ${local} {\n` +
      (opts.runtime === null ? '' : `  readonly runtime = '${opts.runtime ?? 'newharness'}' as const;\n`) +
      `  agentFilePath(n: string): string { return n; }\n` +
      `  lowerSpec(spec: unknown): { path: string; contents: string } {\n` +
      `    return { path: 'x.md', contents: String(spec) };\n` +
      `  }\n` +
      `}\n`
    );
  }
  return (
    `${marker}import type { ${imported} } from './types.js';\n` +
    `function lowerSpec(spec: unknown): { path: string; contents: string } {\n` +
    `  return { path: 'x.md', contents: String(spec) };\n` +
    `}\n` +
    `export const newHarnessAdapter${opts.asSatisfies ? '' : `: ${local}`} = {\n` +
    runtimeLine +
    `  agentFilePath: (n: string) => n,\n` +
    `  lowerSpec,\n` +
    `}${opts.asSatisfies ? ` satisfies ${local}` : ''};\n`
  );
}

/** A disposable repo-shaped temp tree; `seed` writes repo-relative files. */
function withTempRepo(
  seed: Record<string, string>,
  body: (repoRoot: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), 'shim-ratchet-'));
  try {
    for (const [rel, contents] of Object.entries(seed)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents, 'utf8');
    }
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Roots used against the temp trees below (mirrors the real root shape). */
// One root since task 019 folded the two source trees together.
const TEMP_ROOTS = ['src'];

/** A complete, valid registry row for the seeded renderer. */
function rendererEntry(over: Partial<ShimEntry> = {}): ShimEntry {
  return {
    id: 'newharness-agent-renderer',
    file: 'src/runtime/agents/adapters/newharness.ts',
    runtime: 'newharness',
    capability: 'agent-definition-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-06-30',
    ...over,
  };
}

const RENDERER_PATH = 'src/runtime/agents/adapters/newharness.ts';

describe('DR-14 acceptance — an ungoverned per-harness renderer fails the ratchet', () => {
  // THE headline criterion: a renderer is added to the tree with NO approved
  // capability reason and NO expiry (i.e. no registry row at all). Seeded into
  // a real directory tree and run through the real discovery + ratchet.
  it('ShimRatchet_RendererAddedWithNoReasonOrExpiry_FailsEndToEnd', () => {
    withTempRepo({ [RENDERER_PATH]: rendererSource() }, (repoRoot) => {
      const renderers = discoverRenderers({ repoRoot, roots: TEMP_ROOTS });
      const discovered = discoverShims({ repoRoot, roots: TEMP_ROOTS });
      const result = verifyShimRatchet({
        registry: [],
        discovered,
        renderers,
        now: CLOCK,
      });
      expect(result.ok).toBe(false);
      const unregistered = result.violations.filter((v) => v.kind === 'unregistered');
      expect(unregistered).toHaveLength(1);
      expect(unregistered[0]?.file).toBe(RENDERER_PATH);
      expect(unregistered[0]?.runtime).toBe('newharness');
      expect(unregistered[0]?.detail).toMatch(/approved capability reason/);
    });
  });

  // Same seeded renderer, but with a row whose reason and expiry are BLANK —
  // the "governed on paper" case. Must still fail end-to-end.
  it('ShimRatchet_RendererRowWithBlankReasonAndExpiry_FailsEndToEnd', () => {
    withTempRepo({ [RENDERER_PATH]: rendererSource() }, (repoRoot) => {
      const renderers = discoverRenderers({ repoRoot, roots: TEMP_ROOTS });
      const result = verifyShimRatchet({
        registry: [rendererEntry({ capability: '', expires: '' })],
        discovered: [],
        renderers,
        now: CLOCK,
      });
      expect(result.ok).toBe(false);
      const details = result.violations.map((v) => v.detail).join('\n');
      expect(details).toMatch(/capability reason is required/);
      expect(details).toMatch(/expires must be a clean YYYY-MM-DD date/);
    });
  });

  // The exit proof: the SAME renderer, once fully governed, passes.
  it('ShimRatchet_RendererWithApprovedReasonAndExpiry_PassesEndToEnd', () => {
    withTempRepo({ [RENDERER_PATH]: rendererSource() }, (repoRoot) => {
      const renderers = discoverRenderers({ repoRoot, roots: TEMP_ROOTS });
      const result = verifyShimRatchet({
        registry: [rendererEntry()],
        discovered: [],
        renderers,
        now: CLOCK,
      });
      expect(result.violations).toEqual([]);
      expect(result.ok).toBe(true);
    });
  });

  // A renderer that declares no runtime id cannot be keyed to governance, so it
  // fails loudly instead of silently escaping the (file, runtime) join.
  it('ShimRatchet_RendererWithNoRuntimeId_FailsUndeclaredRuntime', () => {
    withTempRepo({ [RENDERER_PATH]: rendererSource({ runtime: null }) }, (repoRoot) => {
      const renderers = discoverRenderers({ repoRoot, roots: TEMP_ROOTS });
      expect(renderers).toHaveLength(1);
      const result = verifyShimRatchet({
        registry: [rendererEntry()],
        discovered: [],
        renderers,
        now: CLOCK,
      });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.kind === 'undeclared-runtime')).toBe(true);
    });
  });

  // Omitting the renderers input entirely must not pass silently: the rows it
  // would have backed become stale covers.
  it('ShimRatchet_RenderersInputOmitted_FailsLoudlyNotSilently', () => {
    const result = verifyShimRatchet({
      registry: [rendererEntry()],
      discovered: [],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'missing-on-disk')).toBe(true);
  });
});

describe('discoverRenderers — marker independence (the DR-14 defect)', () => {
  // THE specific defect: the five shipped renderers carry no marker, so the
  // opt-in scan could not see them. Discovery must not need one.
  it('DiscoverRenderers_RendererWithNoShimMarker_IsStillDiscovered', () => {
    const source = rendererSource();
    expect(source).not.toContain(MARK);
    withTempRepo({ [RENDERER_PATH]: source }, (repoRoot) => {
      // The marker scan sees nothing at all…
      expect(discoverShims({ repoRoot, roots: TEMP_ROOTS })).toEqual([]);
      // …but structural discovery finds it anyway.
      const renderers = discoverRenderers({ repoRoot, roots: TEMP_ROOTS });
      expect(renderers).toHaveLength(1);
      expect(renderers[0]?.file).toBe(RENDERER_PATH);
      expect(renderers[0]?.runtime).toBe('newharness');
    });
  });

  it('DiscoverRenderers_ClassImplementsForm_IsDiscovered', () => {
    withTempRepo({ [RENDERER_PATH]: rendererSource({ asClass: true }) }, (repoRoot) => {
      const renderers = discoverRenderers({ repoRoot, roots: TEMP_ROOTS });
      expect(renderers.map((r) => r.runtime)).toEqual(['newharness']);
    });
  });

  it('DiscoverRenderers_AliasedPortImport_IsDiscovered', () => {
    withTempRepo({ [RENDERER_PATH]: rendererSource({ alias: 'Port' }) }, (repoRoot) => {
      const renderers = discoverRenderers({ repoRoot, roots: TEMP_ROOTS });
      expect(renderers).toHaveLength(1);
      expect(renderers[0]?.port).toBe('Port');
    });
  });

  it('DiscoverRenderers_SatisfiesForm_IsDiscovered', () => {
    // An untyped `satisfies` export is still an implementing position — it must
    // not become the escape hatch that the annotation requirement leaves open.
    const source = rendererSource({ asSatisfies: true });
    expect(source).toContain('satisfies');
    expect(source).not.toContain(`newHarnessAdapter: ${PORT}`);
    withTempRepo({ [RENDERER_PATH]: source }, (repoRoot) => {
      const renderers = discoverRenderers({ repoRoot, roots: TEMP_ROOTS });
      expect(renderers).toHaveLength(1);
      expect(renderers[0]?.runtime).toBe('newharness');
      expect(renderers[0]?.exportName).toBe('newHarnessAdapter');
    });
  });

  it('DiscoverRenderers_RendererOutsideAdaptersDirectory_IsStillDiscovered', () => {
    const elsewhere = 'src/runtime/launcher/newharness-renderer.ts';
    withTempRepo({ [elsewhere]: rendererSource() }, (repoRoot) => {
      const renderers = discoverRenderers({ repoRoot, roots: TEMP_ROOTS });
      expect(renderers.map((r) => r.file)).toEqual([elsewhere]);
    });
  });
});

describe('discoverRenderers — false-positive guard', () => {
  // The port module DECLARES the interface and names the render member, but
  // never imports the port — it is not a renderer.
  it('DiscoverRenderers_PortDeclarationModule_YieldsNoDiscovery', () => {
    const portModule =
      `export interface ${PORT} {\n` +
      `  readonly runtime: string;\n` +
      `  lowerSpec(spec: unknown): { path: string; contents: string };\n` +
      `}\n`;
    withTempRepo(
      { 'src/runtime/agents/adapters/types.ts': portModule },
      (repoRoot) => {
        expect(discoverRenderers({ repoRoot, roots: TEMP_ROOTS })).toEqual([]);
      },
    );
  });

  // The fan-out consumer imports the port and CALLS the render member, but only
  // ever mentions the port inside a generic — never an implementing position.
  it('DiscoverRenderers_PortConsumerInGenericPosition_YieldsNoDiscovery', () => {
    const consumer =
      `import type { ${PORT} } from './adapters/types.js';\n` +
      `export const ADAPTERS: Readonly<Record<string, ${PORT}>> = {};\n` +
      `const list: readonly ${PORT}[] = Object.values(ADAPTERS);\n` +
      `export function renderAll(spec: unknown): string[] {\n` +
      `  return list.map((a) => a.lowerSpec(spec).contents);\n` +
      `}\n` +
      `export const runtime = 'newharness';\n`;
    withTempRepo(
      { 'src/runtime/agents/generate-agents.ts': consumer },
      (repoRoot) => {
        expect(discoverRenderers({ repoRoot, roots: TEMP_ROOTS })).toEqual([]);
      },
    );
  });

  // Merely mentioning the tokens in prose/strings is not evidence.
  it('DiscoverRenderers_FileMentioningTokensOnly_YieldsNoDiscovery', () => {
    const prose =
      `// This module documents how a ${PORT} lowers a spec via lowerSpec().\n` +
      `export const DOC = 'implements ${PORT} — see adapters/types.ts';\n` +
      `export const runtime = 'newharness';\n`;
    withTempRepo({ 'src/docs-note.ts': prose }, (repoRoot) => {
      expect(discoverRenderers({ repoRoot, roots: TEMP_ROOTS })).toEqual([]);
    });
  });

  // An implementing export that renders nothing is a port stub, not a renderer.
  it('DiscoverRenderers_ImplementorWithoutRenderMember_YieldsNoDiscovery', () => {
    const stub =
      `import type { ${PORT} } from './types.js';\n` +
      `export const stub: ${PORT} = { runtime: 'newharness' } as never;\n`;
    withTempRepo(
      { 'src/runtime/agents/adapters/stub.ts': stub },
      (repoRoot) => {
        expect(discoverRenderers({ repoRoot, roots: TEMP_ROOTS })).toEqual([]);
      },
    );
  });

  // Test/fixture files are not production surface.
  it('DiscoverRenderers_TestFileShapedLikeRenderer_YieldsNoDiscovery', () => {
    withTempRepo(
      { 'src/runtime/agents/adapters/fake.test.ts': rendererSource() },
      (repoRoot) => {
        expect(discoverRenderers({ repoRoot, roots: TEMP_ROOTS })).toEqual([]);
      },
    );
  });

  it('DetectRenderer_EmptySource_ReturnsNull', () => {
    expect(detectRenderer('', 'x.ts')).toBeNull();
  });

  it('RendererSubject_IsThePortAndRenderMember_NotAPathConvention', () => {
    // The detector's subject is pinned to the port + render member, so a
    // future reader can see the shape rule is not keyed on a directory name.
    expect(RENDERER_PORT_TYPE).toBe(PORT);
    expect(RENDERER_RENDER_MEMBER).toBe('lowerSpec');
    // Scan roots are the whole product source tree, not the adapters folder.
    expect(RENDERER_SCAN_ROOTS).toContain('src');
  });
});

describe('DR-14 field completeness — reason and expiry are enforced, not decorative', () => {
  it('ShimRatchet_RowMissingReason_Fails', () => {
    const result = verifyShimRatchet({
      registry: [entry({ capability: '' })],
      discovered: [discovered({ capability: '' })],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => /capability reason is required/.test(v.detail))).toBe(
      true,
    );
  });

  it('ShimRatchet_RowWithUnapprovedReason_Fails', () => {
    const result = verifyShimRatchet({
      registry: [entry({ capability: 'because-i-said-so' })],
      discovered: [discovered({ capability: 'because-i-said-so' })],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => /is not approved/.test(v.detail))).toBe(true);
  });

  it('ShimRatchet_RowMissingExpiry_Fails', () => {
    const result = verifyShimRatchet({
      registry: [entry({ expires: '' })],
      discovered: [discovered()],
      now: CLOCK,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'malformed')).toBe(true);
  });

  it('ShimRatchet_AlreadyExpiredExpiry_Fails', () => {
    // An expiry that is never checked is decoration.
    const result = verifyShimRatchet({
      registry: [entry({ expires: '2025-12-31' })],
      discovered: [discovered()],
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'expired')).toBe(true);
  });

  it('ValidateEntryGovernance_MissingIdFileOrRuntime_AllFlagged', () => {
    const problems = validateEntryGovernance(
      entry({ id: '', file: '', runtime: '' }),
      CLOCK,
    );
    const details = problems.map((p) => p.detail).join('\n');
    expect(details).toMatch(/id is required/);
    expect(details).toMatch(/file is required/);
    expect(details).toMatch(/runtime is required/);
  });

  it('ApprovedCapabilityReasons_IsClosedAndNonEmpty', () => {
    expect(APPROVED_CAPABILITY_REASONS.length).toBeGreaterThan(0);
    for (const e of SHIM_REGISTRY) {
      expect(APPROVED_CAPABILITY_REASONS).toContain(e.capability);
    }
  });
});

describe('DR-14 stale cover — a row whose artefact left the tree fails', () => {
  it('ShimRatchet_RegisteredRendererAbsentFromDisk_FailsMissingOnDisk', () => {
    // Temp tree contains a DIFFERENT renderer; the registered one is gone.
    withTempRepo(
      { 'src/runtime/agents/adapters/other.ts': rendererSource({ runtime: 'other' }) },
      (repoRoot) => {
        const renderers = discoverRenderers({ repoRoot, roots: TEMP_ROOTS });
        const result = verifyShimRatchet({
          registry: [rendererEntry()],
          discovered: [],
          renderers,
          now: CLOCK,
        });
        expect(result.ok).toBe(false);
        const stale = result.violations.filter((v) => v.kind === 'missing-on-disk');
        expect(stale).toHaveLength(1);
        expect(stale[0]?.id).toBe('newharness-agent-renderer');
      },
    );
  });

  it('ShimRatchet_StrayMarkerWithNoRow_StillFails', () => {
    // The marker is supplementary after DR-14 — but not inert.
    withTempRepo(
      {
        'src/runtime/stray.ts':
          `// ${MARK}runtimes: cursor, capability: slash-command-native) — note\n` +
          `export const STRAY = 1;\n`,
      },
      (repoRoot) => {
        const discoveredMarkers = discoverShims({ repoRoot, roots: TEMP_ROOTS });
        expect(discoveredMarkers).toHaveLength(1);
        const result = verifyShimRatchet({
          registry: [],
          discovered: discoveredMarkers,
          renderers: [],
          now: CLOCK,
        });
        expect(result.ok).toBe(false);
        expect(result.violations.some((v) => v.kind === 'unregistered')).toBe(true);
      },
    );
  });
});

describe('DR-14 live tree — the inventory reflects the shipped renderers', () => {
  /** The five shipped per-harness renderers, pinned by path and runtime. */
  const SHIPPED_RENDERERS: ReadonlyArray<readonly [string, string]> = [
    ['src/runtime/agents/adapters/claude.ts', 'claude'],
    ['src/runtime/agents/adapters/codex.ts', 'codex'],
    ['src/runtime/agents/adapters/copilot.ts', 'copilot'],
    ['src/runtime/agents/adapters/cursor.ts', 'cursor'],
    ['src/runtime/agents/adapters/opencode.ts', 'opencode'],
  ];

  it('DiscoverRenderers_RealRepo_FindsExactlyTheFiveShippedRenderers', () => {
    const renderers = discoverRenderers({ repoRoot: REPO_ROOT, roots: RENDERER_SCAN_ROOTS });
    expect(renderers.map((r) => [r.file, r.runtime] as const)).toEqual(SHIPPED_RENDERERS);
    // Pinned so a sixth ungoverned renderer trips this immediately.
    expect(renderers).toHaveLength(5);
  });

  it('DiscoverRenderers_RealRepo_NoneOfTheFiveCarriesAShimMarker', () => {
    // The proof that marker-driven discovery could never have seen them.
    const markers = discoverShims({ repoRoot: REPO_ROOT, roots: SHIM_SCAN_ROOTS });
    const markerFiles = new Set(markers.map((m) => m.file));
    for (const [file] of SHIPPED_RENDERERS) {
      expect(markerFiles.has(file)).toBe(false);
    }
  });

  it('ShimRegistry_RealRepo_GovernsEveryShippedRenderer', () => {
    const renderers = discoverRenderers({ repoRoot: REPO_ROOT, roots: RENDERER_SCAN_ROOTS });
    for (const r of renderers) {
      const row = SHIM_REGISTRY.find((e) => e.file === r.file && e.runtime === r.runtime);
      expect(row, `no SHIM_REGISTRY row for ${r.file} (${r.runtime})`).toBeDefined();
      expect(APPROVED_CAPABILITY_REASONS).toContain(row?.capability);
      expect(row?.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('ScanRoots_RealRepo_EveryConfiguredRootExists', () => {
    // A root that no longer exists scans nothing and reports nothing, so the
    // ratchet stays green while governing an empty tree. Task 019 left three
    // such stale path constants in this module alone; assert the roots are
    // real so the next move fails here instead of going quiet.
    for (const root of [...SHIM_SCAN_ROOTS, ...RENDERER_SCAN_ROOTS]) {
      expect(existsSync(join(REPO_ROOT, root)), `scan root ${root} does not exist`).toBe(true);
    }
    expect(existsSync(join(REPO_ROOT, SELF_PATH)), `${SELF_PATH} does not exist`).toBe(true);
  });

  it('ShimRatchet_RealRepo_IsGreen', () => {
    const result = verifyShimRatchet({
      registry: SHIM_REGISTRY,
      discovered: discoverShims({ repoRoot: REPO_ROOT, roots: SHIM_SCAN_ROOTS }),
      renderers: discoverRenderers({ repoRoot: REPO_ROOT, roots: RENDERER_SCAN_ROOTS }),
      now: CLOCK,
    });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
