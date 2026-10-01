// Proves by execution that each entrypoint predicate tests identity, not filename.
// A guard that compares `process.argv[1]` with its own filename does not run under
// another name. A renamed copy then exits 0 with no output, and its CI step enforces nothing.
//
// The rename probe writes a byte-identical copy at the same depth in a shadow
// repository root. Every other entry of that root mirrors the real tree, so only the
// filename differs. A kill fixture restores the legacy predicate into a copy and
// expects the silent exit. Each site runs under its production runtime, so the Bun
// site measures Bun semantics directly.
//
// @oracle-sources: the exit status and stdout/stderr of separate OS processes running each shipped entrypoint — byte-identical, renamed, and legacy-predicate-mutated — under its own declared runtime
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rmrf } from '../../test-helpers/temp-dir.js';

import { spawnAsync } from '../../test-helpers/spawn.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

/** Where the shadow tree puts a copy, relative to its own root. */
const SCRIPTS_REL = ['tools', 'audit', 'core'] as const;

/**
 * The entrypoint predicate that each site must carry, as exact source text so that a probe can replace it.
 * The sites share one spelling, so the guard-inventory detector, the mutation and a reviewer read the same text.
 * `canonicalPath` resolves symlinks, because Node reports the realpath of the main module while `argv[1]` keeps the link.
 */
const SHIPPED_PREDICATE =
  'canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))';

/** How a site is invoked in production, and therefore how it is invoked here. */
type Runner = 'tsx' | 'bun';

interface Site {
  readonly id: string;
  /** Repo-relative path of the entrypoint under test. */
  readonly script: string;
  /** The runtime that the production invocation uses. */
  readonly runner: Runner;
  /** A substring the entrypoint's own output must carry, whatever its verdict. */
  readonly verdictMarker: string;
  /** How production reaches it, quoted in failure messages so a break is actionable. */
  readonly invokedBy: string;
}

/**
 * The entrypoint sites under test.
 * This file does not check that the list is complete. `filenameCoupledEntrypoints` in `tools/audit/gates/guard-inventory/` derives that population from the guard inventory.
 * It fails on a coupled entrypoint that is neither fixed nor waived.
 */
const SITES: readonly Site[] = Object.freeze([
  {
    id: 'cli-derivation-guard',
    script: 'tools/audit/core/cli-derivation-guard.ts',
    runner: 'tsx',
    verdictMarker: 'cli:derivation-guard —',
    invokedBy: 'ci.yml grep-gates: `npx --no-install tsx tools/audit/core/cli-derivation-guard.ts`',
  },
  {
    id: 'cli-vocab-guard',
    script: 'tools/audit/core/cli-vocab-guard.ts',
    runner: 'bun',
    verdictMarker: 'cli:vocab-guard —',
    invokedBy: 'ci.yml: `npm run cli:vocab-guard` → `bun run tools/audit/core/cli-vocab-guard.ts`',
  },
  {
    id: 'generate-docs',
    script: 'tools/audit/core/generate-docs.ts',
    runner: 'tsx',
    verdictMarker: '# Exarchos MCP Tool Reference',
    invokedBy: 'package.json: `generate:docs` → `tsx tools/audit/core/generate-docs.ts`',
  },
]);

/**
 * Returns the path of the tsx CLI, or throws.
 * Both runner resolvers throw and do not skip, because a skipped self-test reports zero failures for the defect that this file detects.
 */
function resolveTsxCli(): string {
  const candidates = [
    join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(
    `tsx CLI not found. Looked in:\n  ${candidates.join('\n  ')}\n` +
      'This self-test drives DR-4\'s entrypoints as real processes; without a runner it must ' +
      'FAIL rather than skip, because a skipped entrypoint self-test is the failure mode it ' +
      'exists to detect.',
  );
}

/**
 * Returns a Bun command that runs `--version` with exit 0, or throws.
 * `cli-vocab-guard` runs only under Bun, because `buildCli` resolves `bun:sqlite`. A missing Bun is a broken environment.
 */
async function resolveBun(): Promise<string> {
  const candidate = process.env.EXARCHOS_BUN_BIN ?? 'bun';
  const probe = await spawnAsync(candidate, ['--version']);
  if (probe.error !== undefined || probe.status !== 0) {
    throw new Error(
      `bun is not runnable as "${candidate}" (${probe.error?.message ?? `exit ${String(probe.status)}`}). ` +
        '`cli-vocab-guard` runs ONLY under Bun, so this self-test must FAIL rather than skip its ' +
        'Bun site. Set EXARCHOS_BUN_BIN if bun is installed somewhere off PATH.',
    );
  }
  return candidate;
}

interface ProcessRun {
  /** `null` only when the child never started — asserted against, never ignored. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function textOf(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The count of child processes that this file starts.
 * `afterAll` fails the run when the count is less than three for each site, because a run without child processes proves nothing.
 */
let spawnCount = 0;

async function runEntrypoint(site: Site, entry: string, cwd: string): Promise<ProcessRun> {
  spawnCount += 1;
  const result =
    site.runner === 'bun'
      ? await spawnAsync(await resolveBun(), ['run', entry], { cwd })
      : await spawnAsync(process.execPath, [resolveTsxCli(), entry], { cwd });
  if (result.error !== undefined) {
    throw new Error(`spawning ${entry} under ${site.runner} failed: ${result.error.message}`);
  }
  return { code: result.status, stdout: textOf(result.stdout), stderr: textOf(result.stderr) };
}

/** Blank out ISO days so two runs straddling UTC midnight still compare equal. */
function withoutDays(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}/g, '<day>');
}

/**
 * Returns the code lines of a source file, without comment lines.
 * A site header can quote the legacy predicate, so a `not.toContain` check over the whole text reports the quote as the defect.
 */
function codeOf(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

/**
 * A shadow repository root. `buildShadowRoot` mirrors each entry of the real tree, except the three directory levels that lead to `tools/audit/core`.
 * These levels are real directories, so a copy in the last one has the same depth as the original.
 */
interface ShadowRoot {
  readonly root: string;
  readonly scriptsDir: string;
  /** Entries mirrored across all three levels — the copy mechanism's own denominator. */
  readonly mirrored: number;
}

/**
 * Links `target` at `dest`, and copies a file when the link fails.
 * A directory that cannot be linked throws, because a copy of a directory can include `node_modules`.
 */
function linkOrCopy(target: string, dest: string, isDirectory: boolean): void {
  try {
    symlinkSync(target, dest, isDirectory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
    return;
  } catch (err) {
    if (isDirectory) {
      throw new Error(
        `cannot mirror directory ${target} into the shadow tree ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
    copyFileSync(target, dest);
  }
}

/** Mirror every entry of `realDir` into `shadowDir`, skipping `carveOut`. Returns the count. */
function mirrorLevel(realDir: string, shadowDir: string, carveOut: string | null): number {
  mkdirSync(shadowDir, { recursive: true });
  let mirrored = 0;
  for (const entry of readdirSync(realDir, { withFileTypes: true })) {
    if (entry.name === carveOut) continue;
    linkOrCopy(join(realDir, entry.name), join(shadowDir, entry.name), entry.isDirectory());
    mirrored += 1;
  }
  return mirrored;
}

/**
 * Builds a shadow root. `skipInScripts` names entries of the real `tools/audit/core`
 * directory to leave out, so that a probe can use the original basename of a site.
 */
function buildShadowRoot(parent: string, skipInScripts: ReadonlySet<string>): ShadowRoot {
  const root = mkdtempSync(join(parent, 'shadow-'));
  let mirrored = 0;
  let realDir = REPO_ROOT;
  let shadowDir = root;
  for (const segment of SCRIPTS_REL) {
    mirrored += mirrorLevel(realDir, shadowDir, segment);
    realDir = join(realDir, segment);
    shadowDir = join(shadowDir, segment);
  }
  mkdirSync(shadowDir, { recursive: true });
  for (const entry of readdirSync(realDir, { withFileTypes: true })) {
    if (skipInScripts.has(entry.name)) continue;
    linkOrCopy(join(realDir, entry.name), join(shadowDir, entry.name), entry.isDirectory());
    mirrored += 1;
  }
  return { root, scriptsDir: shadowDir, mirrored };
}

/** The legacy filename-coupled predicate for a site, derived from its own basename. */
function legacyPredicateFor(site: Site): string {
  return `process.argv[1].endsWith('${basename(site.script)}')`;
}

/**
 * Restores the legacy filename-coupled predicate into `source`.
 * Throws when the shipped predicate is absent, because an unmutated copy makes the kill fixture pass and prove nothing.
 */
function restoreLegacyPredicate(site: Site, source: string): string {
  if (!source.includes(SHIPPED_PREDICATE)) {
    throw new Error(
      `${site.script} does not contain the shipped entrypoint predicate\n  ${SHIPPED_PREDICATE}\n` +
        'so the legacy-predicate mutation cannot be applied. This FAILS rather than producing an ' +
        'unmutated copy that would pass — either the site never adopted the resolved-path idiom ' +
        '(DR-4), or it re-spelled it and this probe must be re-aimed.',
    );
  }
  return source.split(SHIPPED_PREDICATE).join(legacyPredicateFor(site));
}

let scratchDir = '';
/** Copies under a NEW name: the real `scripts/` entries are all present. */
let renameShadow: ShadowRoot = { root: '', scriptsDir: '', mirrored: 0 };
/** Copies under a site's ORIGINAL name: those three entries are carved out. */
let originalNameShadow: ShadowRoot = { root: '', scriptsDir: '', mirrored: 0 };

const sourceOf = new Map<string, string>();
const liveRunOf = new Map<string, ProcessRun>();

/**
 * Returns a copy name for `tag` that the legacy predicate cannot match.
 * The site id sits in the middle of the name, because the legacy predicate tests the suffix.
 * {@link runCopy} refuses a name that ends in the site basename.
 */
function distinctName(site: Site, tag: string): string {
  return `${tag}--${site.id}.probe.ts`;
}

/**
 * Writes `body` as `name` into `shadow.scriptsDir` and runs it.
 * Only the control arm of the kill fixture sets `allowOriginalName`, to run the mutated source under the real basename.
 * Each other name must not end in the site basename, because the legacy predicate matches such a name.
 */
async function runCopy(
  site: Site,
  shadow: ShadowRoot,
  name: string,
  body: string,
  allowOriginalName = false,
): Promise<ProcessRun> {
  if (!allowOriginalName && name.endsWith(basename(site.script))) {
    throw new Error(
      `copy name "${name}" still ends with "${basename(site.script)}", so the legacy ` +
        'filename predicate would match it. This probe would pass without testing anything.',
    );
  }
  const entry = join(shadow.scriptsDir, name);
  writeFileSync(entry, body, 'utf8');
  return runEntrypoint(site, entry, join(shadow.root, 'servers', 'exarchos-mcp'));
}

beforeAll(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), 'imo-074-entrypoints-'));
  renameShadow = buildShadowRoot(scratchDir, new Set());
  originalNameShadow = buildShadowRoot(scratchDir, new Set(SITES.map((s) => basename(s.script))));
  for (const site of SITES) {
    const abs = join(REPO_ROOT, site.script);
    sourceOf.set(site.id, readFileSync(abs, 'utf8'));
    liveRunOf.set(site.id, await runEntrypoint(site, abs, REPO_ROOT));
  }
});

afterAll(() => {
  const spawned = spawnCount;
  if (scratchDir.length > 0) rmrf(scratchDir);
  const floor = SITES.length * 3;
  if (spawned < floor) {
    throw new Error(
      `entrypoint self-test spawned ${spawned} process(es), fewer than the ${floor} its ` +
        `${SITES.length} site(s) require — the probes did not run, so a clean result is vacuous`,
    );
  }
});

describe('DR-4 (074): entrypoint predicates test identity, not filename', () => {
  /**
   * Fails when the site list is empty, a site file is missing, a runner is missing, or a shadow tree is empty.
   * Each of these conditions otherwise reads as zero failures. The sites must use both runners, so that the Bun arm stays covered.
   */
  it('EntrypointSelfTest_ResolvesItsRunnersAndEverySubject_NonEmptyDenominator', async () => {
    expect(SITES.length).toBeGreaterThan(0);
    expect(new Set(SITES.map((s) => s.id)).size).toBe(SITES.length);
    for (const site of SITES) {
      expect(existsSync(join(REPO_ROOT, site.script)), `${site.script} is missing`).toBe(true);
      expect(sourceOf.get(site.id)?.length ?? 0, `${site.script} is empty`).toBeGreaterThan(0);
    }
    expect(resolveTsxCli().endsWith('cli.mjs')).toBe(true);
    expect((await resolveBun()).length).toBeGreaterThan(0);
    expect(new Set(SITES.map((s) => s.runner))).toEqual(new Set(['tsx', 'bun']));
    expect(renameShadow.mirrored).toBeGreaterThan(0);
    expect(originalNameShadow.mirrored).toBeGreaterThan(0);
  });

  /**
   * Runs the predicate idiom in a real Bun process with an absolute path, a relative path, and a path through a linked directory.
   * The link is a directory because Windows grants a directory junction without elevation.
   * The test selects the Bun site by runner, not by array position, so a reordered table cannot move this arm to tsx.
   */
  it('EntrypointSelfTest_BunSemanticsMatchNodes_MeasuredNotAssumed', async () => {
    const probeDir = mkdtempSync(join(scratchDir, 'bun-probe-'));
    const probeName = 'a-bun-argv-probe.ts';
    writeFileSync(
      join(probeDir, probeName),
      [
        "import { fileURLToPath } from 'node:url';",
        "import { realpathSync } from 'node:fs';",
        "import { resolve } from 'node:path';",
        'const canonicalPath = (candidate: string): string => {',
        '  const absolute = resolve(candidate);',
        '  try { return realpathSync(absolute); } catch { return absolute; }',
        '};',
        'process.stdout.write(',
        "  String(canonicalPath(process.argv[1] ?? '') === canonicalPath(fileURLToPath(import.meta.url))),",
        ');',
        '',
      ].join('\n'),
      'utf8',
    );
    const linkedDir = join(scratchDir, 'a-link-to-the-bun-probe-dir');
    linkOrCopy(probeDir, linkedDir, true);

    const bunTemplate = SITES.find((s) => s.runner === 'bun');
    expect(bunTemplate, 'no site in SITES runs under bun — this probe measures nothing').toBeDefined();
    const bunSite: Site = { ...bunTemplate!, runner: 'bun' };
    expect((await runEntrypoint(bunSite, join(probeDir, probeName), probeDir)).stdout).toBe('true');
    expect((await runEntrypoint(bunSite, probeName, probeDir)).stdout).toBe('true');
    expect((await runEntrypoint(bunSite, join(linkedDir, probeName), probeDir)).stdout).toBe('true');
  });

  for (const site of SITES) {
    describe(site.id, () => {
      /**
       * Expects the live entrypoint process to print output that carries the verdict marker.
       * In-process unit tests of the exported function do not run the entrypoint.
       */
      it(`${site.id}: ShippedEntrypoint_ProducesAVerdict`, () => {
        const live = liveRunOf.get(site.id);
        expect(live, `${site.id} has no live run`).toBeDefined();
        expect(live?.code, `${site.id} never started (${site.invokedBy})`).not.toBeNull();
        const combined = `${live?.stdout ?? ''}${live?.stderr ?? ''}`;
        expect(combined.length, `${site.id} printed nothing — ${site.invokedBy}`).toBeGreaterThan(0);
        expect(combined).toContain(site.verdictMarker);
      });

      /**
       * Runs a byte-identical copy under a new name and expects the exit code and output of the live run.
       * Under the legacy predicate, a renamed guard exits 0 with no output.
       * The test also expects the shipped predicate in the code lines of the source, so header prose does not count.
       */
      it(`${site.id}: SameSourceUnderADifferentName_StillEnforces`, async () => {
        const source = sourceOf.get(site.id) ?? '';
        const name = distinctName(site, 'a-name-the-predicate-cannot-know');
        const renamed = await runCopy(site, renameShadow, name, source);
        expect(readFileSync(join(renameShadow.scriptsDir, name), 'utf8')).toBe(source);

        const live = liveRunOf.get(site.id);
        expect(renamed.code).toBe(live?.code ?? null);
        expect(withoutDays(renamed.stdout)).toBe(withoutDays(live?.stdout ?? ''));
        expect(withoutDays(renamed.stderr)).toBe(withoutDays(live?.stderr ?? ''));
        expect(renamed.stdout.length + renamed.stderr.length).toBeGreaterThan(0);

        const code = codeOf(source);
        expect(code).toContain(SHIPPED_PREDICATE);
        expect(code).not.toContain(legacyPredicateFor(site));
      });

      /**
       * Restores the legacy predicate into a copy, runs it under a new name, and expects exit 0 with no output.
       * Without this kill fixture, an unconditional `if (true)` passes the rename probe.
       * A control arm runs the same mutated source under the original basename and expects the live output.
       * This control proves that the mutation is filename-coupled and does not break the module.
       */
      it(`${site.id}: LegacyFilenamePredicate_GoesSilentlyGreen`, async () => {
        const mutated = restoreLegacyPredicate(site, sourceOf.get(site.id) ?? '');
        const silent = await runCopy(
          site,
          renameShadow,
          distinctName(site, 'a-name-the-legacy-predicate-cannot-match'),
          mutated,
        );
        expect(silent.code).toBe(0);
        expect(silent.stdout).toBe('');
        expect(silent.stderr).toBe('');

        const underOriginalName = await runCopy(site, originalNameShadow, basename(site.script), mutated, true);
        const live = liveRunOf.get(site.id);
        expect(underOriginalName.stdout.length + underOriginalName.stderr.length).toBeGreaterThan(0);
        expect(withoutDays(underOriginalName.stdout)).toBe(withoutDays(live?.stdout ?? ''));
        expect(underOriginalName.code).toBe(live?.code ?? null);
      });

      /**
       * Imports the module from another script and expects only the marker of the importer on stdout.
       * A module that runs on import also runs inside each file that imports it, such as its own tests.
       */
      it(`${site.id}: ImportedRatherThanInvoked_DoesNotSelfExecute`, async () => {
        const marker = 'IMPORTED-WITHOUT-RUNNING';
        const name = distinctName(site, 'imports-without-running');
        const body = [
          `const mod: unknown = await import('${pathToFileURL(join(REPO_ROOT, site.script)).href}');`,
          "if (mod === null || typeof mod !== 'object') throw new Error('module did not load');",
          `process.stdout.write('${marker}');`,
          '',
        ].join('\n');
        const imported = await runCopy(site, renameShadow, name, body);
        expect(imported.code).toBe(0);
        expect(imported.stdout).toBe(marker);
        expect(imported.stderr).toBe('');
        expect(imported.stdout).not.toContain(site.verdictMarker);
      });
    });
  }
});
