import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
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
} from '../../../src/install/shim-registry.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** A fixed clock that is earlier than each expiry in the real registry. */
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

/** The marker token, spliced so that a tree scan finds no shim marker in this test file. */
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
  it('ShimRatchet_MatchingRegistryAndDiscovery_Passes', () => {
    const result = verifyShimRatchet({
      registry: [entry()],
      discovered: [discovered()],
      now: CLOCK,
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

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

  /** The violation names only the runtime that has no registry row. */
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

  /** The scan skips `SELF_PATH`, although the file content holds a marker. */
  it('discoverShims_ExcludesSelfModule', () => {
    const fs: ShimDiscoveryFs = {
      listTsFiles: () => [`/repo/${SELF_PATH}`],
      readFile: () => `// ${MARK}runtimes: cursor, capability: x)`,
    };
    const found = discoverShims({ repoRoot: '/repo', roots: ['src'], fs });
    expect(found).toEqual([]);
  });

  /** `src/runtime` contains `src/runtime/agents/adapters`. A scan of both roots must report the marker one time. */
  it('discoverShims_NestedRoots_VisitsEachFileOnce', () => {
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
      expect(validateEntryGovernance(e, CLOCK)).toEqual([]);
    }
  });

  /**
   * This test checks only the path prefix.
   * When a registered file is absent, `RealShimSet_MatchesRegistry_RatchetPasses` fails.
   */
  it('registry files exist on disk', () => {
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

/** The port type name, spliced so that a tree scan does not detect this test file as a renderer. */
const PORT = 'Runtime' + 'Adapter';

interface RendererFixtureOptions {
  /** The runtime id that the module declares. With `null`, the module declares none. */
  readonly runtime?: string | null;
  /** The fields of a shim marker to add. The default is no marker. */
  readonly withMarker?: string;
  /** Local alias for the imported port type. */
  readonly alias?: string;
  /** Emit the `implements` (class) form instead of the annotated-const form. */
  readonly asClass?: boolean;
  /** Emit the `satisfies` form (no type annotation) instead. */
  readonly asSatisfies?: boolean;
}

/** The source text of a per-harness renderer, reduced to the structural facts that the detector reads. */
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

/** Runs `body` against a temp tree shaped like the repository. `seed` maps repo-relative paths to file contents. */
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
    rmrf(root);
  }
}

/** The scan roots for the temp trees, the same as `RENDERER_SCAN_ROOTS`. */
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
  /** The renderer has no registry row. The test seeds it into a real directory tree and runs the real discovery and ratchet. */
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

  /** The renderer has a registry row, but the reason and the expiry of the row are blank. */
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

  /** A renderer without a runtime id has no (file, runtime) key, so the ratchet reports it and does not skip it. */
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

  /** Without the `renderers` input, a renderer row has no artefact, so the row is a `missing-on-disk` violation. */
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
  /** The renderer holds no marker, so the marker scan does not find it. Structural discovery needs no marker. */
  it('DiscoverRenderers_RendererWithNoShimMarker_IsStillDiscovered', () => {
    const source = rendererSource();
    expect(source).not.toContain(MARK);
    withTempRepo({ [RENDERER_PATH]: source }, (repoRoot) => {
      expect(discoverShims({ repoRoot, roots: TEMP_ROOTS })).toEqual([]);
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

  /** A `satisfies` export without a type annotation is also an implementing position, so discovery must find it. */
  it('DiscoverRenderers_SatisfiesForm_IsDiscovered', () => {
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
  /** The port module declares the interface and names the render member, but it does not import the port. */
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

  /**
   * The consumer imports the port and calls the render member.
   * It names the port only inside other types, never in an implementing position.
   */
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

  /** The tokens occur only in a comment and in strings. */
  it('DiscoverRenderers_FileMentioningTokensOnly_YieldsNoDiscovery', () => {
    const prose =
      `// This module documents how a ${PORT} lowers a spec via lowerSpec().\n` +
      `export const DOC = 'implements ${PORT} — see adapters/types.ts';\n` +
      `export const runtime = 'newharness';\n`;
    withTempRepo({ 'src/docs-note.ts': prose }, (repoRoot) => {
      expect(discoverRenderers({ repoRoot, roots: TEMP_ROOTS })).toEqual([]);
    });
  });

  /** An implementing export without the render member is a port stub. */
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

  /** Discovery skips test files. */
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

  /** The detector keys on the port type and the render member, and it scans the whole `src` tree, not one directory. */
  it('RendererSubject_IsThePortAndRenderMember_NotAPathConvention', () => {
    expect(RENDERER_PORT_TYPE).toBe(PORT);
    expect(RENDERER_RENDER_MEMBER).toBe('lowerSpec');
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
  /** The temp tree holds a different renderer, and the registered renderer is absent. */
  it('ShimRatchet_RegisteredRendererAbsentFromDisk_FailsMissingOnDisk', () => {
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

  /** Renderer discovery needs no marker, but a marker without a registry row is still a violation. */
  it('ShimRatchet_StrayMarkerWithNoRow_StillFails', () => {
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

/** `SHIPPED_RENDERERS` pins the five shipped per-harness renderers by path and runtime. */
describe('DR-14 live tree — the inventory reflects the shipped renderers', () => {
  const SHIPPED_RENDERERS: ReadonlyArray<readonly [string, string]> = [
    ['src/runtime/agents/adapters/claude.ts', 'claude'],
    ['src/runtime/agents/adapters/codex.ts', 'codex'],
    ['src/runtime/agents/adapters/copilot.ts', 'copilot'],
    ['src/runtime/agents/adapters/cursor.ts', 'cursor'],
    ['src/runtime/agents/adapters/opencode.ts', 'opencode'],
  ];

  /** The list is exact, so a sixth renderer fails this test. */
  it('DiscoverRenderers_RealRepo_FindsExactlyTheFiveShippedRenderers', () => {
    const renderers = discoverRenderers({ repoRoot: REPO_ROOT, roots: RENDERER_SCAN_ROOTS });
    expect(renderers.map((r) => [r.file, r.runtime] as const)).toEqual(SHIPPED_RENDERERS);
    expect(renderers).toHaveLength(5);
  });

  /** No shipped renderer file holds a marker, so the marker scan finds none of them. */
  it('DiscoverRenderers_RealRepo_NoneOfTheFiveCarriesAShimMarker', () => {
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

  /**
   * A scan root that does not exist gives no files, so the scan cannot report an ungoverned shim or renderer below it.
   * This test fails on a stale root or a stale `SELF_PATH`.
   */
  it('ScanRoots_RealRepo_EveryConfiguredRootExists', () => {
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
