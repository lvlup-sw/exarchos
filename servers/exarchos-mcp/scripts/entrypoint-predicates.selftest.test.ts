// DR-4 (task 074): the entrypoint predicate of every `scripts/` entrypoint in
// this package tests IDENTITY, not FILENAME — and that property is proved by
// EXECUTION, not by reading the source.
//
// ── The defect this file exists to detect ───────────────────────────────────
// A module that decides "am I the process entrypoint?" with
// `process.argv[1].endsWith('<its own name>')` couples WHETHER IT RUNS to WHAT
// IT IS CALLED. Task 018 measured the consequence on
// `output-schema-ratchet-guard.ts`: a byte-identical copy under any other name
// printed 0 bytes on stdout, 0 bytes on stderr, and exited 0. Renaming a guard
// and updating the `run:` step in ci.yml to match — the ordinary meaning of
// "rename a file" — leaves a CI step that exists, runs, resolves, and enforces
// nothing.
//
// Nothing in the repository could observe that. `guard-inventory` still reported
// the host as direct and unfiltered (the step is still there), and each guard's
// own unit suite calls `runGuard()` in-process, so it reads the return value of
// a function CI never reaches. Task 018 fixed the one instance it was standing
// on; this file covers the three that were left, and the companion detector in
// `scripts/guard-inventory.ts` closes the class rather than the instances.
//
// ── Why a SHADOW REPOSITORY ROOT rather than a rewritten copy ───────────────
// The acceptance criterion is that a BYTE-IDENTICAL copy under a different name
// still enforces, so the copy must not be edited — which rules out 018's
// rewrite-the-import-specifiers approach. Two of these three entrypoints also
// derive a repository root from their own `import.meta.url`
// (`cli-derivation-guard.ts` reads its allowlist and its governed sources that
// way), so a copy in a bare temp directory would abort on a missing allowlist
// instead of exercising the predicate.
//
// So each copy is written at the SAME DEPTH inside a shadow tree whose every
// other entry is a symlink to the real one. Byte-identical source, real
// dependencies, real data files, real repository root — only the FILENAME
// differs. That is the single variable this file manipulates.
//
// ── The kill fixture, per site ─────────────────────────────────────────────
// A rename probe on its own would be satisfied by an unconditional
// `if (true)`: a predicate that is always true also runs under any name. So
// each site additionally has the LEGACY predicate restored into a copy, and
// that copy must reproduce the exact silent-green signature — exit 0, nothing
// on stdout, nothing on stderr. The mutation is DERIVED from the site's own
// basename rather than transcribed, and {@link restoreLegacyPredicate} THROWS
// when the shipped predicate is absent, so a mutation that cannot be applied
// fails rather than silently producing an unmutated copy that passes.
//
// ── `bun`, measured rather than assumed ────────────────────────────────────
// `cli-vocab-guard.ts` runs under Bun (`npm run cli:vocab-guard` →
// `bun run scripts/cli-vocab-guard.ts`), because resolving `buildCli` pulls in
// `bun:sqlite`. DR-4 required Bun's `argv` / `import.meta.url` semantics to be
// checked empirically rather than argued from Node's. They are checked HERE, by
// running the real thing under the real runtime: the site's runner is part of
// its row in {@link SITES}, and every probe below runs under it.
//
// @oracle-sources: the exit status and stdout/stderr of separate OS processes running each shipped entrypoint — byte-identical, renamed, and legacy-predicate-mutated — under its own declared runtime
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `servers/exarchos-mcp` */
const MCP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(MCP_ROOT, '..', '..');

/** Where the shadow tree puts a copy, relative to its own root. */
const SCRIPTS_REL = ['servers', 'exarchos-mcp', 'scripts'] as const;

/**
 * The entrypoint predicate every site must carry, written as the exact source
 * text so a probe can substitute it out.
 *
 * Identical in all three sites on purpose: one spelling means the detector in
 * `scripts/guard-inventory.ts`, the mutation below, and a reviewer are all
 * looking at the same thing. `canonicalPath` additionally resolves symlinks,
 * because Node reports the main module's realpath while `argv[1]` keeps the
 * link — comparing the two unresolved would trade a filename-shaped silent
 * no-op for a symlink-shaped one.
 */
const SHIPPED_PREDICATE =
  'canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))';

/** How a site is invoked in production, and therefore how it is invoked here. */
type Runner = 'tsx' | 'bun';

interface Site {
  readonly id: string;
  /** Repo-relative path of the entrypoint under test. */
  readonly script: string;
  /** The runtime its production invocation uses — see the header on `bun`. */
  readonly runner: Runner;
  /** A substring the entrypoint's own output must carry, whatever its verdict. */
  readonly verdictMarker: string;
  /** How production reaches it, quoted in failure messages so a break is actionable. */
  readonly invokedBy: string;
}

/**
 * The three DR-4 sites, as DATA.
 *
 * Completeness of this list is NOT asserted here by reading it — that would be a
 * transcription guarding a transcription. It is asserted structurally by
 * `scripts/guard-inventory.ts`'s `filenameCoupledEntrypoints`, which derives the
 * population from the guard inventory and fails on any coupled entrypoint that
 * is neither fixed nor waived. This file owns EXECUTION; that one owns the
 * denominator.
 */
const SITES: readonly Site[] = Object.freeze([
  {
    id: 'cli-derivation-guard',
    script: 'servers/exarchos-mcp/scripts/cli-derivation-guard.ts',
    runner: 'tsx',
    verdictMarker: 'cli:derivation-guard —',
    invokedBy: 'ci.yml grep-gates: `npx --no-install tsx servers/exarchos-mcp/scripts/cli-derivation-guard.ts`',
  },
  {
    id: 'cli-vocab-guard',
    script: 'servers/exarchos-mcp/scripts/cli-vocab-guard.ts',
    runner: 'bun',
    verdictMarker: 'cli:vocab-guard —',
    invokedBy: 'ci.yml test-mcp: `npm run cli:vocab-guard` → `bun run scripts/cli-vocab-guard.ts`',
  },
  {
    id: 'generate-docs',
    script: 'servers/exarchos-mcp/scripts/generate-docs.ts',
    runner: 'tsx',
    verdictMarker: '# Exarchos MCP Tool Reference',
    invokedBy: 'servers/exarchos-mcp package.json: `generate:docs` → `tsx scripts/generate-docs.ts`',
  },
]);

// ─── Runners, resolved rather than assumed ──────────────────────────────────
//
// FAIL, never skip. A self-test that quietly skips because its runtime could not
// be found reports "0 failures" for exactly the reason this file exists to
// reject, so both resolvers THROW. Binding them is therefore itself an
// assertion: there is no arm on which this file spawns nothing and still passes.

function resolveTsxCli(): string {
  const candidates = [
    join(MCP_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
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
 * Bun, verified by RUNNING it rather than by finding a file.
 *
 * `cli-vocab-guard` has no Node arm — `buildCli` resolves `bun:sqlite` — so
 * "bun is missing" cannot degrade to "run it under tsx instead". Every CI lane
 * that runs this package's vitest project (`test-mcp`, `test-windows`) sets Bun
 * up explicitly, so an absent Bun here is a broken environment, not a supported
 * configuration.
 */
function resolveBun(): string {
  const candidate = process.env.EXARCHOS_BUN_BIN ?? 'bun';
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
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

/** Every child this file starts. The non-empty-denominator tooth reads it. */
let spawnCount = 0;

function runEntrypoint(site: Site, entry: string, cwd: string): ProcessRun {
  spawnCount += 1;
  const result =
    site.runner === 'bun'
      ? spawnSync(resolveBun(), ['run', entry], { encoding: 'utf8', cwd })
      : spawnSync(process.execPath, [resolveTsxCli(), entry], { encoding: 'utf8', cwd });
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
 * The CODE lines of a source file — comment lines dropped.
 *
 * Required, not decorative: each site's header now DOCUMENTS the legacy
 * predicate (that is where the finding is recorded), so a raw `not.toContain`
 * over the whole text would report the explanation as the defect. Task 018's
 * self-test hit exactly that on its first run.
 */
function codeOf(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

// ─── The shadow repository root ─────────────────────────────────────────────
//
// Every entry of the real tree, mirrored as a symlink, except the three
// directory levels leading to `servers/exarchos-mcp/scripts` — which are real
// directories so a copy can be written into the last one at the right DEPTH.
// A copy there sees the same repository root, the same `src/`, the same
// `node_modules` and the same data files as the original; only its name differs.

interface ShadowRoot {
  readonly root: string;
  readonly scriptsDir: string;
  /** Entries mirrored across all three levels — the copy mechanism's own denominator. */
  readonly mirrored: number;
}

function linkOrCopy(target: string, dest: string, isDirectory: boolean): void {
  try {
    symlinkSync(target, dest, isDirectory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
    return;
  } catch (err) {
    if (isDirectory) {
      // Copying a directory here could mean copying `node_modules`. Fail loudly
      // instead: an environment that cannot link directories cannot host this
      // probe, and pretending otherwise would trade a fast failure for a slow one.
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
 * Build a shadow root. `skipInScripts` names entries of the real `scripts/`
 * directory to leave out, so a probe can occupy a site's ORIGINAL basename.
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

// ─── The mutation (POLICY IS DATA, DERIVED FROM THE SITE) ───────────────────

/** The pre-074 predicate for a site, derived from its own basename. */
function legacyPredicateFor(site: Site): string {
  return `process.argv[1].endsWith('${basename(site.script)}')`;
}

/**
 * Restore the legacy filename-coupled predicate into `source`.
 *
 * THROWS when the shipped predicate is absent. That refusal is the point: a
 * mutation that silently produced an unmutated copy would make the kill fixture
 * below pass while proving nothing, which is the same shape of failure the
 * fixture exists to expose.
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

// ─── Fixture wiring ─────────────────────────────────────────────────────────

let scratchDir = '';
/** Copies under a NEW name: the real `scripts/` entries are all present. */
let renameShadow: ShadowRoot = { root: '', scriptsDir: '', mirrored: 0 };
/** Copies under a site's ORIGINAL name: those three entries are carved out. */
let originalNameShadow: ShadowRoot = { root: '', scriptsDir: '', mirrored: 0 };

const sourceOf = new Map<string, string>();
const liveRunOf = new Map<string, ProcessRun>();

/**
 * A copy name the legacy predicate cannot match, for `tag`.
 *
 * The suffix, not the prefix, is what carries the property — and the first
 * draft of this file got it wrong: `a-name-the-predicate-cannot-know-cli-vocab-guard.ts`
 * still satisfies `endsWith('cli-vocab-guard.ts')`, so the rename probe ran a
 * copy the legacy predicate DID match and its runtime arm passed for the wrong
 * reason. The name is therefore built with the site id in the MIDDLE, and
 * {@link runCopy} refuses any name that ends in the site's own basename.
 */
function distinctName(site: Site, tag: string): string {
  return `${tag}--${site.id}.probe.ts`;
}

/**
 * Write `body` into a shadow `scripts/` directory as `name`, and run it.
 *
 * `allowOriginalName` is the one deliberate exception: the kill fixture's
 * control arm runs the mutated source under the site's REAL basename. Every
 * other caller is asserted to have picked a name the legacy predicate cannot
 * match, because a probe that renames a file to something the predicate still
 * accepts measures nothing.
 */
function runCopy(
  site: Site,
  shadow: ShadowRoot,
  name: string,
  body: string,
  allowOriginalName = false,
): ProcessRun {
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

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'imo-074-entrypoints-'));
  renameShadow = buildShadowRoot(scratchDir, new Set());
  originalNameShadow = buildShadowRoot(scratchDir, new Set(SITES.map((s) => basename(s.script))));
  for (const site of SITES) {
    const abs = join(REPO_ROOT, site.script);
    sourceOf.set(site.id, readFileSync(abs, 'utf8'));
    liveRunOf.set(site.id, runEntrypoint(site, abs, MCP_ROOT));
  }
});

afterAll(() => {
  const spawned = spawnCount;
  if (scratchDir.length > 0) rmSync(scratchDir, { recursive: true, force: true });
  // NON-EMPTY DENOMINATOR, second half: a run of this file that started no child
  // process proved nothing about execution, however many green ticks it printed.
  const floor = SITES.length * 3;
  if (spawned < floor) {
    throw new Error(
      `entrypoint self-test spawned ${spawned} process(es), fewer than the ${floor} its ` +
        `${SITES.length} site(s) require — the probes did not run, so a clean result is vacuous`,
    );
  }
});

describe('DR-4 (074): entrypoint predicates test identity, not filename', () => {
  it('EntrypointSelfTest_ResolvesItsRunnersAndEverySubject_NonEmptyDenominator', () => {
    // NON-EMPTY DENOMINATOR, first half. Nothing below means anything if the
    // subject list is empty, a subject has moved, or a runner is missing — each
    // of which would otherwise read as "no failures".
    expect(SITES.length).toBeGreaterThan(0);
    expect(new Set(SITES.map((s) => s.id)).size).toBe(SITES.length);
    for (const site of SITES) {
      expect(existsSync(join(REPO_ROOT, site.script)), `${site.script} is missing`).toBe(true);
      expect(sourceOf.get(site.id)?.length ?? 0, `${site.script} is empty`).toBeGreaterThan(0);
    }
    // Both resolvers THROW rather than returning a sentinel, so binding them is
    // the assertion.
    expect(resolveTsxCli().endsWith('cli.mjs')).toBe(true);
    expect(resolveBun().length).toBeGreaterThan(0);
    // Both runtimes are genuinely exercised — a table that had drifted to
    // tsx-only would silently stop covering DR-4's Bun question.
    expect(new Set(SITES.map((s) => s.runner))).toEqual(new Set(['tsx', 'bun']));
    // The shadow tree resolved a real tree, not an empty one.
    expect(renameShadow.mirrored).toBeGreaterThan(0);
    expect(originalNameShadow.mirrored).toBeGreaterThan(0);
  });

  it('EntrypointSelfTest_BunSemanticsMatchNodes_MeasuredNotAssumed', () => {
    // DR-4 required the Bun case to be CHECKED rather than argued from Node's
    // behaviour, and `generate-agents.ts` records the opposite belief in a
    // comment ("tsx loaders rewrite the script URL in ways that vary by
    // version"). So the two values the idiom compares are printed by a REAL Bun
    // process, under all three shapes an invocation takes: an absolute path, a
    // relative path, and a path through a symlink.
    //
    // The symlink leg goes through a linked DIRECTORY rather than a linked file
    // because a directory junction is the one form Windows grants without
    // elevation — this arm therefore measures the same property on every host
    // instead of quietly not running on one of them.
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

    const bunSite: Site = { ...SITES[1]!, runner: 'bun' };
    expect(runEntrypoint(bunSite, join(probeDir, probeName), probeDir).stdout).toBe('true');
    expect(runEntrypoint(bunSite, probeName, probeDir).stdout).toBe('true');
    expect(runEntrypoint(bunSite, join(linkedDir, probeName), probeDir).stdout).toBe('true');
  });

  for (const site of SITES) {
    describe(site.id, () => {
      it(`${site.id}: ShippedEntrypoint_ProducesAVerdict`, () => {
        // (1) THE TAIL EXECUTED. Every existing assertion about these three
        // modules calls their exported function in-process; nothing had ever run
        // the entrypoint, so a module whose entrypoint never fires looked
        // identical to one that passes.
        const live = liveRunOf.get(site.id);
        expect(live, `${site.id} has no live run`).toBeDefined();
        expect(live?.code, `${site.id} never started (${site.invokedBy})`).not.toBeNull();
        const combined = `${live?.stdout ?? ''}${live?.stderr ?? ''}`;
        expect(combined.length, `${site.id} printed nothing — ${site.invokedBy}`).toBeGreaterThan(0);
        expect(combined).toContain(site.verdictMarker);
      });

      it(`${site.id}: SameSourceUnderADifferentName_StillEnforces`, () => {
        // THE RENAME TOOTH, and the reason this task was real. A rename is an
        // ordinary, reviewable edit: move the file, update the invocation. Under
        // the legacy predicate that combination left a step that existed, ran,
        // resolved, and enforced nothing.
        //
        // The copy is BYTE-IDENTICAL — asserted, not asserted-by-construction —
        // so the only variable between it and the live run is the filename.
        const source = sourceOf.get(site.id) ?? '';
        const name = distinctName(site, 'a-name-the-predicate-cannot-know');
        const renamed = runCopy(site, renameShadow, name, source);
        expect(readFileSync(join(renameShadow.scriptsDir, name), 'utf8')).toBe(source);

        const live = liveRunOf.get(site.id);
        expect(renamed.code).toBe(live?.code ?? null);
        expect(withoutDays(renamed.stdout)).toBe(withoutDays(live?.stdout ?? ''));
        expect(withoutDays(renamed.stderr)).toBe(withoutDays(live?.stderr ?? ''));
        expect(renamed.stdout.length + renamed.stderr.length).toBeGreaterThan(0);

        // …and the source really carries the resolved-path idiom rather than a
        // filename match. Read from the CODE lines so the header prose that
        // RECORDS the legacy predicate is not mistaken for a use of it.
        const code = codeOf(source);
        expect(code).toContain(SHIPPED_PREDICATE);
        expect(code).not.toContain(legacyPredicateFor(site));
      });

      it(`${site.id}: LegacyFilenamePredicate_GoesSilentlyGreen`, () => {
        // THE KILL FIXTURE. Without it the rename probe would be satisfied by an
        // unconditional `if (true)` — a predicate that is always true also runs
        // under any name — and would prove nothing about the predicate.
        //
        // Restoring the pre-074 predicate into a copy and running it under a
        // different name must produce the exact silent-green signature: exit 0,
        // nothing on stdout, nothing on stderr. That is entrypoint-execution
        // failure passing as success, reproduced on demand.
        const mutated = restoreLegacyPredicate(site, sourceOf.get(site.id) ?? '');
        const silent = runCopy(
          site,
          renameShadow,
          distinctName(site, 'a-name-the-legacy-predicate-cannot-match'),
          mutated,
        );
        expect(silent.code).toBe(0);
        expect(silent.stdout).toBe('');
        expect(silent.stderr).toBe('');

        // …and the mutation is FILENAME-COUPLED rather than simply broken: the
        // same mutated source under the ORIGINAL basename still runs and still
        // reports. Without this control the fixture would be indistinguishable
        // from "the edit broke the module", and would prove the wrong thing.
        const underOriginalName = runCopy(site, originalNameShadow, basename(site.script), mutated, true);
        const live = liveRunOf.get(site.id);
        expect(underOriginalName.stdout.length + underOriginalName.stderr.length).toBeGreaterThan(0);
        expect(withoutDays(underOriginalName.stdout)).toBe(withoutDays(live?.stdout ?? ''));
        expect(underOriginalName.code).toBe(live?.code ?? null);
      });

      it(`${site.id}: ImportedRatherThanInvoked_DoesNotSelfExecute`, () => {
        // The other half of the predicate's contract, and the anti-vacuity tooth
        // for both arms above: a module that ran on IMPORT would satisfy them and
        // would also fire inside its own test file, inside the census, and inside
        // anything else that reads its exports. So the negative case is pinned —
        // the module is imported, and control returns to the importer with no
        // verdict leaked.
        const marker = 'IMPORTED-WITHOUT-RUNNING';
        const name = distinctName(site, 'imports-without-running');
        const body = [
          `const mod: unknown = await import('${pathToFileURL(join(REPO_ROOT, site.script)).href}');`,
          "if (mod === null || typeof mod !== 'object') throw new Error('module did not load');",
          `process.stdout.write('${marker}');`,
          '',
        ].join('\n');
        const imported = runCopy(site, renameShadow, name, body);
        expect(imported.code).toBe(0);
        expect(imported.stdout).toBe(marker);
        expect(imported.stderr).toBe('');
        expect(imported.stdout).not.toContain(site.verdictMarker);
      });
    });
  }
});
