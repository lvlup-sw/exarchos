/**
 * Tests for the DR-2/DR-6 skills + deps INSTALL step (task 015) — the real
 * `installStep` hook the reconciler's `apply` routes `install` PlanSteps to on
 * the CLI surface.
 *
 * Two side effects are under test, driven through the REAL `installSkills`
 * seam (from the workspace-root `src/install-skills.ts`) so the local-copy
 * fast path / `npx skills add` fallback contract is exercised exactly as
 * production runs it — without ever shelling out to the network:
 *
 *   1. Skills-bundle install — reuses `installSkills`' local-copy fast path
 *      (copy `skills/<runtime>/` → the runtime's skills dir) when a
 *      `skillsSource` is resolvable, and falls back to the `npx skills add`
 *      shell-out (injected spawn) when it is not (#1355 contract).
 *   2. Project-deps install — the install command is resolved via the Bundle B
 *      layered resolver (`resolveTestRuntime(repoRoot).install`, single-sourced
 *      INV-6) and run through an INJECTED command runner (never a real spawn in
 *      the test).
 *
 * Surface gating (DR-6) is NOT this hook's job — the core `apply` install router
 * only invokes `ctx.installStep` when `ctx.surface === 'cli'` and downgrades to
 * an Advisory otherwise. The second test asserts that wiring end-to-end through
 * the real onboard pipeline (`defaultOnboardDeps` supplies the real step).
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../events/store.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ApplyCtx } from '../../dispatch/core/onboarding/reconcile.js';
import type { PlanStep } from '../../dispatch/core/onboarding/types.js';
import type { CheckResult } from '../doctor/schema.js';
import { buildWriterDeps } from '../init/probes.js';
import type { WriterDeps } from '../init/probes.js';

import {
  handleOnboard,
  type HandleOnboardArgs,
  type OnboardDeps,
  defaultOnboardDeps,
} from './index.js';
import { makeInstallStep, type InstallStepDeps } from './install.js';
import {
  onboardMigrate,
  hashInstalledSkillDir,
  hashInstalledSkillMd,
  RENAMED_AWAY_SKILL_DIRS,
  type ProvenanceManifest,
  type RuntimeSkillsTarget,
} from './install.js';
// Test-only reach into the root install-skills provenance source of truth (this
// test file is excluded from the server tsc `rootDir`, so the cross-package
// import is legal here — the same lever `command-shim-emitter.test.ts` uses). The
// migration MIRRORS these two hashers; the drift-guard test below pins parity.
import {
  hashSkillDirContent,
  hashSkillMdContent,
} from '../../../../../src/install-skills.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface Fixture {
  readonly repoRoot: string;
  readonly home: string;
  readonly stateDir: string;
  readonly base: string;
  readonly ctx: DispatchContext;
  readonly eventStore: EventStore;
}

/** A temp Node repo (so the resolver derives an install command) + isolated
 * home (the skills target) + isolated EventStore state dir. */
async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'onboard-install-'));
  const repoRoot = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const stateDir = path.join(base, 'state');
  await mkdir(repoRoot, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify(
      { name: 'fixture', version: '0.0.0', scripts: { 'test:run': 'vitest run' } },
      null,
      2,
    ),
    'utf8',
  );
  // package-lock.json → the vendored package-manager-detector resolves `npm`,
  // so `resolveTestRuntime(repoRoot).install` is `npm ci`.
  await writeFile(path.join(repoRoot, 'package-lock.json'), '{}\n', 'utf8');
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false, cwd: repoRoot };
  return { repoRoot, home, stateDir, base, ctx, eventStore };
}

async function cleanup(fx: Fixture): Promise<void> {
  await rmrfAsync(fx.base).catch(
    () => {},
  );
}

/** WriterDeps redirected at the fixture (real fs; cwd=repo, home=fixture home). */
function fixtureWriterDeps(fx: Fixture): WriterDeps {
  const real = buildWriterDeps();
  return { ...real, cwd: () => fx.repoRoot, home: () => fx.home };
}

/** Build a minimal `install` PlanStep (the kind the reconciler routes here). */
function installPlanStep(): PlanStep {
  return {
    kind: 'install',
    surface: 'cli-only',
    key: 'plugin-skill-hash-sync',
    description: 'reinstall the skills bundle',
  };
}

/** Build an ApplyCtx pointed at the fixture (cli surface — the gated path). */
function applyCtx(fx: Fixture, surface: ApplyCtx['surface'] = 'cli'): ApplyCtx {
  return {
    repoRoot: fx.repoRoot,
    surface,
    force: false,
    writerDeps: fixtureWriterDeps(fx),
    writers: [],
  };
}

/**
 * Seed a fake per-runtime skills source tree at `<base>/skills/claude/<skill>/`
 * so the local-copy fast path has something to copy. Returns the parent
 * `skills/` dir (the `skillsSource`).
 */
async function seedSkillsSource(fx: Fixture): Promise<string> {
  const skillsRoot = path.join(fx.base, 'skills');
  const runtimeDir = path.join(skillsRoot, 'claude', 'ideate');
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(path.join(runtimeDir, 'SKILL.md'), '# ideate\n', 'utf8');
  return skillsRoot;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('installStep (DR-2/DR-6 — skills + deps install)', () => {
  it('Install_LocalCopyFastPath_ThenNpxFallback', async () => {
    const fx = await createFixture();
    try {
      const skillsSource = await seedSkillsSource(fx);

      // Spies for the reused `installSkills` seam: a recording copyDir (the
      // local-copy fast path) and a recording spawn (the npx fallback). We
      // never shell out to a real `npx` — both are injected fakes.
      const copyDir = vi.fn((_src: string, _dest: string) => {});
      const spawn = vi.fn(async () => ({ code: 0, stderr: '' }));
      // Injected command runner for the project-deps install — records the
      // resolved install command + cwd instead of executing it.
      const runCommand = vi.fn(async (_cmd: string, _cwd: string) => {});

      const deps: InstallStepDeps = {
        // Target claude explicitly so `installSkills` skips runtime detection
        // (auto-detect needs a full RuntimeMap `detection` block we don't fake).
        agent: 'claude',
        // Force the FAST PATH: a resolvable skills source → copyDir runs,
        // spawn (npx) does NOT.
        resolveSkillsSource: () => skillsSource,
        // Single claude runtime so the copy targets a deterministic dir.
        runtimes: [
          {
            name: 'claude',
            skillsInstallPath: path.join(fx.home, '.claude', 'skills'),
          } as never,
        ],
        homeDir: () => fx.home,
        copyDir,
        spawn,
        runCommand,
        // Don't write ~/.claude.json during the test.
        registerMcp: () => {},
        log: () => {},
        errLog: () => {},
      };

      const step = installPlanStep();
      const ctx = applyCtx(fx);
      const installStep = makeInstallStep(deps);

      // ── Fast path: skills copied locally, npx NOT invoked ──
      await installStep(step, ctx);

      // Local-copy fast path ran (the reused `installSkills` seam).
      expect(copyDir).toHaveBeenCalled();
      // The `npx skills add` fallback was NOT taken (source was resolvable).
      expect(spawn).not.toHaveBeenCalled();

      // Project deps installed via the Bundle-B-resolved command (`npm ci`),
      // run in the repo root (not a real spawn).
      expect(runCommand).toHaveBeenCalledTimes(1);
      const [installCmd, installCwd] = runCommand.mock.calls[0];
      expect(installCmd).toContain('npm');
      expect(installCwd).toBe(fx.repoRoot);

      // ── Fallback: no resolvable source → npx shell-out (injected spawn) ──
      const spawn2 = vi.fn(async () => ({ code: 0, stderr: '' }));
      const copyDir2 = vi.fn((_src: string, _dest: string) => {});
      const fallbackStep = makeInstallStep({
        ...deps,
        resolveSkillsSource: () => undefined, // no local tree → npx fallback
        spawn: spawn2,
        copyDir: copyDir2,
      });
      await fallbackStep(step, ctx);

      // The npx fallback shelled out; the local copy did not run.
      expect(spawn2).toHaveBeenCalled();
      const [npxCmd, npxArgs] = spawn2.mock.calls[0];
      expect(npxCmd).toBe('npx');
      expect((npxArgs as string[]).join(' ')).toContain('skills');
      expect(copyDir2).not.toHaveBeenCalled();
    } finally {
      await cleanup(fx);
    }
  });

  it('Install_DoesNotRegisterMcp_SingleRegistrationInGenerate', async () => {
    // DR-5 (task 018): MCP registration is written by EXACTLY ONE code path —
    // the reconciler's GENERATE step (the init writers, e.g. ClaudeCodeWriter →
    // ~/.claude.json + the mcp-json-writer → .vscode/.cursor mcp.json). The
    // install step (which reuses `installSkills`, whose DEFAULT `registerMcp` is
    // `registerExarchosInClaudeJson`) must NOT also register MCP, or claude
    // repos would double-register. The PRODUCTION `installStep` therefore threads
    // a NO-OP `registerMcp` into the skills-install seam.
    //
    // We capture the opts the default `installStep` forwards to the skills-install
    // seam (the bridge passthrough) WITHOUT injecting our own `registerMcp` — so
    // we observe production's own choice. A `registerMcp` MUST be present and MUST
    // be a no-op (calling it writes nothing).
    const fx = await createFixture();
    try {
      const skillsSource = await seedSkillsSource(fx);

      let capturedRegisterMcp: ((home: string) => void) | undefined;
      const runSkillsInstall = vi.fn(async (opts: { registerMcp?: (home: string) => void }) => {
        capturedRegisterMcp = opts.registerMcp;
      });

      // PRODUCTION deps: no `registerMcp` injected — we assert the default the
      // step itself supplies. `runSkillsInstall` is captured so we never reach
      // the real bridge; `runCommand` is stubbed so deps-install is a no-op.
      const deps: InstallStepDeps = {
        agent: 'claude',
        resolveSkillsSource: () => skillsSource,
        runtimes: [
          { name: 'claude', skillsInstallPath: path.join(fx.home, '.claude', 'skills') } as never,
        ],
        homeDir: () => fx.home,
        runSkillsInstall,
        runCommand: vi.fn(async () => {}),
      };

      const step = installPlanStep();
      const ctx = applyCtx(fx);
      const installStep = makeInstallStep(deps);
      await installStep(step, ctx);

      // The skills-install seam was reached and a `registerMcp` was threaded.
      expect(runSkillsInstall).toHaveBeenCalledTimes(1);
      expect(typeof capturedRegisterMcp).toBe('function');

      // It is a NO-OP: calling it writes NO `~/.claude.json` (single-registration
      // is owned by GENERATE, not the install step).
      const claudeJson = path.join(fx.home, '.claude.json');
      capturedRegisterMcp!(fx.home);
      const homeEntries = await readdir(fx.home).catch(() => [] as string[]);
      expect(homeEntries).not.toContain('.claude.json');
      // Belt-and-braces: the file genuinely does not exist.
      await expect(readFile(claudeJson, 'utf8')).rejects.toThrow();
    } finally {
      await cleanup(fx);
    }
  });

  it('Install_WiredIntoDefaultOnboardDeps_CliSurface', async () => {
    const fx = await createFixture();
    try {
      // `defaultOnboardDeps` must supply a REAL installStep (no longer the
      // no-op). We drive the pipeline with a deterministic `install`-only plan:
      // one cli-only install Fail before apply, green after (VERIFY converges).
      const INSTALL_FAIL: CheckResult = {
        category: 'plugin',
        name: 'plugin-skill-hash-sync',
        status: 'Fail',
        message: 'skills bundle out of sync',
        fix: 'reinstall the skills bundle',
        durationMs: 0,
      };
      const GREEN: CheckResult = {
        category: 'plugin',
        name: 'plugin-skill-hash-sync',
        status: 'Pass',
        message: 'skills bundle in sync',
        durationMs: 0,
      };

      // `defaultOnboardDeps` wires the real installStep; assert it is present.
      const prodDeps = defaultOnboardDeps(fx.ctx, {});
      expect(typeof prodDeps.installStep).toBe('function');

      // Spy on the real installStep so we don't actually shell out, but still
      // verify the pipeline routes to it on `surface:'cli'`.
      const installSpy = vi.fn().mockResolvedValue(undefined);

      let phase = 0;
      const runDoctorChecks = async (): Promise<readonly CheckResult[]> => {
        phase += 1;
        return phase === 1 ? [INSTALL_FAIL] : [GREEN];
      };

      const baseDeps: OnboardDeps = {
        ...prodDeps,
        repoRoot: fx.repoRoot,
        writerDeps: fixtureWriterDeps(fx),
        writers: [],
        runDoctorChecks,
        seed: vi.fn(() => ({ wrote: true, path: path.join(fx.repoRoot, '.exarchos.yml') })),
        detectOptions: { detectRuntimes: async () => [], vcs: 'git' },
      };

      // ── CLI surface: the install step RUNS ──
      const cliDeps: OnboardDeps = { ...baseDeps, installStep: installSpy };
      const cliArgs: HandleOnboardArgs = { surface: 'cli', format: 'json' };
      const cliResult = await handleOnboard(cliArgs, fx.ctx, cliDeps);

      expect(cliResult.success).toBe(true);
      expect(installSpy).toHaveBeenCalled();
      const cliData = cliResult.data as {
        result: { applied: { key: string }[]; advisories: { surface: string }[] };
        verify: { residualBlocking: number };
      };
      expect(cliData.result.applied.map((s) => s.key)).toContain('plugin-skill-hash-sync');
      expect(cliData.verify.residualBlocking).toBe(0);

      // ── Non-cli surface: the core DOWNGRADES to an advisory (step NOT run) ──
      let phase2 = 0;
      const runDoctorChecks2 = async (): Promise<readonly CheckResult[]> => {
        phase2 += 1;
        return phase2 === 1 ? [INSTALL_FAIL] : [INSTALL_FAIL];
      };
      const installSpy2 = vi.fn().mockResolvedValue(undefined);
      const mcpDeps: OnboardDeps = {
        ...baseDeps,
        runDoctorChecks: runDoctorChecks2,
        installStep: installSpy2,
      };
      // The MCP adapter stamps the non-cli `'any'` surface (MCP_ONBOARD_SURFACE)
      // — use that real value, not a phantom `'mcp'` cast. The core downgrades a
      // cli-only install step to an advisory on ANY non-`'cli'` surface (INV-2:
      // the surface type contract is honoured, no `as never` escape hatch).
      const mcpArgs: HandleOnboardArgs = { surface: 'any', format: 'json' };
      const mcpResult = await handleOnboard(mcpArgs, fx.ctx, mcpDeps);

      // Off-CLI the install hook is NEVER invoked — the core downgrades it.
      expect(installSpy2).not.toHaveBeenCalled();
      const mcpData = mcpResult.data as {
        result: { applied: { key: string }[]; advisories: { surface: string; commands?: string[] }[] };
      };
      // The install step is surfaced as a cli-only advisory, not applied.
      expect(mcpData.result.applied.map((s) => s.key)).not.toContain('plugin-skill-hash-sync');
      const advisorySurfaces = mcpData.result.advisories.map((a) => a.surface);
      expect(advisorySurfaces).toContain('cli-only');
    } finally {
      await cleanup(fx);
    }
  });
});

// ─── Onboard rename migration (Task 011, DR-3/DR-8) ───────────────────────────

describe('onboardMigrate (DR-3/DR-8 — stale old-name skill dir reconcile)', () => {
  interface MigrateFixture {
    readonly base: string;
    readonly home: string;
    readonly projectRoot: string;
    /** A per-harness native skills dir the migration scans. */
    readonly loc: string;
    readonly runtimes: readonly RuntimeSkillsTarget[];
  }

  function makeMigrateFixture(): MigrateFixture {
    const base = nodeFs.mkdtempSync(path.join(tmpdir(), 'onboard-migrate-'));
    const home = path.join(base, 'home');
    const projectRoot = path.join(base, 'project');
    const loc = path.join(base, 'claude-skills');
    nodeFs.mkdirSync(home, { recursive: true });
    nodeFs.mkdirSync(projectRoot, { recursive: true });
    nodeFs.mkdirSync(loc, { recursive: true });
    return {
      base,
      home,
      projectRoot,
      loc,
      runtimes: [{ name: 'claude', skillsInstallPath: loc }],
    };
  }

  /** Place a skill dir `<parent>/<name>/SKILL.md` with `content`; returns its path. */
  function placeSkillDir(parent: string, name: string, content: string): string {
    const dir = path.join(parent, name);
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
    return dir;
  }

  it('onboardMigrate_ManifestProvenance_Removed', () => {
    const fx = makeMigrateFixture();
    try {
      const content = '# brainstorming\n\nOrient the ideation workflow.\n';
      const staleDir = placeSkillDir(fx.loc, 'brainstorming', content);
      // Task 010 install-manifest provenance: the recorded whole-dir hash matches.
      const manifest: ProvenanceManifest = {
        placements: [
          { path: fx.loc, hashes: { brainstorming: hashSkillDirContent(staleDir) } },
        ],
      };

      const result = onboardMigrate({
        runtimes: fx.runtimes,
        homeDir: () => fx.home,
        projectRoot: fx.projectRoot,
        installManifests: [manifest],
      });

      expect(result.removed.map((r) => r.path)).toContain(staleDir);
      expect(result.removed.find((r) => r.path === staleDir)?.via).toBe('install-manifest');
      expect(result.preserved).toEqual([]);
      // The stale dir is gone from disk.
      expect(nodeFs.existsSync(staleDir)).toBe(false);
    } finally {
      nodeFs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it('onboardMigrate_LegacyHashMatchAnyRelease_Removed', () => {
    const fx = makeMigrateFixture();
    try {
      const content = '# delegation\n\nDelegate to sub-agents.\n';
      const staleDir = placeSkillDir(fx.loc, 'delegation', content);
      // Task 023 legacy provenance: the SKILL.md hash matches SOME historical
      // release's render (modeled here as a set with the matching hash + a decoy).
      const legacy = new Map<string, Set<string>>([
        ['delegation', new Set([hashSkillMdContent(content), 'a-different-release-hash'])],
      ]);

      const result = onboardMigrate({
        runtimes: fx.runtimes,
        homeDir: () => fx.home,
        projectRoot: fx.projectRoot,
        legacyHashesBySkill: legacy,
      });

      expect(result.removed.map((r) => r.path)).toContain(staleDir);
      expect(result.removed.find((r) => r.path === staleDir)?.via).toBe('legacy-hash');
      expect(nodeFs.existsSync(staleDir)).toBe(false);
    } finally {
      nodeFs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it('onboardMigrate_CrlfInstalledCopy_StillMatches', () => {
    const fx = makeMigrateFixture();
    try {
      const lf = '# synthesis\n\nSynthesize the workflow outputs.\n';
      // The legacy hash is computed over the LF (git-checkout) render, but the
      // installed copy on disk has CRLF line endings — newline normalization must
      // make them hash-match anyway.
      const legacyHash = hashSkillMdContent(lf);
      const staleDir = placeSkillDir(fx.loc, 'synthesis', lf.replace(/\n/g, '\r\n'));
      const legacy = new Map<string, Set<string>>([['synthesis', new Set([legacyHash])]]);

      const result = onboardMigrate({
        runtimes: fx.runtimes,
        homeDir: () => fx.home,
        projectRoot: fx.projectRoot,
        legacyHashesBySkill: legacy,
      });

      expect(result.removed.map((r) => r.path)).toContain(staleDir);
      expect(result.removed.find((r) => r.path === staleDir)?.via).toBe('legacy-hash');
      expect(nodeFs.existsSync(staleDir)).toBe(false);
    } finally {
      nodeFs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it('onboardMigrate_SymlinkedInstall_RemovesLinkOnly', () => {
    const fx = makeMigrateFixture();
    try {
      const content = '# discovery\n\nDiscover prior workflows.\n';
      // The symlink TARGET lives OUTSIDE the scanned location.
      const targetParent = path.join(fx.base, 'shared-target');
      const targetDir = placeSkillDir(targetParent, 'discovery', content);
      // The install location holds a SYMLINK to the shared target.
      const link = path.join(fx.loc, 'discovery');
      nodeFs.symlinkSync(targetDir, link);

      const legacy = new Map<string, Set<string>>([
        ['discovery', new Set([hashSkillMdContent(content)])],
      ]);

      const result = onboardMigrate({
        runtimes: fx.runtimes,
        homeDir: () => fx.home,
        projectRoot: fx.projectRoot,
        legacyHashesBySkill: legacy,
      });

      const removed = result.removed.find((r) => r.path === link);
      expect(removed).toBeDefined();
      expect(removed?.symlink).toBe(true);
      // The LINK is gone…
      expect(nodeFs.existsSync(link)).toBe(false);
      // …but the symlink TARGET (never followed for removal) survives intact.
      expect(nodeFs.existsSync(path.join(targetDir, 'SKILL.md'))).toBe(true);
    } finally {
      nodeFs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it('onboardMigrate_UserModifiedDir_PreservedWithWarning', () => {
    const fx = makeMigrateFixture();
    try {
      // A stale old-name dir whose content matches NEITHER manifest (user-edited
      // or from an unknown source) — the migration must never delete it.
      const staleDir = placeSkillDir(
        fx.loc,
        'oneshot-workflow',
        '# oneshot-workflow\n\nHand-edited by the user.\n',
      );
      const warn = vi.fn();

      const result = onboardMigrate({
        runtimes: fx.runtimes,
        homeDir: () => fx.home,
        projectRoot: fx.projectRoot,
        installManifests: [{ placements: [] }],
        legacyHashesBySkill: new Map(),
        warn,
      });

      expect(result.removed).toEqual([]);
      expect(result.preserved.map((p) => p.path)).toContain(staleDir);
      expect(result.preserved[0]?.reason).toBe('no-provenance-match');
      // Preserved on disk, warned once, and surfaced for the doctor finding.
      expect(nodeFs.existsSync(path.join(staleDir, 'SKILL.md'))).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(staleDir);
    } finally {
      nodeFs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it('onboardMigrate_RepeatedRuns_Idempotent', () => {
    const fx = makeMigrateFixture();
    try {
      const matchedContent = '# prune-workflows\n\nPrune stale workflows.\n';
      const matchedDir = placeSkillDir(fx.loc, 'prune-workflows', matchedContent);
      const modifiedDir = placeSkillDir(
        fx.loc,
        'authoring-invariants',
        '# authoring-invariants\n\nHand-edited.\n',
      );
      const legacy = new Map<string, Set<string>>([
        ['prune-workflows', new Set([hashSkillMdContent(matchedContent)])],
      ]);
      const run = (): ReturnType<typeof onboardMigrate> =>
        onboardMigrate({
          runtimes: fx.runtimes,
          homeDir: () => fx.home,
          projectRoot: fx.projectRoot,
          legacyHashesBySkill: legacy,
        });

      // ── First run: matched dir removed, modified dir preserved. ──
      const first = run();
      expect(first.removed.map((r) => r.path)).toEqual([matchedDir]);
      expect(first.preserved.map((p) => p.path)).toEqual([modifiedDir]);
      expect(nodeFs.existsSync(matchedDir)).toBe(false);
      expect(nodeFs.existsSync(modifiedDir)).toBe(true);
      const modifiedBytes = nodeFs.readFileSync(path.join(modifiedDir, 'SKILL.md'));

      // ── Second run: byte-stable no-op — nothing new removed, dir untouched. ──
      const second = run();
      expect(second.removed).toEqual([]); // idempotent: the matched dir is already gone
      expect(second.preserved.map((p) => p.path)).toEqual([modifiedDir]);
      expect(nodeFs.existsSync(matchedDir)).toBe(false);
      expect(nodeFs.readFileSync(path.join(modifiedDir, 'SKILL.md'))).toEqual(modifiedBytes);
    } finally {
      nodeFs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it('onboardMigrate_NewAndLiveSkillNames_NeverTargeted', () => {
    // The migration can only ever act on RENAMED-AWAY names. A LIVE (renamed-to)
    // skill dir sharing the location must never be removed or flagged, even with a
    // vouching manifest — the stale set is closed over the 9 old names only.
    const fx = makeMigrateFixture();
    try {
      const liveDir = placeSkillDir(fx.loc, 'ideate', '# ideate\n');
      expect(RENAMED_AWAY_SKILL_DIRS).not.toContain('ideate');
      const manifest: ProvenanceManifest = {
        placements: [{ path: fx.loc, hashes: { ideate: hashSkillDirContent(liveDir) } }],
      };

      const result = onboardMigrate({
        runtimes: fx.runtimes,
        homeDir: () => fx.home,
        projectRoot: fx.projectRoot,
        installManifests: [manifest],
      });

      expect(result.removed).toEqual([]);
      expect(result.preserved).toEqual([]);
      expect(nodeFs.existsSync(liveDir)).toBe(true);
    } finally {
      nodeFs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it('migrationHashers_MirrorInstallSkillsSourceOfTruth', () => {
    // Drift guard: the server-package hashers MIRROR the root install-skills
    // provenance source of truth (they cannot import it under the MCP server's
    // tsc rootDir). Pin byte-for-byte parity so a future edit to either cannot
    // silently break provenance matching.
    const base = nodeFs.mkdtempSync(path.join(tmpdir(), 'migrate-hashguard-'));
    try {
      const dir = path.join(base, 'delegation');
      nodeFs.mkdirSync(path.join(dir, 'references'), { recursive: true });
      nodeFs.writeFileSync(path.join(dir, 'SKILL.md'), '# delegation\r\nline\r\n', 'utf8');
      nodeFs.writeFileSync(path.join(dir, 'references', 'r.md'), 'ref\nbody\n', 'utf8');

      expect(hashInstalledSkillDir(dir)).toBe(hashSkillDirContent(dir));
      expect(hashInstalledSkillMd(dir)).toBe(hashSkillMdContent('# delegation\r\nline\r\n'));
    } finally {
      nodeFs.rmSync(base, { recursive: true, force: true });
    }
  });
});
